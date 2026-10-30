//! 遠端工作區：直接編輯 NAS（Synology、QNAP、Nextcloud…）上的筆記（WebDAV），
//! 或 Linux 主機上的檔案（SSH，見 `ssh.rs`）。兩種連線共用這裡的指令、輪詢與狀態，
//! 只有實際的檔案操作（`RemoteFs`）不同。
//!
//! - 前端用 `webdav://<連線代號>/路徑` 表示遠端檔案；這裡換算成實際的網址。
//! - 存檔用 `PUT` 加 `If-Match: <ETag>`：遠端在開啟後被改過時伺服器回 412，前端顯示衝突處理。
//!   新檔案用 `If-None-Match: *`，不會蓋掉別人剛建立的同名檔案。
//! - 每 30 秒比對已開啟檔案的 ETag，有變動時送出和本機監看相同的 `file-changed` 事件。
//! - 預設只允許 HTTPS；區域網路內的 HTTP 要使用者另外確認。
//! - 密碼存在 Windows 認證管理員（其他平台只記在這次開啟期間的記憶體裡），不會傳給前端。

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use quick_xml::events::Event;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::files::{decode, OpenedFile, SaveOutcome};
use crate::io::offline;
use crate::workspace::{is_doc, natural_cmp, validate_name, Entry, FileItem, FolderInfo};

pub const SCHEME: &str = "webdav://";
/// 版本標記未知（伺服器沒給 ETag）：存檔時只要求檔案還在，不比對版本。
pub(crate) const ANY_VERSION: &str = "*";
const KEYRING_SERVICE: &str = "md-editor-webdav";
const POLL_INTERVAL: Duration = Duration::from_secs(30);
const MAX_FILES: usize = 5000;
/// 預覽遠端圖片的大小上限。
const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
/// Ctrl+P 列出遠端檔案時：最多幾層、最多查幾個資料夾、最多處理幾個項目、同時送出幾個請求。
/// 惡意或設定錯誤的伺服器可能回傳無限多層或大量的項目，所以都設上限。
const LIST_MAX_DEPTH: usize = 6;
const LIST_MAX_DIRS: usize = 2_000;
const LIST_MAX_ENTRIES: usize = 100_000;
const LIST_WORKERS: usize = 4;

pub(crate) mod ssh;
#[cfg(test)]
mod tests;
mod webdav;

pub use webdav::*;

// ---- 錯誤 -------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub enum DavError {
    Unauthorized,
    NotFound,
    /// 412：遠端的內容和我們上次讀到的不同。
    Changed,
    /// 目的地已經存在（新增、改名時）。
    Exists,
    Network(String),
    Http(u16),
    /// 登入成功，但沒有權限做這件事（SSH）。
    Forbidden,
    /// 伺服器回報的其他錯誤（SSH）。
    Other(String),
}

impl DavError {
    pub(crate) fn message(&self, what: &str) -> String {
        match self {
            DavError::Unauthorized => tr!("{what}：帳號或密碼不正確，或沒有權限", what = what),
            DavError::NotFound => tr!("{what}：遠端找不到這個項目", what = what),
            DavError::Changed => tr!("{what}：遠端的檔案已被其他人修改", what = what),
            DavError::Exists => tr!("{what}：已經有同名的項目", what = what),
            // 和本機網路磁碟一樣的開頭，前端會顯示「無法連線」的提示並保留內容。
            DavError::Network(e) => tr!(
                "{offline}：{what}（{e}）",
                offline = offline(),
                what = what,
                e = e
            ),
            DavError::Http(code) => tr!("{what}：伺服器回應 {code}", what = what, code = code),
            DavError::Forbidden => tr!("{what}：沒有權限", what = what),
            DavError::Other(e) => tr!("{what}：{e}", what = what, e = e),
        }
    }
}

// ---- 網址處理 ---------------------------------------------------------------

/// 網址中的一段路徑：英數與 `-._~` 以外的位元組都轉成 `%XX`。
fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub(crate) fn decode_percent(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 把網址的路徑部分統一編碼（使用者輸入的 `https://nas/筆記/` 或已經編碼過的都可以）。
fn encode_base(url: &str) -> String {
    let scheme_end = url.find("://").map(|i| i + 3).unwrap_or(0);
    let prefix = match url[scheme_end..].find('/') {
        Some(i) => &url[..scheme_end + i],
        None => url,
    };
    let path = &url[prefix.len()..];
    let segments: Vec<String> = decode_percent(path)
        .split('/')
        .filter(|s| !s.is_empty())
        .map(encode_segment)
        .collect();
    if segments.is_empty() {
        format!("{prefix}/")
    } else {
        format!("{prefix}/{}/", segments.join("/"))
    }
}

/// 網址的路徑部分（`https://nas:5006/筆記/` → `/筆記/`）。
fn url_path(url: &str) -> &str {
    let after_scheme = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    after_scheme
        .find('/')
        .map(|i| &after_scheme[i..])
        .unwrap_or("/")
}

/// 網址的主機名稱，用和實際連線相同的規則解析（`http://壞人.com#@10.0.0.1/` 的主機是 `壞人.com`）。
/// 解析不了時回傳空字串。
pub(crate) fn host_of(url: &str) -> String {
    let Ok(uri) = url.trim().parse::<ureq::http::Uri>() else {
        return String::new();
    };
    let host = uri.host().unwrap_or("");
    host.strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host)
        .to_string()
}

/// 區域網路內的位址（只有這些才允許用沒有加密的 HTTP）。
pub(crate) fn is_private_host(host: &str) -> bool {
    if host == "localhost"
        || host.ends_with(".local")
        || host.ends_with(".lan")
        || host.ends_with(".home.arpa")
    {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
            std::net::IpAddr::V6(v6) => {
                v6.is_loopback()
                    || (v6.segments()[0] & 0xfe00) == 0xfc00
                    || (v6.segments()[0] & 0xffc0) == 0xfe80
            }
        };
    }
    // 沒有點的主機名稱（例如 NAS 的電腦名稱）也是區域網路。但全是數字或 `0x` 開頭的寫法
    // （例如 `134744072`、`0x08080808`）會被系統當成 IPv4 位址，可能是網際網路上的主機。
    !host.contains('.') && !looks_numeric(host)
}

/// 系統會把它當成數字寫法的 IPv4 位址（十進位、八進位或十六進位）。
fn looks_numeric(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    lower.starts_with("0x") || lower.bytes().all(|b| b.is_ascii_digit())
}

/// 檢查並整理使用者輸入的網址：補上結尾的 `/`，HTTP 只在區域網路且使用者同意時可以用。
pub fn normalize_url(input: &str, allow_http: bool) -> Result<String, String> {
    let url = input.trim();
    let lower = url.to_ascii_lowercase();
    let host = host_of(url);
    let host = host.as_str();
    // 網址裡的 `?`、`#` 在 WebDAV 用不到，卻可能讓「這是哪一台主機」被誤判。
    if host.is_empty() || url.contains(['?', '#']) {
        return Err(tr!("網址格式不正確，例如：https://nas.local:5006/筆記/"));
    }
    if lower.starts_with("http://") {
        if !is_private_host(host) {
            return Err(tr!(
                "只能用 HTTPS 連線到網際網路上的伺服器（HTTP 不加密，密碼可能被看到）"
            ));
        }
        if !allow_http {
            return Err("HTTP_CONFIRM".into());
        }
    } else if !lower.starts_with("https://") {
        return Err(tr!("網址要以 https:// 開頭"));
    }
    Ok(if url.ends_with('/') {
        url.to_string()
    } else {
        format!("{url}/")
    })
}

// ---- WebDAV 用戶端 ------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    /// 相對於連線根目錄的路徑，以 `/` 分隔，不含開頭與結尾的 `/`。
    pub(crate) rel: String,
    pub(crate) is_dir: bool,
    pub(crate) etag: Option<String>,
    /// 檔案樹上滑鼠停留時顯示的資訊（大小、權限、修改時間）。
    pub(crate) detail: Option<String>,
}

impl Item {
    pub(crate) fn new(rel: String, is_dir: bool, etag: Option<String>) -> Self {
        Item {
            rel,
            is_dir,
            etag,
            detail: None,
        }
    }

    pub(crate) fn with_detail(mut self, detail: String) -> Self {
        self.detail = Some(detail);
        self
    }
}

/// 遠端操作的結果。都是非同步的：等待網路時不佔住執行緒（SSH 本身就是非同步的；
/// WebDAV 用的 HTTP 程式庫是同步的，在 blocking 執行緒上執行）。
pub type FsFuture<'a, T> = futures_util::future::BoxFuture<'a, Result<T, DavError>>;

/// 遠端資料夾的檔案操作（WebDAV 與 SSH 各自實作）。路徑都相對於連線的根目錄，以 `/` 分隔。
pub trait RemoteFs: Send + Sync {
    fn stat<'a>(&'a self, rel: &'a str) -> FsFuture<'a, Item>;
    /// 資料夾的直接子項目（可能也包含資料夾本身，呼叫端會略過）。
    fn list<'a>(&'a self, rel: &'a str) -> FsFuture<'a, Vec<Item>>;
    fn get<'a>(&'a self, rel: &'a str) -> FsFuture<'a, (Vec<u8>, Option<String>)>;
    /// 上傳。`if_match` 為 `Some` 時只在遠端的版本相同時寫入（否則 `Changed`）；
    /// `None` 時只在檔案不存在時建立（已存在也是 `Changed`）。回傳新的版本標記。
    fn put<'a>(
        &'a self,
        rel: &'a str,
        bytes: &'a [u8],
        if_match: Option<&'a str>,
    ) -> FsFuture<'a, Option<String>>;
    fn mkdir<'a>(&'a self, rel: &'a str) -> FsFuture<'a, ()>;
    /// 改名或搬移；目的地已經存在時失敗。
    fn rename<'a>(&'a self, from: &'a str, to: &'a str) -> FsFuture<'a, ()>;
    /// 刪除檔案或整個資料夾。
    fn delete<'a>(&'a self, rel: &'a str) -> FsFuture<'a, ()>;
}

// ---- 連線設定與狀態 -----------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Conn {
    pub(crate) id: String,
    pub(crate) name: String,
    /// 給人看的位置（WebDAV 是網址；SSH 是 `ssh://帳號@主機/路徑`）。
    pub(crate) url: String,
    pub(crate) username: String,
    #[serde(default)]
    pub(crate) allow_http: bool,
    /// SSH 連線的設定；沒有就是 WebDAV。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) ssh: Option<crate::ssh::SshTarget>,
}

impl Conn {
    /// 這個連線的檔案路徑開頭（`webdav://代號` 或 `ssh://代號`）。
    pub(crate) fn prefix(&self) -> String {
        let scheme = if self.ssh.is_some() {
            crate::ssh::SCHEME
        } else {
            SCHEME
        };
        format!("{scheme}{}", self.id)
    }
}

struct Session {
    conn: Conn,
    client: Box<dyn RemoteFs>,
}

#[derive(Default)]
pub struct Dav {
    session: Mutex<Option<std::sync::Arc<Session>>>,
    /// 這次開啟期間記住的密碼（無法使用系統的認證管理員時）。
    passwords: Mutex<HashMap<String, String>>,
    /// 已開啟的遠端檔案：路徑 → 上次讀寫時的 ETag。
    etags: Mutex<HashMap<String, String>>,
    /// 從伺服器讀到、之後還沒存過檔的內容。第一次存檔時放進版本記錄，
    /// 和本機檔案一樣保留「存檔前的內容」。
    read: Mutex<HashMap<String, String>>,
    /// 已經通知過前端的 ETag（同一個變動只通知一次）。
    notified: Mutex<HashMap<String, String>>,
    polling: AtomicBool,
}

/// 前端關掉了遠端檔案的分頁：不再輪詢它有沒有被改過，也不再留著讀到的內容
/// （原本要等到刪除、重新連線才會清掉，開過的檔案越多，每 30 秒要檢查的越多）。
#[tauri::command]
pub fn dav_close(path: String, dav: State<'_, Dav>) {
    dav.etags.lock().unwrap().remove(&path);
    dav.read.lock().unwrap().remove(&path);
    dav.notified.lock().unwrap().remove(&path);
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("webdav.json"))
        .map_err(|e| e.to_string())
}

pub(crate) fn load_conns(app: &AppHandle) -> Vec<Conn> {
    config_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub(crate) fn save_conns(app: &AppHandle, conns: &[Conn]) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(conns).map_err(|e| e.to_string())?;
    crate::files::write_atomic(&path, json.as_bytes()).map_err(|e| e.to_string())
}

fn saved_password(id: &str) -> Option<String> {
    crate::secrets::get(KEYRING_SERVICE, id)
}

fn remember_password(id: &str, password: &str) -> bool {
    crate::secrets::set(KEYRING_SERVICE, id, password)
}

fn forget_password(id: &str) {
    crate::secrets::forget(KEYRING_SERVICE, id);
}

/// 遠端資料夾（WebDAV 或 SSH）的路徑。
pub fn is_remote_path(path: &str) -> bool {
    path.starts_with(SCHEME) || path.starts_with(crate::ssh::SCHEME)
}

/// `webdav://<代號>/<路徑>`（或 `ssh://`）→ (`webdav://<代號>`, 路徑)。
fn split(path: &str) -> Option<(&str, &str)> {
    let scheme = [SCHEME, crate::ssh::SCHEME]
        .into_iter()
        .find(|s| path.starts_with(s))?;
    let rest = &path[scheme.len()..];
    let (id, rel) = rest.split_once('/').unwrap_or((rest, ""));
    if id.is_empty() || rel.split('/').any(|s| s == ".." || s == ".") {
        return None;
    }
    Some((&path[..scheme.len() + id.len()], rel.trim_matches('/')))
}

/// 連線根目錄是 `webdav://<代號>`（結尾沒有 `/`，和其他路徑的「上一層」算法一致）。
fn join(prefix: &str, rel: &str) -> String {
    if rel.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}/{rel}")
    }
}

fn name_of(rel: &str) -> String {
    rel.rsplit('/').next().unwrap_or(rel).to_string()
}

impl Dav {
    /// 目前連線中、而且 `path` 屬於這個連線時，回傳連線與相對路徑。
    pub fn allows(&self, path: &str) -> bool {
        self.resolve(path).is_ok()
    }

    fn resolve(&self, path: &str) -> Result<(std::sync::Arc<Session>, String), String> {
        let (prefix, rel) = split(path).ok_or_else(|| tr!("遠端路徑不正確"))?;
        let session = self
            .session
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| tr!("還沒有連線到遠端資料夾"))?;
        if session.conn.prefix() != prefix {
            return Err(tr!("這個檔案屬於另一個遠端連線，請先重新連線"));
        }
        Ok((session, rel.to_string()))
    }

    /// 目前連著 SSH 時，給內嵌終端機用的 (帳號, 主機設定)。
    pub fn ssh_target(&self) -> Option<(String, crate::ssh::SshTarget)> {
        let session = self.session.lock().unwrap().clone()?;
        let target = session.conn.ssh.clone()?;
        Some((session.conn.username.clone(), target))
    }

    /// 改開本機資料夾時中斷遠端連線。
    pub fn disconnect(&self) {
        *self.session.lock().unwrap() = None;
        self.etags.lock().unwrap().clear();
        self.read.lock().unwrap().clear();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnInfo {
    id: String,
    /// `webdav` 或 `ssh`。
    kind: &'static str,
    name: String,
    url: String,
    username: String,
    /// 系統的認證管理員裡有沒有存密碼。
    has_password: bool,
}

#[tauri::command]
pub fn dav_connections(app: AppHandle) -> Vec<ConnInfo> {
    load_conns(&app)
        .into_iter()
        .map(|c| ConnInfo {
            has_password: saved_password(&c.id).is_some(),
            kind: if c.ssh.is_some() { "ssh" } else { "webdav" },
            id: c.id,
            name: c.name,
            url: c.url,
            username: c.username,
        })
        .collect()
}

pub(crate) fn folder_info(conn: &Conn) -> FolderInfo {
    FolderInfo::new(conn.prefix(), conn.name.clone())
}

/// 記住剛輸入的密碼：選了「記住」而且系統能保存時存進認證管理員，
/// 否則只記在這次開啟期間的記憶體裡（重新連線時不必再問）。
pub(crate) fn keep_password(dav: &Dav, id: &str, password: String, remember: bool) {
    if !(remember && remember_password(id, &password)) {
        if !remember {
            forget_password(id);
        }
        dav.passwords
            .lock()
            .unwrap()
            .insert(id.to_string(), password);
    }
}

/// 連線（第一次連線或修改設定）。成功後設為目前的工作區。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn dav_connect(
    app: AppHandle,
    url: String,
    username: String,
    password: String,
    remember: bool,
    allow_http: bool,
    dav: State<'_, Dav>,
) -> Result<FolderInfo, String> {
    let base = normalize_url(&url, allow_http)?;
    let conns = load_conns(&app);
    let id = conns
        .iter()
        .find(|c| c.url == base && c.username == username)
        .map(|c| c.id.clone())
        .unwrap_or_else(|| {
            let mut b = [0u8; 4];
            let _ = getrandom::fill(&mut b);
            b.iter().map(|x| format!("{x:02x}")).collect()
        });
    let name = {
        let path = decode_percent(url_path(&base));
        let last = path
            .trim_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("")
            .to_string();
        if last.is_empty() {
            host_of(&base)
        } else {
            last
        }
    };
    let conn = Conn {
        id,
        name,
        url: base,
        username,
        allow_http,
        ssh: None,
    };
    open_session(&app, &dav, conn.clone(), password.clone()).await?;
    keep_password(&dav, &conn.id, password, remember);
    let mut conns: Vec<Conn> = conns.into_iter().filter(|c| c.id != conn.id).collect();
    conns.insert(0, conn.clone());
    save_conns(&app, &conns)?;
    Ok(folder_info(&conn))
}

/// 用存好的密碼重新連線（重新開啟 app、從最近清單開啟時）。沒有密碼時回傳 `NEED_PASSWORD`
/// （SSH 會先試金鑰，都不行才要密碼）。`trust` 是使用者確認過的 SSH 主機金鑰指紋。
#[tauri::command]
pub async fn dav_reconnect(
    app: AppHandle,
    id: String,
    password: Option<String>,
    remember: Option<bool>,
    trust: Option<String>,
    dav: State<'_, Dav>,
) -> Result<FolderInfo, String> {
    let typed = password.is_some();
    let conn = load_conns(&app)
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| tr!("找不到這個遠端連線，請重新設定"))?;
    let password = password
        .or_else(|| dav.passwords.lock().unwrap().get(&id).cloned())
        .or_else(|| saved_password(&id));
    if conn.ssh.is_some() {
        crate::ssh::reconnect(&app, &dav, conn.clone(), password.clone(), trust).await?;
    } else {
        let password = password.clone().ok_or("NEED_PASSWORD")?;
        open_session(&app, &dav, conn.clone(), password).await?;
    }
    if let Some(password) = password {
        // 剛輸入的密碼：照使用者的選擇記住（或不記住）。
        if typed && remember == Some(true) {
            remember_password(&id, &password);
        }
        dav.passwords.lock().unwrap().insert(id, password);
    }
    Ok(folder_info(&conn))
}

async fn open_session(
    app: &AppHandle,
    dav: &Dav,
    conn: Conn,
    password: String,
) -> Result<(), String> {
    let base = conn.url.clone();
    let user = conn.username.clone();
    let (client, conn) = crate::io::blocking(move || {
        let client = Client::new(&base, &user, &password);
        match client.stat("") {
            Ok(item) if item.is_dir => Ok((client, conn)),
            Ok(_) => Err(tr!("這個網址不是資料夾")),
            Err(DavError::Http(code)) if code == 405 || code == 501 => Err(tr!(
                "這個網址不是 WebDAV 伺服器（請確認 NAS 已開啟 WebDAV 服務與連接埠）"
            )),
            Err(e) => Err(e.message(&tr!("無法連線"))),
        }
    })
    .await?;
    install(app, dav, conn, Box::new(client));
    Ok(())
}

/// 換成剛連上的遠端資料夾。
pub(crate) fn install(app: &AppHandle, dav: &Dav, conn: Conn, client: Box<dyn RemoteFs>) {
    *dav.session.lock().unwrap() = Some(std::sync::Arc::new(Session { conn, client }));
    dav.etags.lock().unwrap().clear();
    dav.read.lock().unwrap().clear();
    dav.notified.lock().unwrap().clear();
    // 遠端工作區開著時，本機的工作區關閉。
    app.state::<crate::workspace::Workspace>().clear();
    app.state::<crate::watch::Watcher>().stop_workspace();
    start_polling(app);
}

/// 切換到本機資料夾時中斷遠端連線。
#[tauri::command]
pub fn dav_disconnect(dav: State<'_, Dav>) {
    dav.disconnect();
}

#[tauri::command]
pub fn dav_forget(app: AppHandle, id: String, dav: State<'_, Dav>) -> Result<(), String> {
    forget_password(&id);
    dav.passwords.lock().unwrap().remove(&id);
    let conns: Vec<Conn> = load_conns(&app)
        .into_iter()
        .filter(|c| c.id != id)
        .collect();
    save_conns(&app, &conns)
}

#[tauri::command]
pub async fn dav_list(path: String, dav: State<'_, Dav>) -> Result<Vec<Entry>, String> {
    let (session, rel) = dav.resolve(&path)?;
    let id = session.conn.prefix();
    crate::io::timed(async move {
        let items = session
            .client
            .list(&rel)
            .await
            .map_err(|e| e.message(&tr!("無法讀取資料夾")))?;
        let mut entries: Vec<Entry> = items
            .into_iter()
            .filter(|i| i.rel != rel && !i.rel.is_empty())
            .filter(|i| !name_of(&i.rel).starts_with('.'))
            .filter(|i| i.is_dir || is_doc(std::path::Path::new(&i.rel)))
            .map(|i| Entry::new(name_of(&i.rel), join(&id, &i.rel), i.is_dir).with_detail(i.detail))
            .collect();
        entries.sort_by(|a, b| {
            b.is_dir()
                .cmp(&a.is_dir())
                .then_with(|| natural_cmp(a.name(), b.name()))
        });
        Ok(entries)
    })
    .await
}

/// 一層一層列出遠端的文件（同一層的資料夾同時查詢，最多 `LIST_WORKERS` 個），回傳相對路徑。
/// `list` 查詢一個資料夾的直接子項目（Depth 1），失敗時回傳 `None`（略過那個資料夾）。
async fn walk_remote<F, Fut>(list: F) -> Vec<String>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Option<Vec<Item>>>,
{
    use futures_util::StreamExt;
    let mut files = Vec::new();
    let mut level = vec![String::new()];
    let mut seen = std::collections::HashSet::from([String::new()]);
    let mut dirs = 0;
    let mut entries = 0;
    for depth in 0..=LIST_MAX_DEPTH {
        level.truncate(LIST_MAX_DIRS.saturating_sub(dirs));
        if level.is_empty() {
            break;
        }
        dirs += level.len();
        let queries: Vec<Fut> = level.iter().map(|dir| list(dir.clone())).collect();
        let results: Vec<Option<Vec<Item>>> = futures_util::stream::iter(queries)
            .buffered(LIST_WORKERS)
            .collect()
            .await;
        let mut next = Vec::new();
        for (dir, items) in level.iter().zip(results) {
            for i in items
                .into_iter()
                .flatten()
                .filter(|i| &i.rel != dir && !name_of(&i.rel).starts_with('.'))
            {
                entries += 1;
                if entries > LIST_MAX_ENTRIES {
                    return files;
                }
                if i.is_dir {
                    // 同一個資料夾只查一次（伺服器回傳奇怪的連結時也不會繞圈子）。
                    if depth < LIST_MAX_DEPTH && seen.insert(i.rel.clone()) {
                        next.push(i.rel);
                    }
                } else if is_doc(std::path::Path::new(&i.rel)) && files.len() < MAX_FILES {
                    files.push(i.rel);
                }
            }
        }
        level = next;
    }
    files
}

/// 遠端資料夾內所有文件（給 Ctrl+P）。逐層列出，最多 6 層。
#[tauri::command]
pub async fn dav_list_files(dav: State<'_, Dav>) -> Result<Vec<FileItem>, String> {
    let session = dav
        .session
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| tr!("還沒有連線到遠端資料夾"))?;
    crate::io::timed_for(Duration::from_secs(60), async move {
        let id = session.conn.prefix();
        let rels = walk_remote(|dir| {
            let session = session.clone();
            async move { session.client.list(&dir).await.ok() }
        })
        .await;
        Ok(rels
            .into_iter()
            .map(|rel| FileItem::new(join(&id, &rel), rel))
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn dav_read(path: String, dav: State<'_, Dav>) -> Result<OpenedFile, String> {
    let (session, rel) = dav.resolve(&path)?;
    let (bytes, etag) = crate::io::timed(async move {
        session
            .client
            .get(&rel)
            .await
            .map_err(|e| e.message(&tr!("無法讀取")))
    })
    .await?;
    if let Some(why) = crate::files::not_text_reason(&bytes) {
        return Err(tr!("「{name}」{why}", name = name_of(&path), why = why));
    }
    let (text, _, encoding) = decode(&bytes);
    // 伺服器沒給 ETag 時記成 `*`：存檔時改用 `If-Match: *`（檔案還在就覆蓋），
    // 不然會被當成新檔案（`If-None-Match: *`），每次存檔都回報衝突。
    dav.etags
        .lock()
        .unwrap()
        .insert(path.clone(), etag.unwrap_or_else(|| ANY_VERSION.into()));
    dav.read.lock().unwrap().insert(path.clone(), text.clone());
    dav.notified.lock().unwrap().remove(&path);
    Ok(OpenedFile::new(
        path.clone(),
        name_of(&path),
        text,
        encoding,
    ))
}

/// 存檔。遠端在上次讀取後被改過時回傳 `Conflict`（除非 `force`）。新檔案不會覆蓋遠端已有的檔案。
#[tauri::command]
pub async fn dav_write(
    app: AppHandle,
    path: String,
    text: String,
    force: Option<bool>,
    dav: State<'_, Dav>,
) -> Result<SaveOutcome, String> {
    let (session, rel) = dav.resolve(&path)?;
    let known = dav.etags.lock().unwrap().get(&path).cloned();
    let force = force.unwrap_or(false);
    let p = path.clone();
    let t = text.clone();
    let last_read = dav.read.lock().unwrap().get(&path).cloned();
    let result = crate::io::timed(async move {
        let (if_match, before) = if force {
            // 使用者確認要覆蓋：先取回遠端目前的內容（放進版本記錄），
            // 再用它的 ETag 覆蓋（檔案不存在時就建立）。
            match session.client.get(&rel).await {
                Ok((bytes, etag)) => {
                    let etag = match etag {
                        Some(etag) => Some(etag),
                        None => session.client.stat(&rel).await.ok().and_then(|i| i.etag),
                    }
                    .or_else(|| Some(ANY_VERSION.into()));
                    (etag, Some(decode(&bytes).0))
                }
                Err(_) => (
                    session.client.stat(&rel).await.ok().and_then(|i| i.etag),
                    None,
                ),
            }
        } else {
            (known, last_read)
        };
        match session
            .client
            .put(&rel, t.as_bytes(), if_match.as_deref())
            .await
        {
            Ok(etag) => Ok(Ok((etag, before))),
            Err(DavError::Changed) => match session.client.get(&rel).await {
                Ok((bytes, _)) => Ok(Err(decode(&bytes).0)),
                // 遠端的檔案被刪掉了：和本機檔案一樣直接重新建立（建立時有人搶先建了同名檔才算衝突）。
                Err(DavError::NotFound) => match session.client.put(&rel, t.as_bytes(), None).await
                {
                    Ok(etag) => Ok(Ok((etag, None))),
                    Err(DavError::Changed) => match session.client.get(&rel).await {
                        Ok((bytes, _)) => Ok(Err(decode(&bytes).0)),
                        Err(e) => Err(e.message(&tr!("無法儲存「{name}」", name = name_of(&rel)))),
                    },
                    Err(e) => Err(e.message(&tr!("無法儲存「{name}」", name = name_of(&rel)))),
                },
                // 讀不到遠端的版本（例如網路不穩）：回報錯誤，不要拿空白的內容當成「伺服器版本」。
                Err(e) => Err(e.message(&tr!("無法儲存「{name}」", name = name_of(&rel)))),
            },
            Err(e) => Err(e.message(&tr!("無法儲存「{name}」", name = name_of(&rel)))),
        }
    })
    .await?;
    match result {
        Ok((etag, before)) => {
            dav.etags
                .lock()
                .unwrap()
                .insert(path.clone(), etag.unwrap_or_else(|| ANY_VERSION.into()));
            dav.notified.lock().unwrap().remove(&path);
            dav.read.lock().unwrap().remove(&path);
            // 遠端檔案也在本機留版本記錄（斷線時還能找回）。
            crate::history::on_save(
                &app,
                std::path::Path::new(&p),
                before.as_deref().map(str::as_bytes),
                &text,
            );
            Ok(SaveOutcome::saved(path.clone(), name_of(&path)))
        }
        Err(disk_text) => Ok(SaveOutcome::conflict(
            path.clone(),
            name_of(&path),
            disk_text,
        )),
    }
}

#[tauri::command]
pub async fn dav_create(
    parent: String,
    name: String,
    is_dir: bool,
    dav: State<'_, Dav>,
) -> Result<String, String> {
    let (session, rel) = dav.resolve(&parent)?;
    let name = validate_name(&name)?.to_string();
    let target = if rel.is_empty() {
        name.clone()
    } else {
        format!("{rel}/{name}")
    };
    let id = session.conn.prefix();
    let t = target.clone();
    crate::io::timed(async move {
        if is_dir {
            session.client.mkdir(&t).await
        } else {
            session.client.put(&t, b"", None).await.map(|_| ())
        }
        .map_err(|e| match e {
            DavError::Changed => DavError::Exists.message(&tr!("無法建立「{name}」", name = name)),
            e => e.message(&tr!("無法建立「{name}」", name = name)),
        })
    })
    .await?;
    Ok(join(&id, &target))
}

/// 上傳檔案最大的大小。
const MAX_UPLOAD: usize = 200 * 1024 * 1024;

/// 檔名已經存在時，改用「名稱 (2).副檔名」。
pub(crate) fn numbered(name: &str, n: u32) -> String {
    if n < 2 {
        return name.to_string();
    }
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem} ({n}).{ext}"),
        _ => format!("{name} ({n})"),
    }
}

/// 從電腦上傳檔案到遠端資料夾（拖曳到檔案樹，或「從電腦上傳檔案…」）。
/// 原始位元組放在請求本文，資料夾與檔名放在標頭（百分比編碼）；同名時自動加上編號，不覆蓋。
#[tauri::command]
pub async fn dav_upload(
    request: tauri::ipc::Request<'_>,
    dav: State<'_, Dav>,
) -> Result<String, String> {
    let header = |key: &str| {
        request
            .headers()
            .get(key)
            .and_then(|v| v.to_str().ok())
            .map(decode_percent)
            .ok_or_else(|| tr!("上傳的資料不正確"))
    };
    let dir = header("x-dir")?;
    let name = validate_name(&header("x-name")?)?.to_string();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(tr!("上傳的資料不正確"));
    };
    if bytes.len() > MAX_UPLOAD {
        return Err(tr!(
            "「{name}」超過 200 MB，請改用其他方式傳送",
            name = name
        ));
    }
    let bytes = bytes.clone();
    let (session, rel) = dav.resolve(&dir)?;
    let id = session.conn.prefix();
    let target = crate::io::timed(async move {
        for n in 1..100 {
            let file = numbered(&name, n);
            let target = if rel.is_empty() {
                file
            } else {
                format!("{rel}/{file}")
            };
            match session.client.put(&target, &bytes, None).await {
                Ok(_) => return Ok(target),
                Err(DavError::Changed) | Err(DavError::Exists) => continue,
                Err(e) => return Err(e.message(&tr!("無法上傳「{name}」", name = name))),
            }
        }
        Err(tr!("無法上傳「{name}」：同名的檔案太多", name = name))
    })
    .await?;
    Ok(join(&id, &target))
}

/// 把遠端檔案下載到電腦：選好存放位置後寫入。取消時回傳 null。
#[tauri::command]
pub async fn dav_download(path: String, dav: State<'_, Dav>) -> Result<Option<String>, String> {
    let (session, rel) = dav.resolve(&path)?;
    let name = name_of(&rel);
    let Some(dest) = rfd::AsyncFileDialog::new()
        .set_title(tr!("下載到電腦"))
        .set_file_name(&name)
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let dest = dest.path().to_path_buf();
    let (bytes, _) = crate::io::timed(async {
        session
            .client
            .get(&rel)
            .await
            .map_err(|e| e.message(&tr!("無法下載「{name}」", name = name)))
    })
    .await?;
    crate::io::blocking(move || {
        std::fs::write(&dest, bytes).map_err(|e| crate::io::describe(&e, &tr!("無法存檔")))?;
        Ok(Some(crate::files::path_string(&dest)))
    })
    .await
}

#[tauri::command]
pub async fn dav_rename(
    app: AppHandle,
    path: String,
    new_name: String,
    dav: State<'_, Dav>,
) -> Result<String, String> {
    let (session, rel) = dav.resolve(&path)?;
    if rel.is_empty() {
        return Err(tr!("不能重新命名遠端資料夾本身"));
    }
    let new_name = validate_name(&new_name)?.to_string();
    let parent = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    let target = if parent.is_empty() {
        new_name
    } else {
        format!("{parent}/{new_name}")
    };
    let id = session.conn.prefix();
    let (from, to) = (rel.clone(), target.clone());
    crate::io::timed(async move {
        session
            .client
            .rename(&from, &to)
            .await
            .map_err(|e| e.message(&tr!("無法重新命名")))
    })
    .await?;
    let new_path = join(&id, &target);
    // 已開啟檔案的 ETag 跟著搬過去。
    let mut etags = dav.etags.lock().unwrap();
    let moved: Vec<(String, String)> = etags
        .iter()
        .filter(|(k, _)| *k == &path || k.starts_with(&format!("{path}/")))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    for (k, v) in moved {
        etags.remove(&k);
        etags.insert(format!("{new_path}{}", &k[path.len()..]), v);
    }
    crate::history::on_rename(
        &app,
        std::path::Path::new(&path),
        std::path::Path::new(&new_path),
    );
    Ok(new_path)
}

/// 刪除（遠端沒有資源回收筒，無法還原；前端會先確認）。
#[tauri::command]
pub async fn dav_delete(path: String, dav: State<'_, Dav>) -> Result<(), String> {
    let (session, rel) = dav.resolve(&path)?;
    if rel.is_empty() {
        return Err(tr!("不能刪除遠端資料夾本身"));
    }
    crate::io::timed(async move {
        session
            .client
            .delete(&rel)
            .await
            .map_err(|e| e.message(&tr!("無法刪除")))
    })
    .await?;
    dav.etags.lock().unwrap().remove(&path);
    Ok(())
}

/// 把貼上的圖片存到遠端文件旁的 `assets/`。
#[tauri::command]
pub async fn dav_save_image(
    doc_path: String,
    data_base64: String,
    ext: String,
    dav: State<'_, Dav>,
) -> Result<String, String> {
    let (session, rel) = dav.resolve(&doc_path)?;
    let bytes = crate::images::decode_image(&data_base64, &ext)?;
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    let dir = rel
        .rsplit_once('/')
        .map(|(p, _)| p.to_string())
        .unwrap_or_default();
    let stem = name_of(&rel);
    let stem = stem
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(&stem)
        .to_string();
    crate::io::timed(async move {
        let assets = if dir.is_empty() {
            "assets".to_string()
        } else {
            format!("{dir}/assets")
        };
        match session.client.mkdir(&assets).await {
            Ok(()) | Err(DavError::Exists) => {}
            Err(e) => return Err(e.message(&tr!("無法建立 assets 資料夾"))),
        }
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        for n in 1..100 {
            let name = if n == 1 {
                format!("{stem}-{stamp}.{ext}")
            } else {
                format!("{stem}-{stamp}-{n}.{ext}")
            };
            match session
                .client
                .put(&format!("{assets}/{name}"), &bytes, None)
                .await
            {
                Ok(_) => return Ok(format!("assets/{name}")),
                Err(DavError::Changed) => continue, // 同名檔案已存在
                Err(e) => return Err(e.message(&tr!("無法儲存圖片"))),
            }
        }
        Err(tr!("無法儲存圖片：同名檔案太多"))
    })
    .await
}

/// 自動完成連結時讀取另一份遠端文件的標題用：不記錄 ETag，不會被當成已開啟的檔案監看。
#[tauri::command]
pub async fn dav_peek(path: String, dav: State<'_, Dav>) -> Result<String, String> {
    let (session, rel) = dav.resolve(&path)?;
    if !is_doc(std::path::Path::new(&rel)) {
        return Err(tr!("只能讀取文件"));
    }
    let (bytes, _) = crate::io::timed(async move {
        session
            .client
            .get(&rel)
            .await
            .map_err(|e| e.message(&tr!("無法讀取")))
    })
    .await?;
    if bytes.len() as u64 > crate::workspace::PEEK_LIMIT {
        return Err(tr!("檔案太大"));
    }
    Ok(decode(&bytes).0)
}

/// 讀取遠端的圖片（給預覽顯示），回傳 data: 網址。
#[tauri::command]
pub async fn dav_image(path: String, dav: State<'_, Dav>) -> Result<String, String> {
    let (session, rel) = dav.resolve(&path)?;
    let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        _ => return Err(tr!("不是圖片")),
    };
    let (bytes, _) = crate::io::timed(async move {
        session
            .client
            .get(&rel)
            .await
            .map_err(|e| e.message(&tr!("無法讀取圖片")))
    })
    .await?;
    // 預覽用的圖片：太大的不載入（會變成好幾倍大的 data: 網址留在記憶體裡）。
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(tr!(
            "圖片超過 {mb} MB，不在預覽中顯示",
            mb = MAX_IMAGE_BYTES / 1024 / 1024
        ));
    }
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// 遠端連得到嗎（斷線後前端定時呼叫來偵測恢復）。
#[tauri::command]
pub async fn dav_probe(path: String, dav: State<'_, Dav>) -> Result<bool, String> {
    let Ok((session, _)) = dav.resolve(&path) else {
        return Ok(false);
    };
    Ok(crate::io::timed_for(Duration::from_secs(10), async move {
        Ok(session.client.stat("").await.is_ok())
    })
    .await
    .unwrap_or(false))
}

#[derive(Serialize, Clone)]
struct Changed {
    path: String,
    text: String,
}

/// 查詢已開啟的遠端檔案目前的 ETag（`None` 表示伺服器沒給）。
///
/// 同一個資料夾有兩個以上的檔案時，用一次 Depth 1 的 PROPFIND 查整個資料夾，不必每個檔案各送一次；
/// 在清單中找不到的檔案（例如伺服器的網址編碼和我們不同）再個別查詢，確認真的不見了才回報。
/// 資料夾查詢失敗（網路斷線等）時，那些檔案這次都不回報，下次再試。
async fn remote_etags(
    fs: &dyn RemoteFs,
    rels: &[String],
) -> HashMap<String, Result<Option<String>, DavError>> {
    let mut groups: std::collections::BTreeMap<&str, Vec<&String>> = Default::default();
    for rel in rels {
        let parent = rel.rsplit_once('/').map_or("", |(p, _)| p);
        groups.entry(parent).or_default().push(rel);
    }
    let mut out = HashMap::new();
    for (parent, files) in groups {
        let mut single: Vec<&String> = Vec::new();
        if files.len() >= 2 {
            match fs.list(parent).await {
                Ok(items) => {
                    let etags: HashMap<&str, &Option<String>> = items
                        .iter()
                        .filter(|i| !i.is_dir)
                        .map(|i| (i.rel.as_str(), &i.etag))
                        .collect();
                    for rel in files {
                        match etags.get(rel.as_str()) {
                            Some(etag) => {
                                out.insert(rel.clone(), Ok((*etag).clone()));
                            }
                            None => single.push(rel),
                        }
                    }
                }
                Err(DavError::NotFound) => single = files,
                Err(_) => {}
            }
        } else {
            single = files;
        }
        for rel in single {
            out.insert(rel.clone(), fs.stat(rel).await.map(|i| i.etag));
        }
    }
    out
}

/// 背景每 30 秒檢查已開啟的遠端檔案有沒有被改過。
fn start_polling(app: &AppHandle) {
    let dav = app.state::<Dav>();
    if dav.polling.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            let dav = app.state::<Dav>();
            let Some(session) = dav.session.lock().unwrap().clone() else {
                continue;
            };
            let open: Vec<(String, String, String)> = dav
                .etags
                .lock()
                .unwrap()
                .iter()
                .filter_map(|(path, etag)| {
                    let (prefix, rel) = split(path)?;
                    (prefix == session.conn.prefix())
                        .then(|| (path.clone(), rel.to_string(), etag.clone()))
                })
                .collect();
            let rels: Vec<String> = open.iter().map(|(_, rel, _)| rel.clone()).collect();
            let mut states = remote_etags(session.client.as_ref(), &rels).await;
            for (path, rel, etag) in open {
                let Some(state) = states.remove(&rel) else {
                    continue;
                };
                match state {
                    Ok(remote) => {
                        let Some(remote) = remote else { continue };
                        let already = dav.notified.lock().unwrap().get(&path) == Some(&remote);
                        if remote != etag && etag != ANY_VERSION && !already {
                            if let Ok((bytes, _)) = session.client.get(&rel).await {
                                dav.notified.lock().unwrap().insert(path.clone(), remote);
                                let _ = app.emit(
                                    "file-changed",
                                    Changed {
                                        path: path.clone(),
                                        text: decode(&bytes).0,
                                    },
                                );
                            }
                        }
                    }
                    Err(DavError::NotFound) => {
                        dav.etags.lock().unwrap().remove(&path);
                        #[derive(Serialize, Clone)]
                        struct Removed {
                            path: String,
                        }
                        let _ = app.emit("file-removed", Removed { path });
                    }
                    Err(_) => {} // 暫時連不上就下次再試
                }
            }
        }
    });
}
