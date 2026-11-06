//! SSH 遠端資料夾：用 SFTP 直接編輯 Linux 主機上的檔案。
//!
//! - 前端用 `ssh://<連線代號>/路徑` 表示遠端檔案；開檔、存檔、檔案樹、Ctrl+P、衝突處理、
//!   外部修改偵測都和 WebDAV 共用 `dav/mod.rs`，這裡只負責連線與檔案操作（`RemoteFs`）。
//! - 登入順序：輸入的密碼 → ssh-agent（Windows 的 OpenSSH 驗證代理或 Pageant）→
//!   `~/.ssh` 裡的金鑰（id_ed25519、id_ecdsa、id_rsa）。指定金鑰檔時先用那把金鑰，
//!   密碼欄當作金鑰的密語。都不行而且沒有輸入密碼時回傳 `NEED_PASSWORD`，前端再詢問。
//!   金鑰檔只接受本機磁碟上的絕對路徑（網路路徑會讓 Windows 連到別台電腦、送出登入資訊）。
//! - 主機金鑰記在 `~/.ssh/known_hosts`（和 ssh 指令共用）。第一次連線時由原生端用系統的對話框
//!   顯示演算法與指紋，請使用者確認（網頁不能代為決定）；確認後只記這台主機的這個連接埠。
//!   和記錄的不同時一律拒絕連線。主機名稱只接受一般的網域名稱與 IP 位址：known_hosts 的
//!   萬用字元、逗號之類都不行（例如記成 `*` 會讓這台電腦上所有的 ssh 都信任那把金鑰）。
//! - SFTP 沒有 ETag：用「修改時間-大小」判斷檔案在開啟後有沒有被改過。
//! - 連線斷掉（電腦睡眠、換網路）時，下一個操作會自動重新連線。
//! - 跳板主機（ProxyJump）：先連到跳板主機，再從那裡開一條通道連到目標主機（兩台的主機金鑰都會檢查，
//!   第一次連線時分開確認）。跳板主機用金鑰或 ssh-agent 登入，絕不送出目標主機的密碼；
//!   需要密碼時回傳 `NEED_JUMP_PASSWORD`，前端另外詢問跳板主機的密碼。

use parking_lot::Mutex;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use russh::client;
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::fs::Metadata;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{OpenFlags, StatusCode};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::io::AsyncWriteExt;

use crate::dav::{Conn, Dav, DavError, FsFuture, Item, RemoteFs};
use crate::workspace::FolderInfo;

pub const SCHEME: &str = "ssh://";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// 單一操作的時間上限。要比前端等待原生端的 20 秒短：前端放棄時，背景的操作也已經停了，
/// 使用者按「重試存檔」不會和還在寫的上一次重疊。
const OP_TIMEOUT: Duration = Duration::from_secs(15);
/// 讀取的檔案大小上限（和 WebDAV 相同）。
const MAX_READ: u64 = 64 * 1024 * 1024;
/// 刪除資料夾時最多處理的項目數。
const MAX_DELETE: usize = 10_000;
/// ssh-agent 裡最多試幾把金鑰（伺服器預設只允許試 6 次）。
const MAX_AGENT_KEYS: usize = 3;
/// 主機名稱的長度上限（和 DNS 相同）。
const MAX_HOST: usize = 253;
/// 金鑰檔的大小上限：私鑰只有幾 KB，不去讀很大的檔案。
const MAX_KEY_FILE: u64 = 64 * 1024;

/// SSH 連線的設定（存在 `webdav.json` 的連線清單裡，密碼另外存）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshTarget {
    pub host: String,
    pub port: u16,
    /// 遠端資料夾的絕對路徑（第一次連線時把 `~`、相對路徑解析成絕對路徑）。
    pub root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    /// 跳板主機（ProxyJump）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump: Option<JumpHost>,
}

/// 跳板主機：先連到這裡，再從這裡連到目標主機。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JumpHost {
    pub host: String,
    pub port: u16,
    pub user: String,
}

impl JumpHost {
    /// 給 ssh 指令 `-J` 用的寫法（`帳號@主機:連接埠`，IPv6 加中括號），也是給人看的名稱。
    fn spec(&self) -> String {
        format!("{}@{}", self.user, host_port(&self.host, self.port))
    }
}

/// 給人看的「主機:連接埠」（IPv6 加中括號）。
fn host_port(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// 登入用的密碼。
#[derive(Clone, Default)]
pub(crate) struct Secrets {
    /// 目標主機的密碼（指定金鑰檔時也當作金鑰的密語）。
    pub(crate) password: Option<String>,
    /// 跳板主機的密碼：跳板主機要密碼時，使用者另外輸入的。
    pub(crate) jump_password: Option<String>,
}

// ---- 主機名稱與金鑰檔 -------------------------------------------------------

/// 主機名稱只能是一般的網域名稱（英數字、`-`、`.`）、IPv4 或 IPv6 位址（可以加 `%介面`）。
/// 主機名稱會寫進 `~/.ssh/known_hosts`：`*`、`?`、`!`、`,`、`[`、`]`、`|`、`#` 在那裡有特殊意義
/// （記成 `*` 會讓這台電腦上所有的 ssh 都信任那把金鑰），一律不接受；
/// 也不能以 `-` 開頭（交給終端機的 ssh 指令時會被當成選項）。
fn valid_host(host: &str) -> bool {
    if host.is_empty() || host.len() > MAX_HOST {
        return false;
    }
    if host.contains(':') {
        let (addr, zone) = match host.split_once('%') {
            Some((addr, zone)) => (addr, Some(zone)),
            None => (host, None),
        };
        return addr.parse::<std::net::Ipv6Addr>().is_ok()
            && zone.is_none_or(|z| {
                !z.is_empty()
                    && z.chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            });
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            // `_` 不是正式主機名稱的字元，但內部網路很常見（`files_01`），OpenSSH 也接受；
            // 它不是 known_hosts 的萬用字元，可以放行。
            && label.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    })
}

/// `s` 是不是本機磁碟上的絕對路徑。只看字串（在 Linux 上也能測 Windows 的寫法）：
/// Windows 只接受 `C:\…`、`C:/…` 與 `\\?\C:\…`；網路路徑（`\\主機\分享`、`//主機/分享`、`\/`、`/\`、
/// `\\?\UNC\…`）、裝置路徑（`\\.\…`、`\\?\GLOBALROOT\…`）、沒有磁碟機代號的路徑一律拒絕。
fn local_absolute(s: &str, windows: bool) -> bool {
    let b = s.as_bytes();
    let sep = |c: u8| c == b'\\' || c == b'/';
    if b.len() >= 2 && sep(b[0]) && sep(b[1]) {
        // 兩個斜線開頭：只有本機磁碟的長路徑寫法可以。
        return windows
            && b.len() >= 7
            && b.starts_with(b"\\\\?\\")
            && b[4].is_ascii_alphabetic()
            && b[5] == b':'
            && b[6] == b'\\';
    }
    if windows {
        b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && sep(b[2])
    } else {
        b.first() == Some(&b'/')
    }
}

/// Windows 再用系統的路徑解析確認一次：開頭是磁碟機代號（不是 UNC 或裝置路徑）。
#[cfg(windows)]
fn on_local_disk(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    path.is_absolute()
        && matches!(
            path.components().next(),
            Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
        )
}

#[cfg(not(windows))]
fn on_local_disk(path: &Path) -> bool {
    path.is_absolute()
}

/// 金鑰檔的路徑：`~/` 換成家目錄後，必須是本機磁碟上的絕對路徑。
/// 網路路徑會讓 Windows 自動連到那台電腦並送出登入資訊，一律拒絕。
fn local_key_path(input: &str) -> Result<PathBuf, String> {
    let path = expand_home(input.trim());
    if path
        .to_str()
        .is_some_and(|s| local_absolute(s, cfg!(windows)))
        && on_local_disk(&path)
    {
        Ok(path)
    } else {
        Err(tr!(
            "金鑰檔要是這台電腦上的完整路徑（例如 ~/.ssh/id_ed25519），不能是網路路徑"
        ))
    }
}

// ---- 主機金鑰 ---------------------------------------------------------------

#[derive(Clone, Debug)]
enum HostKey {
    Trusted,
    /// 沒看過的主機（出示的金鑰）。
    Unknown(PublicKey),
    /// 和 known_hosts 記錄的不同。
    Changed,
    /// 主機憑證（目前不支援）。
    Certificate,
    /// known_hosts 存在卻讀不了：不能當成第一次連線（金鑰換了也看不出來）。
    Unreadable,
}

/// `~/.ssh/known_hosts`（和 ssh 指令共用）。
fn known_hosts_path() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".ssh").join("known_hosts"))
}

/// known_hosts 裡這台主機（這個連接埠）的金鑰。檔案不存在時是空的（第一次用 ssh）；
/// 存在卻打不開、讀到一半出錯時回傳錯誤，不要當成沒有記錄。
fn recorded_keys(path: &Path, host: &str, port: u16) -> Result<Vec<PublicKey>, ()> {
    if path.exists() && std::fs::File::open(path).is_err() {
        return Err(());
    }
    russh::keys::known_hosts::known_host_keys_path(host, port, path)
        .map(|keys| keys.into_iter().map(|(_, k)| k).collect())
        .map_err(|_| ())
}

/// 把使用者確認過的主機金鑰記進 known_hosts：只記這台主機的這個連接埠
/// （`主機` 或 `[主機]:連接埠`）。主機名稱再檢查一次，萬用字元、逗號之類的不會寫進去。
fn learn(path: &Path, host: &str, port: u16, key: &PublicKey) -> Result<(), ()> {
    if !valid_host(host) {
        return Err(());
    }
    russh::keys::known_hosts::learn_known_hosts_path(host, port, key, path).map_err(|_| ())
}

/// 已經確認過的主機金鑰：(主機, 連接埠, 金鑰)。
type Approved = Vec<(String, u16, PublicKey)>;

struct Checker {
    /// 小寫的主機名稱（和 ssh 指令一樣不分大小寫）。
    host: String,
    port: u16,
    known_hosts: Option<PathBuf>,
    /// 使用者剛才在系統的對話框確認過的金鑰（第一次連線時）。
    approved: Option<PublicKey>,
    seen: Arc<Mutex<Option<HostKey>>>,
}

fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

/// 判斷主機金鑰。known_hosts 已經有這台主機的記錄、卻沒有一把相符時一律拒絕——
/// 連演算法不同的情況也算（攔截連線的人可能改出示另一種金鑰，假裝成第一次連線）。
/// 沒有記錄時，只信任使用者在系統對話框確認過的那一把。
fn judge(recorded: &[PublicKey], key: &PublicKey, approved: Option<&PublicKey>) -> HostKey {
    if recorded.iter().any(|k| k.key_data() == key.key_data()) {
        HostKey::Trusted
    } else if !recorded.is_empty() {
        HostKey::Changed
    } else if approved.is_some_and(|a| a.key_data() == key.key_data()) {
        HostKey::Trusted
    } else {
        HostKey::Unknown(key.clone())
    }
}

impl client::Handler for Checker {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let state = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => {
                let recorded = match &self.known_hosts {
                    Some(path) => recorded_keys(path, &self.host, self.port),
                    None => Err(()),
                };
                let Ok(recorded) = recorded else {
                    *self.seen.lock() = Some(HostKey::Unreadable);
                    return Ok(false);
                };
                let state = judge(&recorded, key, self.approved.as_ref());
                if matches!(state, HostKey::Trusted) && recorded.is_empty() {
                    // 使用者剛確認過：記進 known_hosts（寫不進去也讓這次連線）。
                    if let Some(path) = &self.known_hosts {
                        let _ = learn(path, &self.host, self.port, key);
                    }
                }
                state
            }
            PublicKeyOrCertificate::Certificate(_) => HostKey::Certificate,
        };
        let ok = matches!(state, HostKey::Trusted);
        *self.seen.lock() = Some(state);
        Ok(ok)
    }
}

/// 主機金鑰檢查的是哪一段連線。
#[derive(Clone, Debug)]
enum Hop {
    /// 直接連到目標主機。
    Direct,
    /// 跳板主機。
    Jump,
    /// 經由跳板主機（名稱）連到目標主機。
    Via(String),
}

/// 第一次連線、要請使用者確認主機金鑰的主機。
#[derive(Clone, Debug)]
struct NewHost {
    host: String,
    port: u16,
    key: PublicKey,
    hop: Hop,
}

impl NewHost {
    fn name(&self) -> String {
        host_port(&self.host, self.port)
    }
}

/// 連線失敗：第一次連線的主機要先問使用者；其他是一般的錯誤。
enum Fail {
    NewHost(Box<NewHost>),
    Error(DavError),
}

impl From<DavError> for Fail {
    fn from(e: DavError) -> Self {
        Fail::Error(e)
    }
}

impl Fail {
    /// 不能問使用者的時候（背景自動重新連線）：當成錯誤。
    fn into_error(self) -> DavError {
        match self {
            Fail::Error(e) => e,
            Fail::NewHost(h) => DavError::Other(tr!(
                "還沒有確認 {host} 的主機金鑰，請重新連線",
                host = h.name()
            )),
        }
    }
}

/// 主機金鑰和 known_hosts 記錄的不同。
fn changed(host: &str) -> DavError {
    DavError::Other(tr!(
        "{host} 的主機金鑰和上次連線時不同：可能是伺服器重新安裝過，也可能有人在攔截連線。確定沒問題的話，請在終端機執行 ssh-keygen -R {host} 刪掉舊的記錄，再重新連線。",
        host = host
    ))
}

/// 用系統的對話框請使用者確認第一次連線的主機（網頁沒辦法代按），同時只問一個。
async fn ask_trust(window: &tauri::Window, h: NewHost) -> bool {
    static ASKING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = ASKING.lock().await;
    let host = h.name();
    let intro = match &h.hop {
        Hop::Direct => tr!("第一次連線到 {host}，無法確認這台主機的身分。", host = host),
        Hop::Jump => tr!(
            "第一次連線到跳板主機 {host}，無法確認這台主機的身分。",
            host = host
        ),
        Hop::Via(jump) => tr!(
            "第一次連線到 {host}（經由跳板主機 {jump}），無法確認這台主機的身分。",
            host = host,
            jump = jump
        ),
    };
    let details = tr!(
        "演算法：{algo}\n指紋：{fp}\n\n請核對這個指紋和伺服器上的一致（在伺服器上執行 ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 可以看到）。信任之後會記在 ~/.ssh/known_hosts，下次不再詢問。要信任這台主機並連線嗎？",
        algo = h.key.algorithm().as_str(),
        fp = fingerprint(&h.key)
    );
    let answer = rfd::AsyncMessageDialog::new()
        .set_parent(window)
        .set_level(rfd::MessageLevel::Warning)
        .set_title(tr!("第一次連線到 {host}", host = host))
        .set_description(format!("{intro}\n\n{details}"))
        .set_buttons(rfd::MessageButtons::YesNo)
        .show()
        .await;
    answer == rfd::MessageDialogResult::Yes
}

// ---- 連線與登入 ---------------------------------------------------------------

struct Live {
    handle: client::Handle<Checker>,
    sftp: SftpSession,
    /// 經由跳板主機時，跳板的連線要一直開著。
    _jump: Option<client::Handle<Checker>>,
}

fn net(e: impl std::fmt::Display) -> DavError {
    DavError::Network(e.to_string())
}

/// 給連線對話框的訊息：`NEED_PASSWORD`、`HOSTKEY_DECLINED` 之類的代碼原樣交給前端。
fn connect_message(e: DavError) -> String {
    match e {
        DavError::Other(m) => m,
        e => e.message(&tr!("無法連線")),
    }
}

fn home_dir() -> Option<PathBuf> {
    // 測試不碰這台電腦真正的 ~/.ssh（known_hosts、金鑰）：改用暫存資料夾。
    if cfg!(test) {
        let dir = format!("omarker-ssh-home-{}", std::process::id());
        return Some(std::env::temp_dir().join(dir));
    }
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// `~/…` 換成家目錄。
fn expand_home(path: &str) -> PathBuf {
    match (
        path.strip_prefix("~/").or(path.strip_prefix("~\\")),
        home_dir(),
    ) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(path),
    }
}

/// 連線、登入、開啟 SFTP。整個過程有時間上限（伺服器在登入這一步沒有回應時也不會一直等）。
/// `approved` 是使用者確認過、還沒記進 known_hosts 的主機金鑰。
async fn connect(
    target: &SshTarget,
    user: &str,
    secrets: &Secrets,
    approved: &[(String, u16, PublicKey)],
) -> Result<Live, Fail> {
    match tokio::time::timeout(
        CONNECT_TIMEOUT,
        connect_inner(target, user, secrets, approved),
    )
    .await
    {
        Ok(r) => r,
        Err(_) => Err(net(tr!("等了 {s} 秒沒有回應", s = CONNECT_TIMEOUT.as_secs())).into()),
    }
}

/// 連線；遇到第一次連線的主機時用 `ask` 問使用者（跳板主機與目標主機分開問，正式的程式一律是
/// `ask_trust` 的系統對話框，測試才換成自動回答），同意後再連一次：這次出示同一把金鑰才信任，
/// 並記進 known_hosts。使用者不信任時回傳 `HOSTKEY_DECLINED`。確認過的金鑰放在 `approved`。
async fn connect_asking<A, Fut>(
    target: &SshTarget,
    user: &str,
    secrets: &Secrets,
    approved: &mut Approved,
    mut ask: A,
) -> Result<Live, DavError>
where
    A: FnMut(NewHost) -> Fut,
    Fut: Future<Output = bool>,
{
    loop {
        let h = match connect(target, user, secrets, approved).await {
            Ok(live) => return Ok(live),
            Err(Fail::Error(e)) => return Err(e),
            Err(Fail::NewHost(h)) => *h,
        };
        // 確認過的主機又出示另一把沒看過的金鑰：不再詢問，當成金鑰不同。
        if approved.len() >= 2
            || approved
                .iter()
                .any(|(host, port, _)| *host == h.host && *port == h.port)
        {
            return Err(changed(&h.host));
        }
        let (host, port, key) = (h.host.clone(), h.port, h.key.clone());
        if !ask(h).await {
            return Err(DavError::Other("HOSTKEY_DECLINED".into()));
        }
        approved.push((host, port, key));
    }
}

fn checker(
    host: &str,
    port: u16,
    approved: &[(String, u16, PublicKey)],
) -> (Checker, Arc<Mutex<Option<HostKey>>>) {
    let host = host.to_ascii_lowercase();
    let approved = approved
        .iter()
        .find(|(h, p, _)| *h == host && *p == port)
        .map(|(_, _, k)| k.clone());
    let seen = Arc::new(Mutex::new(None));
    let c = Checker {
        host,
        port,
        known_hosts: known_hosts_path(),
        approved,
        seen: seen.clone(),
    };
    (c, seen)
}

/// 等 SSH 交握完成；主機金鑰沒看過時交給呼叫端詢問使用者，不相符時換成給使用者看的訊息。
async fn handshake(
    fut: impl Future<Output = Result<client::Handle<Checker>, russh::Error>>,
    seen: &Mutex<Option<HostKey>>,
    host: &str,
    port: u16,
    hop: Hop,
) -> Result<client::Handle<Checker>, Fail> {
    match fut.await {
        Ok(handle) => Ok(handle),
        Err(e) => {
            let seen = seen.lock().clone();
            Err(match seen {
                Some(HostKey::Unknown(key)) => Fail::NewHost(Box::new(NewHost {
                    host: host.to_ascii_lowercase(),
                    port,
                    key,
                    hop,
                })),
                Some(HostKey::Changed) => changed(host).into(),
                Some(HostKey::Certificate) => {
                    DavError::Other(tr!("這台主機使用憑證驗證主機金鑰，目前不支援")).into()
                }
                Some(HostKey::Unreadable) => DavError::Other(tr!(
                    "無法讀取 ~/.ssh/known_hosts，不能確認 {host} 的主機金鑰。請檢查這個檔案的權限與內容後再連線。",
                    host = host
                ))
                .into(),
                _ => net(e).into(),
            })
        }
    }
}

async fn connect_inner(
    target: &SshTarget,
    user: &str,
    secrets: &Secrets,
    approved: &[(String, u16, PublicKey)],
) -> Result<Live, Fail> {
    // 連線清單是設定檔，可能被改過：主機名稱與金鑰檔再檢查一次。
    if !valid_host(&target.host) || target.jump.as_ref().is_some_and(|j| !valid_host(&j.host)) {
        return Err(DavError::Other(tr!("主機名稱不正確")).into());
    }
    let key_path = match target.key_path.as_deref() {
        Some(k) => Some(local_key_path(k).map_err(DavError::Other)?),
        None => None,
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 3,
        ..Default::default()
    });
    let (mut handle, jump) = match &target.jump {
        None => {
            let (c, seen) = checker(&target.host, target.port, approved);
            let addr = (target.host.as_str(), target.port);
            let fut = client::connect(config, addr, c);
            let h = handshake(fut, &seen, &target.host, target.port, Hop::Direct).await?;
            (h, None)
        }
        Some(j) => {
            let (c, seen) = checker(&j.host, j.port, approved);
            let addr = (j.host.as_str(), j.port);
            let fut = client::connect(config.clone(), addr, c);
            let mut jh = handshake(fut, &seen, &j.host, j.port, Hop::Jump).await?;
            authenticate(&mut jh, &Login::jump(j, key_path.as_deref(), secrets))
                .await
                .map_err(|e| match e {
                    DavError::Other(m) if m.starts_with("NEED_") => DavError::Other(m),
                    DavError::Other(m) => {
                        DavError::Other(tr!("無法登入跳板主機 {host}：{e}", host = j.host, e = m))
                    }
                    e => DavError::Other(tr!(
                        "無法登入跳板主機 {host}：{e}",
                        host = j.host,
                        e = e.message(&tr!("無法連線"))
                    )),
                })?;
            let channel = jh
                .channel_open_direct_tcpip(
                    target.host.clone(),
                    u32::from(target.port),
                    "127.0.0.1",
                    0,
                )
                .await
                .map_err(|e| {
                    DavError::Other(tr!(
                        "跳板主機 {jump} 無法連到 {host}：{e}",
                        jump = j.host,
                        host = target.host,
                        e = e
                    ))
                })?;
            let (c, seen) = checker(&target.host, target.port, approved);
            let fut = client::connect_stream(config, channel.into_stream(), c);
            let hop = Hop::Via(host_port(&j.host, j.port));
            let h = handshake(fut, &seen, &target.host, target.port, hop).await?;
            (h, Some(jh))
        }
    };
    authenticate(
        &mut handle,
        &Login::target(user, key_path.as_deref(), secrets),
    )
    .await?;
    let channel = handle.channel_open_session().await.map_err(net)?;
    channel.request_subsystem(true, "sftp").await.map_err(net)?;
    let config = russh_sftp::client::Config {
        request_timeout_secs: 20,
        ..Default::default()
    };
    let sftp = SftpSession::new_with_config(channel.into_stream(), config)
        .await
        .map_err(|e| DavError::Other(tr!("這台主機沒有開啟 SFTP：{e}", e = e)))?;
    Ok(Live {
        handle,
        sftp,
        _jump: jump,
    })
}

/// 登入一台主機時可以用的方法。
struct Login<'a> {
    user: &'a str,
    key_path: Option<&'a Path>,
    /// 解開金鑰檔的密語：只在這台電腦上使用，不會送出。
    passphrase: Option<&'a str>,
    /// 送給這台主機的密碼。
    password: Option<&'a str>,
    /// 需要密碼卻沒有時回傳的代碼。
    need: String,
}

impl<'a> Login<'a> {
    /// 目標主機：密碼欄是密碼；指定金鑰檔時也當作金鑰的密語。
    fn target(user: &'a str, key_path: Option<&'a Path>, s: &'a Secrets) -> Self {
        Login {
            user,
            key_path,
            passphrase: s.password.as_deref(),
            password: s.password.as_deref(),
            need: "NEED_PASSWORD".into(),
        }
    }

    /// 跳板主機：只用金鑰、ssh-agent 或使用者另外輸入的跳板主機密碼，絕不送出目標主機的密碼
    /// （密碼欄只拿來在這台電腦上解開金鑰檔）。跳板主機要密碼時回傳 `NEED_JUMP_PASSWORD`
    /// 與跳板主機的名稱，前端另外詢問。
    fn jump(j: &'a JumpHost, key_path: Option<&'a Path>, s: &'a Secrets) -> Self {
        Login {
            user: &j.user,
            key_path,
            passphrase: s.password.as_deref(),
            password: s.jump_password.as_deref(),
            need: format!("NEED_JUMP_PASSWORD\n{}", j.spec()),
        }
    }
}

async fn try_key(
    h: &mut client::Handle<Checker>,
    user: &str,
    key: russh::keys::PrivateKey,
    rsa_hash: Option<HashAlg>,
) -> Result<bool, DavError> {
    let key = PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash);
    Ok(h.authenticate_publickey(user, key)
        .await
        .map_err(net)?
        .success())
}

async fn try_password(
    h: &mut client::Handle<Checker>,
    user: &str,
    password: &str,
) -> Result<bool, DavError> {
    if h.authenticate_password(user, password)
        .await
        .map_err(net)?
        .success()
    {
        return Ok(true);
    }
    // 有些伺服器關掉密碼登入、只開「鍵盤互動」（問的也是密碼）。
    use client::KeyboardInteractiveAuthResponse as R;
    let mut res = h
        .authenticate_keyboard_interactive_start(user, None)
        .await
        .map_err(net)?;
    for _ in 0..3 {
        match res {
            R::Success => return Ok(true),
            R::Failure { .. } => return Ok(false),
            R::InfoRequest { prompts, .. } => {
                let answers = prompts
                    .iter()
                    .map(|p| {
                        if p.echo {
                            String::new()
                        } else {
                            password.to_string()
                        }
                    })
                    .collect();
                res = h
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(net)?;
            }
        }
    }
    Ok(false)
}

async fn try_agent_keys<S>(
    h: &mut client::Handle<Checker>,
    user: &str,
    mut agent: russh::keys::agent::client::AgentClient<S>,
    rsa_hash: Option<HashAlg>,
) -> bool
where
    S: russh::keys::agent::client::AgentStream + Unpin + Send + 'static,
{
    let Ok(ids) = agent.request_identities().await else {
        return false;
    };
    for id in ids.into_iter().take(MAX_AGENT_KEYS) {
        let russh::keys::agent::AgentIdentity::PublicKey { key, .. } = id else {
            continue;
        };
        let hash = if key.algorithm().is_rsa() {
            rsa_hash
        } else {
            None
        };
        if let Ok(res) = h
            .authenticate_publickey_with(user, key, hash, &mut agent)
            .await
        {
            if res.success() {
                return true;
            }
        }
    }
    false
}

async fn try_agent(h: &mut client::Handle<Checker>, user: &str, rsa_hash: Option<HashAlg>) -> bool {
    use russh::keys::agent::client::AgentClient;
    #[cfg(unix)]
    {
        if let Ok(agent) = AgentClient::connect_env().await {
            return try_agent_keys(h, user, agent, rsa_hash).await;
        }
    }
    #[cfg(windows)]
    {
        if let Ok(agent) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            if try_agent_keys(h, user, agent, rsa_hash).await {
                return true;
            }
        }
        if let Ok(agent) = AgentClient::connect_pageant().await {
            return try_agent_keys(h, user, agent, rsa_hash).await;
        }
    }
    false
}

/// 讀取金鑰檔的內容：只讀一般檔案，而且不超過大小上限。
fn read_key_file(path: &Path) -> Option<String> {
    use std::io::Read;
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_KEY_FILE {
        return None;
    }
    let mut text = String::new();
    std::fs::File::open(path)
        .ok()?
        .take(MAX_KEY_FILE)
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}

/// 讀取私鑰；有密語保護時用 `passphrase` 解開。`Ok(None)` 表示需要密語但沒有（或不對）。
/// 錯誤訊息不帶檔案內容與解析的細節，也分不出「不存在」和「不是金鑰」（網頁不能藉此探查這台電腦的檔案）。
fn load_key(
    path: &Path,
    passphrase: Option<&str>,
) -> Result<Option<russh::keys::PrivateKey>, String> {
    let unreadable =
        || tr!("無法讀取金鑰檔：請確認路徑正確，而且是 OpenSSH、PEM 或 PuTTY 格式的私鑰");
    let text = read_key_file(path).ok_or_else(unreadable)?;
    match russh::keys::decode_secret_key(&text, None) {
        Ok(key) => Ok(Some(key)),
        Err(russh::keys::Error::KeyIsEncrypted) => {
            Ok(passphrase.and_then(|p| russh::keys::decode_secret_key(&text, Some(p)).ok()))
        }
        Err(_) => Err(unreadable()),
    }
}

async fn authenticate(h: &mut client::Handle<Checker>, login: &Login<'_>) -> Result<(), DavError> {
    let rsa_hash = h.best_supported_rsa_hash().await.ok().flatten().flatten();
    let user = login.user;
    if let Some(path) = login.key_path {
        match load_key(path, login.passphrase).map_err(DavError::Other)? {
            Some(key) => {
                if try_key(h, user, key, rsa_hash).await? {
                    return Ok(());
                }
            }
            // 金鑰有密語保護：請使用者在密碼欄輸入密語。
            None if login.passphrase.is_none() => {
                return Err(DavError::Other("NEED_PASSWORD".into()))
            }
            None => {}
        }
        if let Some(password) = login.password {
            if try_password(h, user, password).await? {
                return Ok(());
            }
        }
    } else {
        if let Some(password) = login.password {
            if try_password(h, user, password).await? {
                return Ok(());
            }
        }
        if try_agent(h, user, rsa_hash).await {
            return Ok(());
        }
        if let Some(dir) = home_dir().map(|h| h.join(".ssh")) {
            for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
                let path = dir.join(name);
                if !path.is_file() {
                    continue;
                }
                if let Ok(Some(key)) = load_key(&path, login.passphrase) {
                    if try_key(h, user, key, rsa_hash).await? {
                        return Ok(());
                    }
                }
            }
        }
    }
    if login.password.is_none() {
        Err(DavError::Other(login.need.clone()))
    } else {
        Err(DavError::Other(tr!("無法登入：帳號、密碼或金鑰不正確")))
    }
}

/// 把使用者輸入的遠端資料夾換成絕對路徑（空白或 `~` 是家目錄），並確認是資料夾。
async fn resolve_root(sftp: &SftpSession, root: &str) -> Result<String, String> {
    let fail = |e: SftpError| sftp_err(e).message(&tr!("找不到遠端資料夾「{root}」", root = root));
    let home = sftp.canonicalize(".").await.map_err(fail)?;
    let root = root.trim();
    let path = match root {
        "" | "~" => home.clone(),
        r if r.starts_with("~/") => format!("{}/{}", home.trim_end_matches('/'), &r[2..]),
        r if r.starts_with('/') => r.to_string(),
        r => format!("{}/{r}", home.trim_end_matches('/')),
    };
    let abs = sftp.canonicalize(path).await.map_err(fail)?;
    let meta = sftp.metadata(abs.clone()).await.map_err(fail)?;
    if !meta.is_dir() {
        return Err(tr!("「{root}」不是資料夾", root = abs));
    }
    Ok(abs)
}

// ---- 檔案操作 -----------------------------------------------------------------

fn sftp_err(e: SftpError) -> DavError {
    match e {
        SftpError::Status(s) => match s.status_code {
            StatusCode::NoSuchFile => DavError::NotFound,
            StatusCode::PermissionDenied => DavError::Forbidden,
            StatusCode::NoConnection | StatusCode::ConnectionLost => {
                DavError::Network(s.error_message)
            }
            _ if s.error_message.is_empty() => DavError::Other(s.status_code.to_string()),
            _ => DavError::Other(s.error_message),
        },
        SftpError::Limited(m) => DavError::Other(m),
        e => DavError::Network(e.to_string()),
    }
}

/// 「修改時間-大小」當作版本標記（SFTP 沒有 ETag）。
fn version(meta: &Metadata) -> String {
    format!("\"{}-{}\"", meta.mtime.unwrap_or(0), meta.size.unwrap_or(0))
}

/// 檔案大小給人看的寫法。
fn size_label(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut v = bytes as f64 / 1024.0;
    let mut unit = 0;
    while v >= 1024.0 && unit < UNITS.len() - 1 {
        v /= 1024.0;
        unit += 1;
    }
    format!("{v:.1} {}", UNITS[unit])
}

/// Unix 權限（例如 `rw-r--r--`）。
fn permission_label(mode: u32) -> String {
    let bits = ['r', 'w', 'x'];
    (0..9)
        .map(|i| {
            if mode & (1 << (8 - i)) != 0 {
                bits[i % 3]
            } else {
                '-'
            }
        })
        .collect()
}

/// 檔案樹上滑鼠停留時顯示：大小（資料夾不顯示）、權限、修改時間。
fn describe(meta: &Metadata) -> String {
    let mut parts = Vec::new();
    if !meta.is_dir() {
        parts.push(size_label(meta.size.unwrap_or(0)));
    }
    if let Some(mode) = meta.permissions {
        parts.push(permission_label(mode));
    }
    if let Some(t) = meta
        .mtime
        .and_then(|m| chrono::DateTime::from_timestamp(i64::from(m), 0))
    {
        parts.push(
            t.with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M")
                .to_string(),
        );
    }
    parts.join(" · ")
}

fn child(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_string()
    } else {
        format!("{rel}/{name}")
    }
}

pub struct SshFs {
    target: SshTarget,
    user: String,
    secrets: Secrets,
    /// 這次連線時使用者確認過的主機金鑰（known_hosts 寫不進去時，自動重新連線也認得）。
    approved: Approved,
    live: Mutex<Option<Arc<Live>>>,
    /// 同時只重新連線一次；其他操作等它連好（非同步的鎖，等待時不佔住執行緒）。
    reconnecting: tokio::sync::Mutex<()>,
    /// 寫入一次只做一個（自動存檔和手動存檔不會同時寫同一個檔案）。
    writing: tokio::sync::Mutex<()>,
}

impl SshFs {
    fn abs(&self, rel: &str) -> String {
        let root = self.target.root.trim_end_matches('/');
        if rel.is_empty() {
            if root.is_empty() {
                "/".into()
            } else {
                root.to_string()
            }
        } else {
            format!("{root}/{rel}")
        }
    }

    fn current(&self) -> Option<Arc<Live>> {
        self.live.lock().clone().filter(|l| !l.handle.is_closed())
    }

    async fn live(&self) -> Result<Arc<Live>, DavError> {
        if let Some(live) = self.current() {
            return Ok(live);
        }
        let _guard = self.reconnecting.lock().await;
        if let Some(live) = self.current() {
            return Ok(live);
        }
        // 連不上是 `Network`（前端顯示斷線提示並定時檢查恢復）；登入或主機金鑰的問題是 `Other`。
        // 背景的重新連線不跳出確認主機金鑰的對話框。
        let live = connect(&self.target, &self.user, &self.secrets, &self.approved)
            .await
            .map_err(Fail::into_error)
            .map(Arc::new)?;
        *self.live.lock() = Some(live.clone());
        Ok(live)
    }

    /// 在連線上執行一個操作。連線斷掉時丟掉它，下次自動重新連線；`retry` 的操作（只讀不寫）會馬上再試一次。
    async fn run<T, F, Fut>(&self, retry: bool, f: F) -> Result<T, DavError>
    where
        F: Fn(Arc<Live>) -> Fut,
        Fut: Future<Output = Result<T, DavError>>,
    {
        for attempt in 0..2 {
            let live = self.live().await?;
            let err = match tokio::time::timeout(OP_TIMEOUT, f(live.clone())).await {
                Ok(Ok(v)) => return Ok(v),
                Ok(Err(e)) => e,
                Err(_) => DavError::Network(tr!("等了 {s} 秒沒有回應", s = OP_TIMEOUT.as_secs())),
            };
            if !matches!(err, DavError::Network(_)) {
                return Err(err);
            }
            {
                let mut slot = self.live.lock();
                if slot.as_ref().is_some_and(|l| Arc::ptr_eq(l, &live)) {
                    *slot = None;
                }
            }
            if !(retry && attempt == 0) {
                return Err(err);
            }
        }
        unreachable!() // i18n-ignore：迴圈一定會回傳
    }
}

async fn exists(sftp: &SftpSession, path: &str) -> Result<bool, DavError> {
    match sftp.symlink_metadata(path.to_string()).await {
        Ok(_) => Ok(true),
        Err(e) => match sftp_err(e) {
            DavError::NotFound => Ok(false),
            e => Err(e),
        },
    }
}

async fn write_file(
    sftp: &SftpSession,
    path: &str,
    bytes: &[u8],
    flags: OpenFlags,
) -> Result<(), DavError> {
    let mut file = sftp
        .open_with_flags(path.to_string(), OpenFlags::WRITE | flags)
        .await
        .map_err(sftp_err)?;
    file.write_all(bytes)
        .await
        .map_err(|e| DavError::Network(e.to_string()))?;
    file.shutdown()
        .await
        .map_err(|e| DavError::Network(e.to_string()))
}

/// 暫存檔的名稱：`.<檔名>.omarker-<亂數>.<用途>`，放在同一個資料夾（改名才不會跨磁碟）。
fn sibling(path: &str, what: &str) -> String {
    let (dir, name) = path.rsplit_once('/').unwrap_or(("", path));
    let mut b = [0u8; 4];
    let _ = getrandom::fill(&mut b);
    let tag: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{dir}/.{name}.omarker-{tag}.{what}")
}

/// 安全地換掉遠端檔案：先完整寫到暫存檔，再把原檔改名讓開、暫存檔改成原檔名，最後刪掉舊檔。
/// 寫到一半斷線時原檔完全沒動；換名之間斷線時，原本的內容還在 `.omarker-….old`。
/// 新檔沿用原檔的權限。
async fn replace_file(
    sftp: &SftpSession,
    path: &str,
    bytes: &[u8],
    meta: &Metadata,
) -> Result<(), DavError> {
    let tmp = sibling(path, "tmp");
    let old = sibling(path, "old");
    if let Err(e) = write_file(sftp, &tmp, bytes, OpenFlags::CREATE | OpenFlags::EXCLUDE).await {
        let _ = sftp.remove_file(tmp).await;
        return Err(e);
    }
    if let Some(perm) = meta.permissions {
        let mut attrs = russh_sftp::protocol::FileAttributes::empty();
        attrs.permissions = Some(perm & 0o7777);
        let _ = sftp.set_metadata(tmp.clone(), attrs).await;
    }
    if let Err(e) = sftp.rename(path.to_string(), old.clone()).await {
        let _ = sftp.remove_file(tmp).await;
        return Err(sftp_err(e));
    }
    if let Err(e) = sftp.rename(tmp.clone(), path.to_string()).await {
        // 換不過去：把原檔改回來。
        let _ = sftp.rename(old, path.to_string()).await;
        let _ = sftp.remove_file(tmp).await;
        return Err(sftp_err(e));
    }
    let _ = sftp.remove_file(old).await;
    Ok(())
}

impl RemoteFs for SshFs {
    fn stat<'a>(&'a self, rel: &'a str) -> FsFuture<'a, Item> {
        Box::pin(async move {
            let path = self.abs(rel);
            self.run(true, |live| {
                let path = path.clone();
                async move {
                    let meta = live.sftp.metadata(path).await.map_err(sftp_err)?;
                    Ok(Item::new(
                        rel.to_string(),
                        meta.is_dir(),
                        Some(version(&meta)),
                    ))
                }
            })
            .await
        })
    }

    fn list<'a>(&'a self, rel: &'a str) -> FsFuture<'a, Vec<Item>> {
        Box::pin(async move {
            let path = self.abs(rel);
            self.run(true, |live| {
                let path = path.clone();
                async move {
                    let entries = live.sftp.read_dir(path.clone()).await.map_err(sftp_err)?;
                    let mut items = Vec::new();
                    for e in entries {
                        let name = e.file_name();
                        if name == "." || name == ".." {
                            continue;
                        }
                        let mut meta = e.metadata();
                        if meta.is_symlink() {
                            // 連結：看它指到的是資料夾還是檔案（壞掉的連結略過）。
                            match live.sftp.metadata(format!("{path}/{name}")).await {
                                Ok(m) => meta = m,
                                Err(_) => continue,
                            }
                        }
                        let info = describe(&meta);
                        items.push(
                            Item::new(child(rel, &name), meta.is_dir(), Some(version(&meta)))
                                .with_detail(info),
                        );
                    }
                    Ok(items)
                }
            })
            .await
        })
    }

    fn get<'a>(&'a self, rel: &'a str) -> FsFuture<'a, (Vec<u8>, Option<String>)> {
        Box::pin(async move {
            let path = self.abs(rel);
            self.run(true, |live| {
                let path = path.clone();
                async move {
                    // 先記下版本再讀：讀的期間被改的話，下次輪詢會發現。
                    let meta = live.sftp.metadata(path.clone()).await.map_err(sftp_err)?;
                    if meta.is_dir() {
                        return Err(DavError::Other(tr!("這是資料夾")));
                    }
                    if meta.size.unwrap_or(0) > MAX_READ {
                        return Err(DavError::Other(tr!("檔案太大")));
                    }
                    // 伺服器回報的大小不可信：讀的時候也限制長度，送來更多資料就停下來。
                    let file = live.sftp.open(path).await.map_err(sftp_err)?;
                    let mut bytes = Vec::new();
                    tokio::io::AsyncReadExt::read_to_end(
                        &mut tokio::io::AsyncReadExt::take(file, MAX_READ + 1),
                        &mut bytes,
                    )
                    .await
                    .map_err(net)?;
                    if bytes.len() as u64 > MAX_READ {
                        return Err(DavError::Other(tr!("檔案太大")));
                    }
                    Ok((bytes, Some(version(&meta))))
                }
            })
            .await
        })
    }

    fn put<'a>(
        &'a self,
        rel: &'a str,
        bytes: &'a [u8],
        if_match: Option<&'a str>,
    ) -> FsFuture<'a, Option<String>> {
        Box::pin(async move {
            let path = self.abs(rel);
            let _writing = self.writing.lock().await;
            self.run(false, |live| {
                let path = path.clone();
                async move {
                    match if_match {
                        Some(expected) => {
                            let meta = match live.sftp.symlink_metadata(path.clone()).await {
                                Ok(m) => m,
                                Err(e) => {
                                    return Err(match sftp_err(e) {
                                        DavError::NotFound => DavError::Changed,
                                        e => e,
                                    })
                                }
                            };
                            let target = if meta.is_symlink() {
                                live.sftp.metadata(path.clone()).await.map_err(sftp_err)?
                            } else {
                                meta.clone()
                            };
                            if expected != crate::dav::ANY_VERSION && version(&target) != expected {
                                return Err(DavError::Changed);
                            }
                            if meta.is_symlink() {
                                // 連結：寫到它指向的檔案（換掉連結本身會把連結變成一般檔案）。
                                write_file(&live.sftp, &path, bytes, OpenFlags::TRUNCATE).await?;
                            } else {
                                replace_file(&live.sftp, &path, bytes, &meta).await?;
                            }
                        }
                        None => {
                            if exists(&live.sftp, &path).await? {
                                return Err(DavError::Changed);
                            }
                            write_file(
                                &live.sftp,
                                &path,
                                bytes,
                                OpenFlags::CREATE | OpenFlags::EXCLUDE,
                            )
                            .await?;
                        }
                    }
                    let meta = live.sftp.metadata(path).await.map_err(sftp_err)?;
                    Ok(Some(version(&meta)))
                }
            })
            .await
        })
    }

    fn mkdir<'a>(&'a self, rel: &'a str) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let path = self.abs(rel);
            self.run(false, |live| {
                let path = path.clone();
                async move {
                    if exists(&live.sftp, &path).await? {
                        return Err(DavError::Exists);
                    }
                    live.sftp.create_dir(path).await.map_err(sftp_err)
                }
            })
            .await
        })
    }

    fn rename<'a>(&'a self, from: &'a str, to: &'a str) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let (from, to) = (self.abs(from), self.abs(to));
            self.run(false, |live| {
                let (from, to) = (from.clone(), to.clone());
                async move {
                    if exists(&live.sftp, &to).await? {
                        return Err(DavError::Exists);
                    }
                    live.sftp.rename(from, to).await.map_err(sftp_err)
                }
            })
            .await
        })
    }

    fn delete<'a>(&'a self, rel: &'a str) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let path = self.abs(rel);
            self.run(false, |live| {
                let path = path.clone();
                async move {
                    let meta = live
                        .sftp
                        .symlink_metadata(path.clone())
                        .await
                        .map_err(sftp_err)?;
                    if !meta.is_dir() {
                        return live.sftp.remove_file(path).await.map_err(sftp_err);
                    }
                    // 資料夾：先列出全部（連結只刪連結本身），再從最深的開始刪。
                    let mut dirs = vec![path];
                    let mut files = Vec::new();
                    let mut i = 0;
                    while i < dirs.len() {
                        let dir = dirs[i].clone();
                        for e in live.sftp.read_dir(dir.clone()).await.map_err(sftp_err)? {
                            let name = e.file_name();
                            if name == "." || name == ".." {
                                continue;
                            }
                            let p = format!("{dir}/{name}");
                            if e.metadata().is_dir() {
                                dirs.push(p);
                            } else {
                                files.push(p);
                            }
                            if dirs.len() + files.len() > MAX_DELETE {
                                return Err(DavError::Other(tr!(
                                    "資料夾裡的項目超過 {n} 個，請改用終端機刪除",
                                    n = MAX_DELETE
                                )));
                            }
                        }
                        i += 1;
                    }
                    for f in files {
                        live.sftp.remove_file(f).await.map_err(sftp_err)?;
                    }
                    for d in dirs.into_iter().rev() {
                        live.sftp.remove_dir(d).await.map_err(sftp_err)?;
                    }
                    Ok(())
                }
            })
            .await
        })
    }
}

// ---- 指令 ---------------------------------------------------------------------

/// 主機欄可以直接輸入 `帳號@主機:連接埠`；分開填的欄位優先。主機名稱一律換成小寫
/// （和 ssh 指令一樣，known_hosts 的記錄才對得上）。
fn parse_host(input: &str, user: &str, port: Option<u16>) -> Result<(String, String, u16), String> {
    let mut host = input
        .trim()
        .trim_start_matches("ssh://")
        .trim_end_matches('/');
    let mut parsed_user = None;
    if let Some((u, h)) = host.rsplit_once('@') {
        parsed_user = Some(u);
        host = h;
    }
    let mut parsed_port = None;
    if let Some(rest) = host.strip_prefix('[') {
        // [IPv6]:port
        let (h, after) = rest.split_once(']').ok_or_else(|| tr!("主機名稱不正確"))?;
        host = h;
        parsed_port = after.strip_prefix(':');
    } else if host.matches(':').count() == 1 {
        let (h, p) = host.split_once(':').unwrap();
        host = h;
        parsed_port = Some(p);
    }
    let port = match (port, parsed_port) {
        (Some(p), _) => p,
        (None, Some(p)) => p.parse().map_err(|_| tr!("連接埠不正確"))?,
        (None, None) => 22,
    };
    let user = if user.trim().is_empty() {
        parsed_user.unwrap_or("").to_string()
    } else {
        user.trim().to_string()
    };
    let host = host.to_ascii_lowercase();
    if !valid_host(&host) {
        return Err(tr!("主機名稱不正確"));
    }
    if user.is_empty() {
        return Err(tr!("請輸入帳號"));
    }
    if !safe_word(&user) || user.contains('@') {
        return Err(tr!("帳號不正確"));
    }
    Ok((user, host, port))
}

/// 帳號不能以 `-` 開頭，也不能有空白或控制字元：
/// 交給終端機的 ssh 指令時，會被當成選項（例如 `-oProxyCommand=…` 會在本機執行程式）。
fn safe_word(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && !s.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn display_url(user: &str, t: &SshTarget) -> String {
    let host = if t.host.contains(':') {
        format!("[{}]", t.host)
    } else {
        t.host.clone()
    };
    let port = if t.port == 22 {
        String::new()
    } else {
        format!(":{}", t.port)
    };
    format!("ssh://{user}@{host}{port}{}", t.root)
}

fn folder_name(t: &SshTarget) -> String {
    match t.root.trim_end_matches('/').rsplit('/').next() {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => t.host.clone(),
    }
}

/// 已儲存的連線裡，和這次設定相同的那一個。
#[derive(Debug, PartialEq)]
enum Saved {
    /// 完全相同：沿用代號（和存好的密碼）。
    Same(String),
    /// 帳號、主機、連接埠、資料夾相同，但跳板主機或金鑰檔改了：不沿用代號，
    /// 舊設定存的密碼也要刪掉（不然重新連線時，存好的密碼會用在新的跳板主機上）。
    Changed(String),
    New,
}

fn match_saved(conns: &[Conn], user: &str, target: &SshTarget) -> Saved {
    let place = |c: &&Conn| {
        c.username == user
            && c.ssh.as_ref().is_some_and(|s| {
                s.host.eq_ignore_ascii_case(&target.host)
                    && s.port == target.port
                    && s.root == target.root
            })
    };
    let same = |c: &&Conn| {
        c.ssh
            .as_ref()
            .is_some_and(|s| s.jump == target.jump && s.key_path == target.key_path)
    };
    if let Some(c) = conns.iter().filter(place).find(same) {
        return Saved::Same(c.id.clone());
    }
    match conns.iter().find(place) {
        Some(c) => Saved::Changed(c.id.clone()),
        None => Saved::New,
    }
}

/// 連到新的 SSH 主機（或修改設定），成功後設為目前的工作區。
/// 第一次連線的主機由原生端用系統的對話框請使用者確認主機金鑰；跳板主機要密碼時回傳
/// `NEED_JUMP_PASSWORD`，前端另外詢問、用 `jump_password` 傳來。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_connect(
    app: AppHandle,
    window: tauri::Window,
    host: String,
    port: Option<u16>,
    username: String,
    password: Option<String>,
    jump_password: Option<String>,
    key_path: Option<String>,
    root: String,
    remember: bool,
    jump: Option<String>,
    dav: State<'_, Dav>,
) -> Result<FolderInfo, String> {
    let (user, host, port) = parse_host(&host, &username, port)?;
    // 跳板主機可以只寫主機名稱：帳號沿用目標主機的帳號。
    let jump = match jump.as_deref().map(str::trim).filter(|j| !j.is_empty()) {
        Some(j) => {
            let (user, host, port) = parse_host(j, if j.contains('@') { "" } else { &user }, None)
                .map_err(|e| tr!("跳板主機：{e}", e = e))?;
            Some(JumpHost { host, port, user })
        }
        None => None,
    };
    let key_path = key_path
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty());
    if let Some(k) = &key_path {
        local_key_path(k)?;
    }
    let secrets = Secrets {
        password: password.filter(|p| !p.is_empty()),
        // 沒有跳板主機時用不到跳板主機的密碼。
        jump_password: jump.as_ref().and(jump_password.filter(|p| !p.is_empty())),
    };
    let mut target = SshTarget {
        host,
        port,
        root: String::new(),
        key_path,
        jump,
    };
    let mut approved = Vec::new();
    let live = connect_asking(&target, &user, &secrets, &mut approved, |h| {
        ask_trust(&window, h)
    })
    .await
    .map_err(connect_message)?;
    target.root = resolve_root(&live.sftp, &root).await?;
    let conns = crate::dav::load_conns(&app);
    let (id, stale) = match match_saved(&conns, &user, &target) {
        Saved::Same(id) => (id, None),
        Saved::Changed(old) => (crate::dav::new_id(), Some(old)),
        Saved::New => (crate::dav::new_id(), None),
    };
    let conn = Conn {
        id,
        name: folder_name(&target),
        url: display_url(&user, &target),
        username: user.clone(),
        allow_http: false,
        ssh: Some(target.clone()),
    };
    let fs = SshFs {
        target,
        user,
        secrets: secrets.clone(),
        approved,
        live: Mutex::new(Some(Arc::new(live))),
        reconnecting: tokio::sync::Mutex::new(()),
        writing: tokio::sync::Mutex::new(()),
    };
    crate::dav::install(&app, &dav, conn.clone(), Box::new(fs));
    if let Some(old) = &stale {
        // 跳板主機或金鑰檔改了：舊設定存的密碼不再使用。
        crate::dav::forget_passwords(&dav, old);
    }
    if let Some(password) = secrets.password {
        crate::dav::keep_password(&dav, &conn.id, password, remember);
    }
    if let Some(password) = secrets.jump_password {
        let account = crate::dav::jump_account(&conn.id);
        crate::dav::keep_password(&dav, &account, password, remember);
    }
    let mut conns: Vec<Conn> = conns
        .into_iter()
        .filter(|c| c.id != conn.id && stale.as_ref() != Some(&c.id))
        .collect();
    conns.insert(0, conn.clone());
    crate::dav::save_conns(&app, &conns)?;
    Ok(crate::dav::folder_info(&conn))
}

/// 用存好的設定重新連線（`dav_reconnect` 遇到 SSH 連線時呼叫）。
/// 主機金鑰沒看過時（例如 known_hosts 的記錄被刪掉）用系統的對話框再確認一次。
pub(crate) async fn reconnect(
    app: &AppHandle,
    window: &tauri::Window,
    dav: &Dav,
    conn: Conn,
    secrets: Secrets,
) -> Result<(), String> {
    let target = conn.ssh.clone().ok_or_else(|| tr!("遠端路徑不正確"))?;
    let mut approved = Vec::new();
    let live = connect_asking(&target, &conn.username, &secrets, &mut approved, |h| {
        ask_trust(window, h)
    })
    .await
    .map_err(connect_message)?;
    resolve_root(&live.sftp, &target.root).await?;
    let fs = SshFs {
        target,
        user: conn.username.clone(),
        secrets,
        approved,
        live: Mutex::new(Some(Arc::new(live))),
        reconnecting: tokio::sync::Mutex::new(()),
        writing: tokio::sync::Mutex::new(()),
    };
    crate::dav::install(app, dav, conn, Box::new(fs));
    Ok(())
}

/// 內嵌終端機連到同一台主機的指令（用系統的 ssh；Windows 10 以後內建）。
/// 登入後切換到遠端資料夾。找不到 ssh 時回傳 `None`。
pub fn terminal_command(user: &str, t: &SshTarget) -> Option<portable_pty::CommandBuilder> {
    // 連線清單是設定檔，可能被改過：這裡再檢查一次（金鑰檔是網路路徑時也不執行）。
    if !safe_word(user)
        || !valid_host(&t.host)
        || t.jump
            .as_ref()
            .is_some_and(|j| !safe_word(&j.user) || !valid_host(&j.host))
    {
        return None;
    }
    let key = match t.key_path.as_deref() {
        Some(k) => Some(local_key_path(k).ok()?),
        None => None,
    };
    let ssh = which::which("ssh").ok()?;
    let mut cmd = portable_pty::CommandBuilder::new(ssh);
    cmd.args([
        "-t",
        "-o",
        "ServerAliveInterval=30",
        "-p",
        &t.port.to_string(),
    ]);
    if let Some(key) = key {
        cmd.arg("-i");
        cmd.arg(key);
    }
    if let Some(j) = &t.jump {
        cmd.arg("-J");
        cmd.arg(j.spec());
    }
    // `--` 之後一定是目的地，不會被當成選項。
    cmd.arg("--");
    cmd.arg(format!("{user}@{}", t.host));
    // 這一行會先經過遠端的登入 shell（可能是 fish、tcsh，引號的規則和 sh 不同），
    // 所以資料夾路徑用 base64 傳（只有英數字與 `+/=`，在哪種 shell 都不需要跳脫），
    // 交給 sh 解碼後切換資料夾，再換回使用者的 shell。
    use base64::Engine;
    let root = base64::engine::general_purpose::STANDARD.encode(t.root.as_bytes());
    cmd.arg(format!(
        "sh -c 'cd \"$(printf %s \"$1\" | base64 -d)\" 2>/dev/null; exec \"${{SHELL:-/bin/sh}}\" -l' sh {root}"
    ));
    Some(cmd)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::async_runtime::block_on;

    #[test]
    fn host_key_must_match_any_recorded_key() {
        let parse = |s: &str| russh::keys::parse_public_key_base64(s).unwrap();
        let ed = parse("AAAAC3NzaC1lZDI1NTE5AAAAIMV+3cc3PtT7NXXIhjMLTBNepYh3dqrUY5Lt8w7MLXDS");
        let other_ed =
            parse("AAAAC3NzaC1lZDI1NTE5AAAAIOoSDHNHfbtzBYseCRckQJAUs26l0CErqmzD943s6CF9");
        let ecdsa = parse("AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFacpkNE9PVpAPEoj83o6XZepb0cibsLdiSLis2Drauibq2ONxZKUcbSROL4R1p2VrP485Iy4ajDjU7KxKPVjL4=");
        assert!(matches!(
            judge(std::slice::from_ref(&ed), &ed, None),
            HostKey::Trusted
        ));
        // 同一種演算法、不同的金鑰。
        assert!(matches!(
            judge(std::slice::from_ref(&ed), &other_ed, None),
            HostKey::Changed
        ));
        // 換成另一種演算法：也要拒絕，不能當成第一次連線。
        assert!(matches!(
            judge(std::slice::from_ref(&ed), &ecdsa, None),
            HostKey::Changed
        ));
        // 有記錄時，就算使用者確認過也不能換成另一把（不能略過「金鑰不同」）。
        assert!(matches!(
            judge(std::slice::from_ref(&ed), &ecdsa, Some(&ecdsa)),
            HostKey::Changed
        ));
        // 沒有記錄：使用者在系統對話框確認過的那一把才信任。
        assert!(matches!(judge(&[], &ecdsa, None), HostKey::Unknown(..)));
        assert!(matches!(judge(&[], &ecdsa, Some(&ecdsa)), HostKey::Trusted));
        assert!(matches!(
            judge(&[], &ecdsa, Some(&ed)),
            HostKey::Unknown(..)
        ));
        // 有好幾把（ed25519 和 ecdsa 都記過）：符合其中一把就好。
        assert!(matches!(
            judge(&[ed, ecdsa.clone()], &ecdsa, None),
            HostKey::Trusted
        ));
    }

    #[test]
    fn parses_host_field() {
        assert_eq!(
            parse_host("eric@nas.local:2222", "", None).unwrap(),
            ("eric".into(), "nas.local".into(), 2222)
        );
        assert_eq!(
            parse_host("ssh://pi@192.168.1.5/", "", None).unwrap(),
            ("pi".into(), "192.168.1.5".into(), 22)
        );
        // 分開填的欄位優先。
        assert_eq!(
            parse_host("root@srv:2200", "eric", Some(22)).unwrap(),
            ("eric".into(), "srv".into(), 22)
        );
        assert_eq!(
            parse_host("[fe80::1]:2222", "u", None).unwrap(),
            ("u".into(), "fe80::1".into(), 2222)
        );
        assert_eq!(
            parse_host("fe80::1", "u", None).unwrap(),
            ("u".into(), "fe80::1".into(), 22)
        );
        assert!(parse_host("srv", "", None).is_err());
        assert!(parse_host("srv:abc", "u", None).is_err());
        assert!(parse_host("", "u", None).is_err());
        // 會被 ssh 當成選項的帳號、主機名稱。
        assert!(parse_host("-oProxyCommand=calc@srv", "", None).is_err());
        assert!(parse_host("srv", "-oProxyCommand=calc", None).is_err());
        assert!(parse_host("-oProxyCommand=calc", "eric", None).is_err());
        assert!(parse_host("srv", "eric bob", None).is_err());
        let t = SshTarget {
            host: "srv".into(),
            port: 22,
            root: "/".into(),
            key_path: None,
            jump: None,
        };
        assert!(terminal_command("-oProxyCommand=x", &t).is_none());
    }

    #[test]
    fn builds_paths_and_names() {
        let t = SshTarget {
            host: "srv".into(),
            port: 2222,
            root: "/home/eric/筆記".into(),
            key_path: None,
            jump: None,
        };
        assert_eq!(
            display_url("eric", &t),
            "ssh://eric@srv:2222/home/eric/筆記"
        );
        assert_eq!(folder_name(&t), "筆記");
        let fs = SshFs {
            target: t.clone(),
            user: "eric".into(),
            secrets: Secrets::default(),
            approved: Vec::new(),
            live: Mutex::new(None),
            reconnecting: tokio::sync::Mutex::new(()),
            writing: tokio::sync::Mutex::new(()),
        };
        assert_eq!(fs.abs(""), "/home/eric/筆記");
        assert_eq!(fs.abs("a/b.md"), "/home/eric/筆記/a/b.md");
        let root = SshTarget {
            root: "/".into(),
            ..t
        };
        assert_eq!(folder_name(&root), "srv");
        let fs = SshFs { target: root, ..fs };
        assert_eq!(fs.abs(""), "/");
        assert_eq!(fs.abs("etc"), "/etc");
    }

    #[test]
    fn describes_remote_files() {
        assert_eq!(size_label(512), "512 B");
        assert_eq!(size_label(1536), "1.5 KB");
        assert_eq!(size_label(5 * 1024 * 1024), "5.0 MB");
        assert_eq!(permission_label(0o644), "rw-r--r--");
        assert_eq!(permission_label(0o100755), "rwxr-xr-x");
        assert_eq!(crate::dav::numbered("a.md", 1), "a.md");
        assert_eq!(crate::dav::numbered("a.md", 2), "a (2).md");
        assert_eq!(crate::dav::numbered("README", 3), "README (3)");
        assert_eq!(crate::dav::numbered(".env", 2), ".env (2)");
    }

    #[test]
    fn terminal_goes_through_the_jump_host() {
        let mut t = SshTarget {
            host: "10.0.0.5".into(),
            port: 22,
            root: "/srv".into(),
            key_path: None,
            jump: Some(JumpHost {
                host: "bastion.example.com".into(),
                port: 2200,
                user: "eric".into(),
            }),
        };
        assert_eq!(
            t.jump.as_ref().unwrap().spec(),
            "eric@bastion.example.com:2200"
        );
        if let Some(cmd) = terminal_command("eric", &t) {
            let argv: Vec<String> = cmd
                .get_argv()
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
            let j = argv.iter().position(|a| a == "-J").unwrap();
            assert_eq!(argv[j + 1], "eric@bastion.example.com:2200");
            assert!(j < argv.iter().position(|a| a == "--").unwrap());
        }
        // 跳板主機的帳號或主機名稱不能被當成選項。
        t.jump.as_mut().unwrap().user = "-oProxyCommand=x".into();
        assert!(terminal_command("eric", &t).is_none());
        let v6 = JumpHost {
            host: "fe80::1".into(),
            port: 22,
            user: "a".into(),
        };
        assert_eq!(v6.spec(), "a@[fe80::1]:22");
    }

    #[test]
    fn terminal_opens_the_remote_folder() {
        let t = SshTarget {
            host: "srv".into(),
            port: 2222,
            root: "/home/eric/it's 筆記".into(),
            key_path: Some("/keys/id".into()),
            jump: None,
        };
        let Some(cmd) = terminal_command("eric", &t) else {
            return; // 這台電腦沒有 ssh
        };
        let argv: Vec<String> = cmd
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            &argv[1..],
            [
                "-t",
                "-o",
                "ServerAliveInterval=30",
                "-p",
                "2222",
                "-i",
                "/keys/id",
                "--",
                "eric@srv",
                // base64 of "/home/eric/it's 筆記"
                "sh -c 'cd \"$(printf %s \"$1\" | base64 -d)\" 2>/dev/null; exec \"${SHELL:-/bin/sh}\" -l' sh L2hvbWUvZXJpYy9pdCdzIOethuiomA==",
            ]
        );
    }

    const ED: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIMV+3cc3PtT7NXXIhjMLTBNepYh3dqrUY5Lt8w7MLXDS";
    const OTHER_ED: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIOoSDHNHfbtzBYseCRckQJAUs26l0CErqmzD943s6CF9";

    #[test]
    fn rejects_host_names_that_mean_something_in_known_hosts() {
        for ok in [
            "files.example",
            "files-01.example",
            "files_01.example",
            "localhost",
            "192.168.1.5",
            "fe80::1",
            "::1",
            "fe80::1%eth0",
            "fe80::1%12",
        ] {
            assert!(valid_host(ok), "{ok}");
        }
        for bad in [
            "",
            "*",
            "*.example",
            "files?.example",
            "realhost,x",
            "!files.example",
            "[files.example]",
            "files.example|x",
            "|1|abc",
            "#files.example",
            "files example",
            "-oProxyCommand=x",
            "files.example/x",
            "files..example",
            ".files.example",
            "files.example.",
            "檔案.example",
            "files.example\n",
            "fe80::zz",
            "fe80::1%",
            "fe80::1%eth0,x",
            "fe80::1%*",
        ] {
            assert!(!valid_host(bad), "{bad:?}");
        }
        assert!(!valid_host(&"a".repeat(64)));
        assert!(!valid_host(&format!("{}example", "a.".repeat(130))));
        // 主機欄與跳板主機欄用同一個函式解析：萬用字元、逗號之類的一律拒絕。
        for bad in [
            "*",
            "wang@*",
            "*:2222",
            "realhost,x",
            "wang@realhost,x:22",
            "[*]:22",
            "[fe80::1,x]:22",
            "!files.example",
            "files.example#x",
            "files.example|x",
        ] {
            assert!(parse_host(bad, "wang", None).is_err(), "{bad}");
        }
        // 主機名稱不分大小寫：換成小寫，known_hosts 的記錄才對得上。
        assert_eq!(
            parse_host("wang@Files.Example:2222", "", None).unwrap(),
            ("wang".into(), "files.example".into(), 2222)
        );
    }

    #[test]
    fn records_the_host_key_only_for_that_host_and_port() {
        let dir = std::env::temp_dir().join(format!("omarker-ssh-known-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join(".ssh").join("known_hosts");
        let key = russh::keys::parse_public_key_base64(ED).unwrap();
        // 還沒有檔案：當成沒有記錄（第一次連線）。
        assert!(recorded_keys(&path, "files.example", 22)
            .unwrap()
            .is_empty());
        learn(&path, "files.example", 2222, &key).unwrap();
        learn(&path, "jump.example", 22, &key).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let hosts: Vec<&str> = text
            .lines()
            .filter(|l| !l.is_empty())
            .filter_map(|l| l.split(' ').next())
            .collect();
        assert_eq!(hosts, ["[files.example]:2222", "jump.example"]);
        assert_eq!(
            recorded_keys(&path, "files.example", 2222).unwrap().len(),
            1
        );
        assert!(recorded_keys(&path, "files.example", 22)
            .unwrap()
            .is_empty());
        assert!(recorded_keys(&path, "files.example.attacker", 2222)
            .unwrap()
            .is_empty());
        // 會變成萬用字元、好幾台主機或註解的名稱不寫進去。
        for bad in [
            "*",
            "realhost,x",
            "!files.example",
            "a|b",
            "#x",
            "[x]",
            "a?",
        ] {
            assert!(learn(&path, bad, 22, &key).is_err(), "{bad}");
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn saved_connection_is_reused_only_with_the_same_jump_and_key() {
        let target = SshTarget {
            host: "files.example".into(),
            port: 22,
            root: "/home/wang/筆記".into(),
            key_path: None,
            jump: None,
        };
        let conn = |id: &str, t: &SshTarget| Conn {
            id: id.into(),
            name: "筆記".into(),
            url: display_url("wang", t),
            username: "wang".into(),
            allow_http: false,
            ssh: Some(t.clone()),
        };
        let saved = vec![conn("ab12cd34", &target)];
        assert_eq!(
            match_saved(&saved, "wang", &target),
            Saved::Same("ab12cd34".into())
        );
        // 舊版存的主機名稱可能有大寫。
        let upper = SshTarget {
            host: "Files.Example".into(),
            ..target.clone()
        };
        assert_eq!(
            match_saved(&[conn("ab12cd34", &upper)], "wang", &target),
            Saved::Same("ab12cd34".into())
        );
        // 加上（或換掉）跳板主機：不沿用代號，存好的密碼不能送到新的跳板主機。
        let jump = |host: &str| JumpHost {
            host: host.into(),
            port: 22,
            user: "wang".into(),
        };
        let via = SshTarget {
            jump: Some(jump("jump.example")),
            ..target.clone()
        };
        assert_eq!(
            match_saved(&saved, "wang", &via),
            Saved::Changed("ab12cd34".into())
        );
        let elsewhere = SshTarget {
            jump: Some(jump("other.example")),
            ..target.clone()
        };
        assert_eq!(
            match_saved(&[conn("ab12cd34", &via)], "wang", &elsewhere),
            Saved::Changed("ab12cd34".into())
        );
        assert_eq!(
            match_saved(&[conn("ab12cd34", &via)], "wang", &target),
            Saved::Changed("ab12cd34".into())
        );
        // 換金鑰檔也一樣。
        let keyed = SshTarget {
            key_path: Some("~/.ssh/id_ed25519".into()),
            ..target.clone()
        };
        assert_eq!(
            match_saved(&saved, "wang", &keyed),
            Saved::Changed("ab12cd34".into())
        );
        // 別的帳號、連接埠、資料夾：新的連線。
        assert_eq!(match_saved(&saved, "lee", &target), Saved::New);
        let other_port = SshTarget {
            port: 2222,
            ..target.clone()
        };
        assert_eq!(match_saved(&saved, "wang", &other_port), Saved::New);
        let other_root = SshTarget {
            root: "/srv".into(),
            ..target.clone()
        };
        assert_eq!(match_saved(&saved, "wang", &other_root), Saved::New);
        // 兩個都在時，用完全相同的那一個。
        let both = vec![conn("11111111", &via), conn("ab12cd34", &target)];
        assert_eq!(
            match_saved(&both, "wang", &target),
            Saved::Same("ab12cd34".into())
        );
    }

    #[test]
    fn jump_host_never_gets_the_target_password() {
        let j = JumpHost {
            host: "jump.example".into(),
            port: 22,
            user: "wang".into(),
        };
        let only_target = Secrets {
            password: Some("目標主機的密碼".into()),
            jump_password: None,
        };
        let login = Login::jump(&j, None, &only_target);
        assert_eq!(login.user, "wang");
        assert_eq!(login.password, None);
        // 密碼欄只拿來在這台電腦上解開金鑰檔。
        assert_eq!(login.passphrase, Some("目標主機的密碼"));
        assert_eq!(login.need, "NEED_JUMP_PASSWORD\nwang@jump.example:22");
        let both = Secrets {
            password: Some("目標主機的密碼".into()),
            jump_password: Some("跳板主機的密碼".into()),
        };
        assert_eq!(
            Login::jump(&j, None, &both).password,
            Some("跳板主機的密碼")
        );
        let target = Login::target("wang", None, &both);
        assert_eq!(target.password, Some("目標主機的密碼"));
        assert_eq!(target.need, "NEED_PASSWORD");
    }

    #[test]
    fn key_file_must_be_on_a_local_disk() {
        for ok in [
            r"C:\Users\me\.ssh\id_ed25519",
            "C:/Users/me/.ssh/id_ed25519",
            r"\\?\C:\Users\me\.ssh\id_ed25519",
        ] {
            assert!(local_absolute(ok, true), "{ok}");
        }
        for bad in [
            r"\\files.example\share\id_ed25519",
            "//files.example/share/id_ed25519",
            r"\/files.example/share/id_ed25519",
            r"/\files.example\share\id_ed25519",
            r"\\?\UNC\files.example\share\id_ed25519",
            r"\\.\pipe\openssh-ssh-agent",
            r"\\?\GLOBALROOT\Device\Mup\files.example\share\id_ed25519",
            r"\??\UNC\files.example\share\id_ed25519",
            r"\\?\C:",
            r"C:id_ed25519",
            r"\Users\me\.ssh\id_ed25519",
            "/Users/me/.ssh/id_ed25519",
            ".ssh/id_ed25519",
            "",
        ] {
            assert!(!local_absolute(bad, true), "{bad}");
        }
        assert!(local_absolute("/home/wang/.ssh/id_ed25519", false));
        for bad in [
            ".ssh/id_ed25519",
            "//files.example/share/id_ed25519",
            r"\\files.example\share\id_ed25519",
            r"C:\Users\me\.ssh\id_ed25519",
            "",
        ] {
            assert!(!local_absolute(bad, false), "{bad}");
        }
        // `~/` 換成家目錄（測試時是暫存資料夾）。
        assert_eq!(
            local_key_path(" ~/.ssh/id_ed25519 ").unwrap(),
            home_dir().unwrap().join(".ssh/id_ed25519")
        );
        assert!(local_key_path(r"\\files.example\share\id_ed25519").is_err());
        assert!(local_key_path("//files.example/share/id_ed25519").is_err());
        assert!(local_key_path("id_ed25519").is_err());
        // 終端機也不帶網路路徑的金鑰檔。
        let t = SshTarget {
            host: "files.example".into(),
            port: 22,
            root: "/".into(),
            key_path: Some("//files.example/share/id_ed25519".into()),
            jump: None,
        };
        assert!(terminal_command("wang", &t).is_none());
    }

    #[test]
    fn key_file_errors_reveal_nothing() {
        let dir = std::env::temp_dir().join(format!("omarker-ssh-keys-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let text = dir.join("筆記.txt");
        std::fs::write(
            &text,
            "王小明的機密\n-----BEGIN OPENSSH PRIVATE KEY-----\n機密\n",
        )
        .unwrap();
        let big = dir.join("big");
        std::fs::write(&big, vec![b'a'; MAX_KEY_FILE as usize + 1]).unwrap();
        let missing = dir.join("missing");
        let messages: Vec<String> = [&text, &big, &missing, &dir]
            .iter()
            .map(|p| load_key(p, None).unwrap_err())
            .collect();
        // 不是金鑰、太大、不存在、是資料夾：同一句話，不帶路徑與內容。
        assert!(messages.iter().all(|m| *m == messages[0]), "{messages:?}");
        assert!(!messages[0].contains("機密"));
        assert!(!messages[0].contains("筆記"));
        assert!(!messages[0].contains(&*dir.to_string_lossy()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn terminal_rejects_wildcard_hosts() {
        let t = SshTarget {
            host: "*".into(),
            port: 22,
            root: "/".into(),
            key_path: None,
            jump: None,
        };
        assert!(terminal_command("wang", &t).is_none());
        let via = SshTarget {
            host: "files.example".into(),
            jump: Some(JumpHost {
                host: "jump.example,*".into(),
                port: 22,
                user: "wang".into(),
            }),
            ..t
        };
        assert!(terminal_command("wang", &via).is_none());
    }

    /// 連線並自動回答「要不要信任這台主機」（只有測試這樣做；正式的程式一律跳出系統的對話框）。
    /// 記下問了哪幾台（名稱、是不是跳板主機）。
    fn dial(
        t: &SshTarget,
        user: &str,
        secrets: &Secrets,
        answer: bool,
        asked: &mut Vec<(String, bool)>,
    ) -> Result<Live, DavError> {
        let mut approved = Vec::new();
        block_on(connect_asking(t, user, secrets, &mut approved, |h| {
            asked.push((h.name(), matches!(h.hop, Hop::Jump)));
            std::future::ready(answer)
        }))
    }

    /// 需要本機的 sshd，預設不執行：
    /// `MD_SSH_HOST=127.0.0.1 MD_SSH_PORT=2222 MD_SSH_USER=tester MD_SSH_PASS=secret cargo test -- --ignored ssh_live`
    /// 用金鑰登入時改設 `MD_SSH_KEY=金鑰檔`。known_hosts 與預設的金鑰都在暫存的家目錄（見 `home_dir`），
    /// 不碰這台電腦的 ~/.ssh。
    #[test]
    #[ignore]
    fn ssh_live() {
        let env = |k: &str| std::env::var(k).unwrap();
        let home = home_dir().unwrap();
        let _ = std::fs::remove_dir_all(&home);
        let known = known_hosts_path().unwrap();
        let mut target = SshTarget {
            host: env("MD_SSH_HOST"),
            port: env("MD_SSH_PORT").parse().unwrap(),
            root: String::new(),
            key_path: std::env::var("MD_SSH_KEY").ok(),
            jump: None,
        };
        let name = host_port(&target.host, target.port);
        let entry = if target.port == 22 {
            format!("{} ", target.host)
        } else {
            format!("[{}]:{} ", target.host, target.port)
        };
        let user = env("MD_SSH_USER");
        let pass = std::env::var("MD_SSH_PASS").ok();
        let secrets = Secrets {
            password: pass.clone(),
            jump_password: None,
        };
        let mut asked = Vec::new();
        // 第一次：不認識的主機。使用者不信任時不連線、不記錄。
        let declined = dial(&target, &user, &secrets, false, &mut asked).err();
        assert_eq!(
            declined.map(connect_message).as_deref(),
            Some("HOSTKEY_DECLINED")
        );
        assert_eq!(asked, [(name.clone(), false)]);
        assert!(!known.exists() || !std::fs::read_to_string(&known).unwrap().contains(&entry));
        // 信任之後連上，並記進 known_hosts（只記這台主機的這個連接埠）。
        let live = dial(&target, &user, &secrets, true, &mut asked).unwrap();
        assert_eq!(asked.len(), 2);
        let recorded = std::fs::read_to_string(&known).unwrap();
        let lines: Vec<&str> = recorded.lines().filter(|l| !l.is_empty()).collect();
        assert_eq!(lines.len(), 1, "{recorded}");
        assert!(lines[0].starts_with(&entry), "{recorded}");
        // 之後不再詢問。
        drop(dial(&target, &user, &secrets, false, &mut asked).unwrap());
        assert_eq!(asked.len(), 2);
        // 密碼錯誤（用金鑰登入的測試環境會改用金鑰，不算錯）。
        if pass.is_some() && target.key_path.is_none() {
            let wrong = Secrets {
                password: Some("錯誤".into()),
                jump_password: None,
            };
            assert!(dial(&target, &user, &wrong, true, &mut asked).is_err());
        }
        // 金鑰和記錄的不同：一律拒絕，也不詢問使用者。
        let other = russh::keys::parse_public_key_base64(OTHER_ED).unwrap();
        std::fs::write(&known, format!("{entry}{}\n", other.to_openssh().unwrap())).unwrap();
        let refused = dial(&target, &user, &secrets, true, &mut asked).err();
        assert!(refused
            .map(connect_message)
            .is_some_and(|m| m.contains("ssh-keygen -R")));
        assert_eq!(asked.len(), 2);
        std::fs::write(&known, &recorded).unwrap();
        target.root = block_on(resolve_root(&live.sftp, "~")).unwrap();
        // 經由跳板主機（MD_SSH_JUMP，例如「帳號@主機:連接埠」；測試時可以跳回同一台）。
        if let Ok(spec) = std::env::var("MD_SSH_JUMP") {
            let (ju, jh, jp) = parse_host(&spec, &user, None).unwrap();
            let jump = JumpHost {
                host: jh,
                port: jp,
                user: ju,
            };
            let via = SshTarget {
                jump: Some(jump.clone()),
                ..target.clone()
            };
            // 跳板主機只能用密碼登入時：不會拿目標主機的密碼去試（就算兩台的密碼一樣），
            // 而是回傳 NEED_JUMP_PASSWORD 請使用者另外輸入。
            if target.key_path.is_none() {
                let need = dial(&via, &user, &secrets, true, &mut asked).err();
                assert_eq!(
                    need.map(connect_message),
                    Some(format!("NEED_JUMP_PASSWORD\n{}", jump.spec()))
                );
            }
            let with_jump = Secrets {
                password: pass.clone(),
                jump_password: pass.clone(),
            };
            // 跳板主機與目標主機都是第一次連線：分開詢問，先問跳板主機。
            std::fs::remove_file(&known).unwrap();
            asked.clear();
            let hop = dial(&via, &user, &with_jump, true, &mut asked).unwrap();
            assert!(hop._jump.is_some());
            assert_eq!(asked[0], (host_port(&jump.host, jump.port), true));
            assert!(asked.len() <= 2, "{asked:?}");
            let home = block_on(resolve_root(&hop.sftp, "~")).unwrap();
            assert_eq!(home, target.root);
        }
        let fs = SshFs {
            target,
            user,
            secrets,
            approved: Vec::new(),
            live: Mutex::new(Some(Arc::new(live))),
            reconnecting: tokio::sync::Mutex::new(()),
            writing: tokio::sync::Mutex::new(()),
        };
        let _ = block_on(fs.delete("測試 資料夾"));
        block_on(fs.mkdir("測試 資料夾")).unwrap();
        assert_eq!(
            block_on(fs.mkdir("測試 資料夾")).unwrap_err(),
            DavError::Exists
        );
        let v1 = block_on(fs.put("測試 資料夾/週報.md", "第一版".as_bytes(), None))
            .unwrap()
            .unwrap();
        assert_eq!(
            block_on(fs.put("測試 資料夾/週報.md", b"x", None)).unwrap_err(),
            DavError::Changed
        );
        let (body, got) = block_on(fs.get("測試 資料夾/週報.md")).unwrap();
        assert_eq!(String::from_utf8(body).unwrap(), "第一版");
        assert_eq!(got.as_deref(), Some(v1.as_str()));
        let v2 = block_on(fs.put(
            "測試 資料夾/週報.md",
            "第二版，比較長".as_bytes(),
            Some(&v1),
        ))
        .unwrap()
        .unwrap();
        assert_ne!(v1, v2);
        assert_eq!(
            block_on(fs.put("測試 資料夾/週報.md", b"x", Some(&v1))).unwrap_err(),
            DavError::Changed
        );
        // 換檔不留下暫存檔，並保留原檔的權限。
        let live = block_on(fs.live()).unwrap();
        let p = fs.abs("測試 資料夾/週報.md");
        let mut attrs = russh_sftp::protocol::FileAttributes::empty();
        attrs.permissions = Some(0o640);
        tauri::async_runtime::block_on(live.sftp.set_metadata(p.clone(), attrs)).unwrap();
        let v3 = block_on(fs.stat("測試 資料夾/週報.md"))
            .unwrap()
            .etag
            .unwrap();
        block_on(fs.put("測試 資料夾/週報.md", "第三版".as_bytes(), Some(&v3))).unwrap();
        let meta = tauri::async_runtime::block_on(live.sftp.metadata(p)).unwrap();
        assert_eq!(meta.permissions.unwrap() & 0o777, 0o640);
        assert!(block_on(fs.list("測試 資料夾"))
            .unwrap()
            .iter()
            .all(|i| !i.rel.contains(".omarker-")));
        block_on(fs.mkdir("測試 資料夾/子")).unwrap();
        block_on(fs.put("測試 資料夾/子/a.md", b"a", None)).unwrap();
        let list = block_on(fs.list("測試 資料夾")).unwrap();
        assert!(list
            .iter()
            .any(|i| i.rel == "測試 資料夾/週報.md" && !i.is_dir));
        assert!(list.iter().any(|i| i.rel == "測試 資料夾/子" && i.is_dir));
        block_on(fs.rename("測試 資料夾/週報.md", "測試 資料夾/改名.md")).unwrap();
        assert_eq!(
            block_on(fs.rename("測試 資料夾/改名.md", "測試 資料夾/子")).unwrap_err(),
            DavError::Exists
        );
        assert_eq!(
            block_on(fs.stat("測試 資料夾/週報.md")).unwrap_err(),
            DavError::NotFound
        );
        // 連線斷掉：下一個操作自動重新連線。
        let old = fs.live.lock().clone().unwrap();
        tauri::async_runtime::block_on(old.handle.disconnect(
            russh::Disconnect::ByApplication,
            "",
            "",
        ))
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(block_on(fs.stat("測試 資料夾/改名.md")).is_ok());
        block_on(fs.delete("測試 資料夾")).unwrap();
        assert_eq!(
            block_on(fs.stat("測試 資料夾")).unwrap_err(),
            DavError::NotFound
        );
        let _ = std::fs::remove_dir_all(&home);
    }
}
