//! SSH 遠端資料夾：用 SFTP 直接編輯 Linux 主機上的檔案。
//!
//! - 前端用 `ssh://<連線代號>/路徑` 表示遠端檔案；開檔、存檔、檔案樹、Ctrl+P、衝突處理、
//!   外部修改偵測都和 WebDAV 共用 `dav.rs`，這裡只負責連線與檔案操作（`RemoteFs`）。
//! - 登入順序：輸入的密碼 → ssh-agent（Windows 的 OpenSSH 驗證代理或 Pageant）→
//!   `~/.ssh` 裡的金鑰（id_ed25519、id_ecdsa、id_rsa）。指定金鑰檔時先用那把金鑰，
//!   密碼欄當作金鑰的密語。都不行而且沒有輸入密碼時回傳 `NEED_PASSWORD`，前端再詢問。
//! - 主機金鑰記在 `~/.ssh/known_hosts`（和 ssh 指令共用）。第一次連線時回傳
//!   `HOSTKEY_UNKNOWN`，請使用者確認指紋後再連一次；和記錄的不同時拒絕連線。
//! - SFTP 沒有 ETag：用「修改時間-大小」判斷檔案在開啟後有沒有被改過。
//! - 連線斷掉（電腦睡眠、換網路）時，下一個操作會自動重新連線。
//! - 跳板主機（ProxyJump）：先連到跳板主機，再從那裡開一條通道連到目標主機（兩台的主機金鑰都會檢查）。
//!   跳板主機用金鑰或 ssh-agent 登入；需要密碼時用和目標主機相同的密碼。

use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
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

use crate::dav::{Conn, Dav, DavError, Item, RemoteFs};
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
    /// 給 ssh 指令 `-J` 用的寫法（`帳號@主機:連接埠`，IPv6 加中括號）。
    fn spec(&self) -> String {
        let host = if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        format!("{}@{host}:{}", self.user, self.port)
    }
}

// ---- 主機金鑰 ---------------------------------------------------------------

#[derive(Clone, Debug)]
enum HostKey {
    Trusted,
    /// 沒看過的主機：(演算法, SHA256 指紋)。
    Unknown(String, String),
    /// 和 known_hosts 記錄的不同。
    Changed,
    /// 主機憑證（目前不支援）。
    Certificate,
}

struct Checker {
    host: String,
    port: u16,
    /// 使用者確認過的指紋（第一次連線時）。
    trust: Option<String>,
    seen: Arc<Mutex<Option<HostKey>>>,
}

fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

/// 判斷主機金鑰。known_hosts 已經有這台主機的記錄、卻沒有一把相符時一律拒絕——
/// 連演算法不同的情況也算（攔截連線的人可能改出示另一種金鑰，假裝成第一次連線）。
fn judge(recorded: &[PublicKey], key: &PublicKey, trust: Option<&str>) -> HostKey {
    if recorded.iter().any(|k| k.key_data() == key.key_data()) {
        HostKey::Trusted
    } else if !recorded.is_empty() {
        HostKey::Changed
    } else if trust == Some(fingerprint(key).as_str()) {
        HostKey::Trusted
    } else {
        HostKey::Unknown(key.algorithm().as_str().to_string(), fingerprint(key))
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
                let recorded: Vec<PublicKey> =
                    russh::keys::known_hosts::known_host_keys(&self.host, self.port)
                        .unwrap_or_default()
                        .into_iter()
                        .map(|(_, k)| k)
                        .collect();
                let state = judge(&recorded, key, self.trust.as_deref());
                if matches!(state, HostKey::Trusted) && recorded.is_empty() {
                    // 使用者確認過：記進 known_hosts（寫不進去也讓這次連線）。
                    let _ = russh::keys::known_hosts::learn_known_hosts(&self.host, self.port, key);
                }
                state
            }
            PublicKeyOrCertificate::Certificate(_) => HostKey::Certificate,
        };
        let ok = matches!(state, HostKey::Trusted);
        *self.seen.lock().unwrap() = Some(state);
        Ok(ok)
    }
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

/// 給連線對話框的訊息：`NEED_PASSWORD`、`HOSTKEY_UNKNOWN…` 之類的代碼原樣交給前端。
fn connect_message(e: DavError) -> String {
    match e {
        DavError::Other(m) => m,
        e => e.message(&tr!("無法連線")),
    }
}

fn home_dir() -> Option<PathBuf> {
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
async fn connect(
    target: &SshTarget,
    user: &str,
    secret: Option<&str>,
    trust: Option<String>,
) -> Result<Live, DavError> {
    match tokio::time::timeout(CONNECT_TIMEOUT, connect_inner(target, user, secret, trust)).await {
        Ok(r) => r,
        Err(_) => Err(net(tr!(
            "等了 {s} 秒沒有回應",
            s = CONNECT_TIMEOUT.as_secs()
        ))),
    }
}

fn checker(host: &str, port: u16, trust: Option<String>) -> (Checker, Arc<Mutex<Option<HostKey>>>) {
    let seen = Arc::new(Mutex::new(None));
    let c = Checker {
        host: host.to_string(),
        port,
        trust,
        seen: seen.clone(),
    };
    (c, seen)
}

/// 等 SSH 交握完成；主機金鑰沒看過或不相符時，換成給前端的訊息。
async fn handshake(
    fut: impl Future<Output = Result<client::Handle<Checker>, russh::Error>>,
    seen: &Mutex<Option<HostKey>>,
    host: &str,
) -> Result<client::Handle<Checker>, DavError> {
    match fut.await {
        Ok(handle) => Ok(handle),
        Err(e) => {
            let seen = seen.lock().unwrap().clone();
            Err(match seen {
                // 第四行是主機名稱：經由跳板主機時，前端才知道是在確認哪一台。
                Some(HostKey::Unknown(algo, fp)) => {
                    DavError::Other(format!("HOSTKEY_UNKNOWN\n{algo}\n{fp}\n{host}"))
                }
                Some(HostKey::Changed) => DavError::Other(tr!(
                    "{host} 的主機金鑰和上次連線時不同：可能是伺服器重新安裝過，也可能有人在攔截連線。確定沒問題的話，請在終端機執行 ssh-keygen -R {host} 刪掉舊的記錄，再重新連線。",
                    host = host
                )),
                Some(HostKey::Certificate) => {
                    DavError::Other(tr!("這台主機使用憑證驗證主機金鑰，目前不支援"))
                }
                _ => net(e),
            })
        }
    }
}

async fn connect_inner(
    target: &SshTarget,
    user: &str,
    secret: Option<&str>,
    trust: Option<String>,
) -> Result<Live, DavError> {
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 3,
        ..Default::default()
    });
    let (mut handle, jump) = match &target.jump {
        None => {
            let (c, seen) = checker(&target.host, target.port, trust);
            let addr = (target.host.as_str(), target.port);
            let h = handshake(client::connect(config, addr, c), &seen, &target.host).await?;
            (h, None)
        }
        Some(j) => {
            let (c, seen) = checker(&j.host, j.port, trust.clone());
            let addr = (j.host.as_str(), j.port);
            let mut jh =
                handshake(client::connect(config.clone(), addr, c), &seen, &j.host).await?;
            authenticate(&mut jh, target.key_path.as_deref(), &j.user, secret)
                .await
                .map_err(|e| match e {
                    DavError::Other(m) if m == "NEED_PASSWORD" => DavError::Other(m),
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
            let (c, seen) = checker(&target.host, target.port, trust);
            let h = handshake(
                client::connect_stream(config, channel.into_stream(), c),
                &seen,
                &target.host,
            )
            .await?;
            (h, Some(jh))
        }
    };
    authenticate(&mut handle, target.key_path.as_deref(), user, secret).await?;
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

/// 讀取私鑰；有密語保護時用 `secret` 解開。`Ok(None)` 表示需要密語但沒有（或不對）。
fn load_key(
    path: &std::path::Path,
    secret: Option<&str>,
) -> Result<Option<russh::keys::PrivateKey>, String> {
    match russh::keys::load_secret_key(path, None) {
        Ok(key) => Ok(Some(key)),
        Err(russh::keys::Error::KeyIsEncrypted) => match secret {
            Some(s) => Ok(russh::keys::load_secret_key(path, Some(s)).ok()),
            None => Ok(None),
        },
        Err(e) => Err(tr!(
            "無法讀取金鑰檔「{path}」：{e}",
            path = path.display(),
            e = e
        )),
    }
}

async fn authenticate(
    h: &mut client::Handle<Checker>,
    key_path: Option<&str>,
    user: &str,
    secret: Option<&str>,
) -> Result<(), DavError> {
    let rsa_hash = h.best_supported_rsa_hash().await.ok().flatten().flatten();
    if let Some(path) = key_path.filter(|p| !p.trim().is_empty()) {
        let path = expand_home(path.trim());
        match load_key(&path, secret).map_err(DavError::Other)? {
            Some(key) => {
                if try_key(h, user, key, rsa_hash).await? {
                    return Ok(());
                }
            }
            None if secret.is_none() => return Err(DavError::Other("NEED_PASSWORD".into())),
            None => {}
        }
        if let Some(password) = secret {
            if try_password(h, user, password).await? {
                return Ok(());
            }
        }
    } else {
        if let Some(password) = secret {
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
                if let Ok(Some(key)) = load_key(&path, secret) {
                    if try_key(h, user, key, rsa_hash).await? {
                        return Ok(());
                    }
                }
            }
        }
    }
    if secret.is_none() {
        Err(DavError::Other("NEED_PASSWORD".into()))
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
    secret: Option<String>,
    live: Mutex<Option<Arc<Live>>>,
    /// 同時只重新連線一次。
    reconnecting: Mutex<()>,
    /// 寫入一次只做一個（自動存檔和手動存檔不會同時寫同一個檔案）。
    writing: Mutex<()>,
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
        self.live
            .lock()
            .unwrap()
            .clone()
            .filter(|l| !l.handle.is_closed())
    }

    fn live(&self) -> Result<Arc<Live>, DavError> {
        if let Some(live) = self.current() {
            return Ok(live);
        }
        let _guard = self.reconnecting.lock().unwrap();
        if let Some(live) = self.current() {
            return Ok(live);
        }
        // 連不上是 `Network`（前端顯示斷線提示並定時檢查恢復）；登入或主機金鑰的問題是 `Other`。
        let live = tauri::async_runtime::block_on(connect(
            &self.target,
            &self.user,
            self.secret.as_deref(),
            None,
        ))
        .map(Arc::new)?;
        *self.live.lock().unwrap() = Some(live.clone());
        Ok(live)
    }

    /// 在連線上執行一個操作。連線斷掉時丟掉它，下次自動重新連線；`retry` 的操作（只讀不寫）會馬上再試一次。
    fn run<T, F, Fut>(&self, retry: bool, f: F) -> Result<T, DavError>
    where
        F: Fn(Arc<Live>) -> Fut,
        Fut: Future<Output = Result<T, DavError>>,
    {
        for attempt in 0..2 {
            let live = self.live()?;
            let fut = f(live.clone());
            let result = tauri::async_runtime::block_on(async {
                tokio::time::timeout(OP_TIMEOUT, fut).await
            });
            let err = match result {
                Ok(Ok(v)) => return Ok(v),
                Ok(Err(e)) => e,
                Err(_) => DavError::Network(tr!("等了 {s} 秒沒有回應", s = OP_TIMEOUT.as_secs())),
            };
            if !matches!(err, DavError::Network(_)) {
                return Err(err);
            }
            {
                let mut slot = self.live.lock().unwrap();
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
    fn stat(&self, rel: &str) -> Result<Item, DavError> {
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
    }

    fn list(&self, rel: &str) -> Result<Vec<Item>, DavError> {
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
    }

    fn get(&self, rel: &str) -> Result<(Vec<u8>, Option<String>), DavError> {
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
                let bytes = live.sftp.read(path).await.map_err(sftp_err)?;
                Ok((bytes, Some(version(&meta))))
            }
        })
    }

    fn put(
        &self,
        rel: &str,
        bytes: &[u8],
        if_match: Option<&str>,
    ) -> Result<Option<String>, DavError> {
        let path = self.abs(rel);
        let _writing = self.writing.lock().unwrap_or_else(|e| e.into_inner());
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
    }

    fn mkdir(&self, rel: &str) -> Result<(), DavError> {
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
    }

    fn rename(&self, from: &str, to: &str) -> Result<(), DavError> {
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
    }

    fn delete(&self, rel: &str) -> Result<(), DavError> {
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
    }
}

// ---- 指令 ---------------------------------------------------------------------

/// 主機欄可以直接輸入 `帳號@主機:連接埠`；分開填的欄位優先。
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
    if !safe_word(host) || host.contains('/') {
        return Err(tr!("主機名稱不正確"));
    }
    if user.is_empty() {
        return Err(tr!("請輸入帳號"));
    }
    if !safe_word(&user) || user.contains('@') {
        return Err(tr!("帳號不正確"));
    }
    Ok((user, host.to_string(), port))
}

/// 帳號、主機名稱不能以 `-` 開頭，也不能有空白或控制字元：
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

/// 連到新的 SSH 主機（或修改設定），成功後設為目前的工作區。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_connect(
    app: AppHandle,
    host: String,
    port: Option<u16>,
    username: String,
    password: Option<String>,
    key_path: Option<String>,
    root: String,
    remember: bool,
    trust: Option<String>,
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
    let secret = password.filter(|p| !p.is_empty());
    let key_path = key_path
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty());
    let mut target = SshTarget {
        host,
        port,
        root: String::new(),
        key_path,
        jump,
    };
    let live = connect(&target, &user, secret.as_deref(), trust)
        .await
        .map_err(connect_message)?;
    target.root = resolve_root(&live.sftp, &root).await?;
    let conns = crate::dav::load_conns(&app);
    let id = conns
        .iter()
        .find(|c| {
            c.username == user
                && c.ssh.as_ref().is_some_and(|s| {
                    s.host == target.host && s.port == target.port && s.root == target.root
                })
        })
        .map(|c| c.id.clone())
        .unwrap_or_else(|| {
            let mut b = [0u8; 4];
            let _ = getrandom::fill(&mut b);
            b.iter().map(|x| format!("{x:02x}")).collect()
        });
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
        secret: secret.clone(),
        live: Mutex::new(Some(Arc::new(live))),
        reconnecting: Mutex::new(()),
        writing: Mutex::new(()),
    };
    crate::dav::install(&app, &dav, conn.clone(), Box::new(fs));
    if let Some(secret) = secret {
        crate::dav::keep_password(&dav, &conn.id, secret, remember);
    }
    let mut conns: Vec<Conn> = conns.into_iter().filter(|c| c.id != conn.id).collect();
    conns.insert(0, conn.clone());
    crate::dav::save_conns(&app, &conns)?;
    Ok(crate::dav::folder_info(&conn))
}

/// 用存好的設定重新連線（`dav_reconnect` 遇到 SSH 連線時呼叫）。
pub(crate) async fn reconnect(
    app: &AppHandle,
    dav: &Dav,
    conn: Conn,
    secret: Option<String>,
    trust: Option<String>,
) -> Result<(), String> {
    let target = conn.ssh.clone().ok_or_else(|| tr!("遠端路徑不正確"))?;
    let live = connect(&target, &conn.username, secret.as_deref(), trust)
        .await
        .map_err(connect_message)?;
    resolve_root(&live.sftp, &target.root).await?;
    let fs = SshFs {
        target,
        user: conn.username.clone(),
        secret,
        live: Mutex::new(Some(Arc::new(live))),
        reconnecting: Mutex::new(()),
        writing: Mutex::new(()),
    };
    crate::dav::install(app, dav, conn, Box::new(fs));
    Ok(())
}

/// 內嵌終端機連到同一台主機的指令（用系統的 ssh；Windows 10 以後內建）。
/// 登入後切換到遠端資料夾。找不到 ssh 時回傳 `None`。
pub fn terminal_command(user: &str, t: &SshTarget) -> Option<portable_pty::CommandBuilder> {
    // 連線清單是設定檔，可能被改過：這裡再檢查一次。
    if !safe_word(user)
        || !safe_word(&t.host)
        || t.jump
            .as_ref()
            .is_some_and(|j| !safe_word(&j.user) || !safe_word(&j.host))
    {
        return None;
    }
    let ssh = which::which("ssh").ok()?;
    let mut cmd = portable_pty::CommandBuilder::new(ssh);
    cmd.args([
        "-t",
        "-o",
        "ServerAliveInterval=30",
        "-p",
        &t.port.to_string(),
    ]);
    if let Some(key) = t.key_path.as_deref() {
        cmd.arg("-i");
        cmd.arg(expand_home(key));
    }
    if let Some(j) = &t.jump {
        cmd.arg("-J");
        cmd.arg(j.spec());
    }
    // `--` 之後一定是目的地，不會被當成選項。
    cmd.arg("--");
    cmd.arg(format!("{user}@{}", t.host));
    // 遠端的登入 shell 可能不是 sh（例如 fish）：交給 sh 切換資料夾，再換回使用者的 shell。
    let root = t.root.replace('\'', r"'\''");
    cmd.arg(format!(
        "sh -c 'cd \"$1\" 2>/dev/null; exec \"${{SHELL:-/bin/sh}}\" -l' sh '{root}'"
    ));
    Some(cmd)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let fp = fingerprint(&ecdsa);
        assert!(matches!(
            judge(std::slice::from_ref(&ed), &ecdsa, Some(&fp)),
            HostKey::Changed
        ));
        // 沒有記錄：使用者確認過指紋才信任。
        assert!(matches!(judge(&[], &ecdsa, None), HostKey::Unknown(..)));
        assert!(matches!(judge(&[], &ecdsa, Some(&fp)), HostKey::Trusted));
        assert!(matches!(
            judge(&[], &ecdsa, Some("SHA256:別的")),
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
            secret: None,
            live: Mutex::new(None),
            reconnecting: Mutex::new(()),
            writing: Mutex::new(()),
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
                "sh -c 'cd \"$1\" 2>/dev/null; exec \"${SHELL:-/bin/sh}\" -l' sh '/home/eric/it'\\''s 筆記'",
            ]
        );
    }

    /// 需要本機的 sshd，預設不執行：
    /// `MD_SSH_HOST=127.0.0.1 MD_SSH_PORT=2222 MD_SSH_USER=tester MD_SSH_PASS=secret cargo test -- --ignored ssh_live`
    #[test]
    #[ignore]
    fn ssh_live() {
        let env = |k: &str| std::env::var(k).unwrap();
        let mut target = SshTarget {
            host: env("MD_SSH_HOST"),
            port: env("MD_SSH_PORT").parse().unwrap(),
            root: String::new(),
            key_path: None,
            jump: None,
        };
        let user = env("MD_SSH_USER");
        let pass = std::env::var("MD_SSH_PASS").ok();
        // 第一次：不認識的主機，要使用者確認指紋。
        let fp =
            match tauri::async_runtime::block_on(connect(&target, &user, pass.as_deref(), None))
                .map_err(connect_message)
            {
                Err(e) if e.starts_with("HOSTKEY_UNKNOWN") => e.lines().nth(2).unwrap().to_string(),
                Ok(_) => String::new(), // 已經在 known_hosts 裡
                Err(e) => panic!("{e}"),
            };
        let live = tauri::async_runtime::block_on(connect(
            &target,
            &user,
            pass.as_deref(),
            (!fp.is_empty()).then_some(fp),
        ))
        .unwrap();
        // 密碼錯誤（用金鑰登入的測試環境會改用金鑰，不算錯）。
        if pass.is_some() {
            let wrong = tauri::async_runtime::block_on(connect(&target, &user, Some("錯誤"), None));
            assert!(wrong.is_err());
        }
        target.root = tauri::async_runtime::block_on(resolve_root(&live.sftp, "~")).unwrap();
        // 經由跳板主機（MD_SSH_JUMP，例如「帳號@主機:連接埠」；測試時可以跳回同一台）。
        if let Ok(spec) = std::env::var("MD_SSH_JUMP") {
            let (ju, jh, jp) = parse_host(&spec, &user, None).unwrap();
            let via = SshTarget {
                jump: Some(JumpHost {
                    host: jh,
                    port: jp,
                    user: ju,
                }),
                ..target.clone()
            };
            let hop = tauri::async_runtime::block_on(connect(&via, &user, pass.as_deref(), None))
                .unwrap();
            assert!(hop._jump.is_some());
            let home = tauri::async_runtime::block_on(resolve_root(&hop.sftp, "~")).unwrap();
            assert_eq!(home, target.root);
        }
        let fs = SshFs {
            target,
            user,
            secret: pass,
            live: Mutex::new(Some(Arc::new(live))),
            reconnecting: Mutex::new(()),
            writing: Mutex::new(()),
        };
        let _ = fs.delete("測試 資料夾");
        fs.mkdir("測試 資料夾").unwrap();
        assert_eq!(fs.mkdir("測試 資料夾").unwrap_err(), DavError::Exists);
        let v1 = fs
            .put("測試 資料夾/週報.md", "第一版".as_bytes(), None)
            .unwrap()
            .unwrap();
        assert_eq!(
            fs.put("測試 資料夾/週報.md", b"x", None).unwrap_err(),
            DavError::Changed
        );
        let (body, got) = fs.get("測試 資料夾/週報.md").unwrap();
        assert_eq!(String::from_utf8(body).unwrap(), "第一版");
        assert_eq!(got.as_deref(), Some(v1.as_str()));
        let v2 = fs
            .put(
                "測試 資料夾/週報.md",
                "第二版，比較長".as_bytes(),
                Some(&v1),
            )
            .unwrap()
            .unwrap();
        assert_ne!(v1, v2);
        assert_eq!(
            fs.put("測試 資料夾/週報.md", b"x", Some(&v1)).unwrap_err(),
            DavError::Changed
        );
        // 換檔不留下暫存檔，並保留原檔的權限。
        let live = fs.live().unwrap();
        let p = fs.abs("測試 資料夾/週報.md");
        let mut attrs = russh_sftp::protocol::FileAttributes::empty();
        attrs.permissions = Some(0o640);
        tauri::async_runtime::block_on(live.sftp.set_metadata(p.clone(), attrs)).unwrap();
        let v3 = fs.stat("測試 資料夾/週報.md").unwrap().etag.unwrap();
        fs.put("測試 資料夾/週報.md", "第三版".as_bytes(), Some(&v3))
            .unwrap();
        let meta = tauri::async_runtime::block_on(live.sftp.metadata(p)).unwrap();
        assert_eq!(meta.permissions.unwrap() & 0o777, 0o640);
        assert!(fs
            .list("測試 資料夾")
            .unwrap()
            .iter()
            .all(|i| !i.rel.contains(".omarker-")));
        fs.mkdir("測試 資料夾/子").unwrap();
        fs.put("測試 資料夾/子/a.md", b"a", None).unwrap();
        let list = fs.list("測試 資料夾").unwrap();
        assert!(list
            .iter()
            .any(|i| i.rel == "測試 資料夾/週報.md" && !i.is_dir));
        assert!(list.iter().any(|i| i.rel == "測試 資料夾/子" && i.is_dir));
        fs.rename("測試 資料夾/週報.md", "測試 資料夾/改名.md")
            .unwrap();
        assert_eq!(
            fs.rename("測試 資料夾/改名.md", "測試 資料夾/子")
                .unwrap_err(),
            DavError::Exists
        );
        assert_eq!(
            fs.stat("測試 資料夾/週報.md").unwrap_err(),
            DavError::NotFound
        );
        // 連線斷掉：下一個操作自動重新連線。
        let old = fs.live.lock().unwrap().clone().unwrap();
        tauri::async_runtime::block_on(old.handle.disconnect(
            russh::Disconnect::ByApplication,
            "",
            "",
        ))
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(fs.stat("測試 資料夾/改名.md").is_ok());
        fs.delete("測試 資料夾").unwrap();
        assert_eq!(fs.stat("測試 資料夾").unwrap_err(), DavError::NotFound);
    }
}
