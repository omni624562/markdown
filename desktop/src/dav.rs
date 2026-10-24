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
/// Ctrl+P 列出遠端檔案時：最多幾層、最多查幾個資料夾、最多處理幾個項目、同時送出幾個請求。
/// 惡意或設定錯誤的伺服器可能回傳無限多層或大量的項目，所以都設上限。
const LIST_MAX_DEPTH: usize = 6;
const LIST_MAX_DIRS: usize = 2_000;
const LIST_MAX_ENTRIES: usize = 100_000;
const LIST_WORKERS: usize = 4;

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

fn host_of(url: &str) -> &str {
    let after = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let authority = after.split('/').next().unwrap_or("");
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    if let Some(rest) = host_port.strip_prefix('[') {
        return rest.split(']').next().unwrap_or("");
    }
    host_port.split(':').next().unwrap_or("")
}

/// 區域網路內的位址（只有這些才允許用沒有加密的 HTTP）。
fn is_private_host(host: &str) -> bool {
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
    // 沒有點的主機名稱（例如 NAS 的電腦名稱）也是區域網路。
    !host.contains('.')
}

/// 檢查並整理使用者輸入的網址：補上結尾的 `/`，HTTP 只在區域網路且使用者同意時可以用。
pub fn normalize_url(input: &str, allow_http: bool) -> Result<String, String> {
    let url = input.trim();
    let lower = url.to_ascii_lowercase();
    let host = host_of(url);
    if host.is_empty() {
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
}

impl Item {
    pub(crate) fn new(rel: String, is_dir: bool, etag: Option<String>) -> Self {
        Item { rel, is_dir, etag }
    }
}

pub struct Client {
    base: String,
    auth: String,
    agent: ureq::Agent,
}

impl Client {
    pub fn new(base: &str, user: &str, password: &str) -> Self {
        let token = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
        let agent = ureq::Agent::config_builder()
            .tls_config(
                ureq::tls::TlsConfig::builder()
                    .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                    .build(),
            )
            .allow_non_standard_methods(true)
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_global(Some(Duration::from_secs(30)))
            .timeout_connect(Some(Duration::from_secs(10)))
            .user_agent(concat!("md-editor/", env!("CARGO_PKG_VERSION")))
            .build()
            .new_agent();
        Client {
            base: encode_base(base),
            auth: format!("Basic {token}"),
            agent,
        }
    }

    fn url(&self, rel: &str) -> String {
        let encoded: Vec<String> = rel
            .split('/')
            .filter(|s| !s.is_empty())
            .map(encode_segment)
            .collect();
        format!("{}{}", self.base, encoded.join("/"))
    }

    fn request(
        &self,
        method: &str,
        rel: &str,
        headers: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Result<ureq::http::Response<ureq::Body>, DavError> {
        let mut req = ureq::http::Request::builder()
            .method(method)
            .uri(self.url(rel))
            .header("Authorization", &self.auth);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let req = req
            .body(body.map(<[u8]>::to_vec).unwrap_or_default())
            .map_err(|e| DavError::Network(e.to_string()))?;
        let res = self
            .agent
            .run(req)
            .map_err(|e| DavError::Network(e.to_string()))?;
        match res.status().as_u16() {
            401 | 403 => Err(DavError::Unauthorized),
            404 => Err(DavError::NotFound),
            412 => Err(DavError::Changed),
            _ => Ok(res),
        }
    }

    fn propfind(&self, rel: &str, depth: u8) -> Result<Vec<Item>, DavError> {
        const BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>"#;
        let depth = depth.to_string();
        let mut res = self.request(
            "PROPFIND",
            rel,
            &[
                ("Depth", &depth),
                ("Content-Type", "application/xml; charset=utf-8"),
            ],
            Some(BODY.as_bytes()),
        )?;
        if res.status().as_u16() != 207 {
            return Err(DavError::Http(res.status().as_u16()));
        }
        let xml = res
            .body_mut()
            .with_config()
            .limit(32 * 1024 * 1024)
            .read_to_string()
            .map_err(|e| DavError::Network(e.to_string()))?;
        Ok(parse_multistatus(&xml, url_path(&self.base)))
    }

    fn get(&self, rel: &str) -> Result<(Vec<u8>, Option<String>), DavError> {
        let mut res = self.request("GET", rel, &[], None)?;
        if !res.status().is_success() {
            return Err(DavError::Http(res.status().as_u16()));
        }
        let etag = header_etag(&res);
        let bytes = res
            .body_mut()
            .with_config()
            .limit(64 * 1024 * 1024)
            .read_to_vec()
            .map_err(|e| DavError::Network(e.to_string()))?;
        Ok((bytes, etag))
    }

    /// 上傳。`if_match` 為 `Some` 時只在遠端的 ETag 相同時寫入；`None` 時只在檔案不存在時建立。
    fn put(
        &self,
        rel: &str,
        bytes: &[u8],
        if_match: Option<&str>,
    ) -> Result<Option<String>, DavError> {
        let header = match if_match {
            Some(etag) => ("If-Match", etag),
            None => ("If-None-Match", "*"),
        };
        let res = self.request("PUT", rel, &[header], Some(bytes))?;
        if !res.status().is_success() {
            return Err(DavError::Http(res.status().as_u16()));
        }
        let etag = header_etag(&res);
        // 有些伺服器 PUT 不回 ETag，再查一次。
        Ok(etag.or_else(|| self.stat(rel).ok().and_then(|i| i.etag)))
    }

    fn stat(&self, rel: &str) -> Result<Item, DavError> {
        self.propfind(rel, 0)?
            .into_iter()
            .next()
            .ok_or(DavError::NotFound)
    }

    fn mkcol(&self, rel: &str) -> Result<(), DavError> {
        let res = self.request("MKCOL", rel, &[], None)?;
        match res.status().as_u16() {
            200..=299 => Ok(()),
            405 => Err(DavError::Exists),
            code => Err(DavError::Http(code)),
        }
    }

    fn move_to(&self, from: &str, to: &str) -> Result<(), DavError> {
        let dest = self.url(to);
        let res = self.request(
            "MOVE",
            from,
            &[("Destination", &dest), ("Overwrite", "F")],
            None,
        )?;
        if res.status().is_success() {
            Ok(())
        } else {
            Err(DavError::Http(res.status().as_u16()))
        }
    }

    fn delete(&self, rel: &str) -> Result<(), DavError> {
        let res = self.request("DELETE", rel, &[], None)?;
        if res.status().is_success() {
            Ok(())
        } else {
            Err(DavError::Http(res.status().as_u16()))
        }
    }
}

/// 遠端資料夾的檔案操作（WebDAV 與 SSH 各自實作）。路徑都相對於連線的根目錄，以 `/` 分隔。
pub trait RemoteFs: Send + Sync {
    fn stat(&self, rel: &str) -> Result<Item, DavError>;
    /// 資料夾的直接子項目（可能也包含資料夾本身，呼叫端會略過）。
    fn list(&self, rel: &str) -> Result<Vec<Item>, DavError>;
    fn get(&self, rel: &str) -> Result<(Vec<u8>, Option<String>), DavError>;
    /// 上傳。`if_match` 為 `Some` 時只在遠端的版本相同時寫入（否則 `Changed`）；
    /// `None` 時只在檔案不存在時建立（已存在也是 `Changed`）。回傳新的版本標記。
    fn put(
        &self,
        rel: &str,
        bytes: &[u8],
        if_match: Option<&str>,
    ) -> Result<Option<String>, DavError>;
    fn mkdir(&self, rel: &str) -> Result<(), DavError>;
    /// 改名或搬移；目的地已經存在時失敗。
    fn rename(&self, from: &str, to: &str) -> Result<(), DavError>;
    /// 刪除檔案或整個資料夾。
    fn delete(&self, rel: &str) -> Result<(), DavError>;
}

impl RemoteFs for Client {
    fn stat(&self, rel: &str) -> Result<Item, DavError> {
        Client::stat(self, rel)
    }
    fn list(&self, rel: &str) -> Result<Vec<Item>, DavError> {
        self.propfind(rel, 1)
    }
    fn get(&self, rel: &str) -> Result<(Vec<u8>, Option<String>), DavError> {
        Client::get(self, rel)
    }
    fn put(
        &self,
        rel: &str,
        bytes: &[u8],
        if_match: Option<&str>,
    ) -> Result<Option<String>, DavError> {
        Client::put(self, rel, bytes, if_match)
    }
    fn mkdir(&self, rel: &str) -> Result<(), DavError> {
        self.mkcol(rel)
    }
    fn rename(&self, from: &str, to: &str) -> Result<(), DavError> {
        self.move_to(from, to)
    }
    fn delete(&self, rel: &str) -> Result<(), DavError> {
        Client::delete(self, rel)
    }
}

/// ETag 統一成 `"值"`。有些伺服器（例如 wsgidav）PROPFIND 回的 ETag 沒有引號，
/// GET／PUT 的標頭卻有，不統一的話每次輪詢都會誤判成檔案被改過。
/// 弱 ETag（`W/"…"`）也當成一般 ETag 比較。
fn norm_etag(raw: &str) -> Option<String> {
    let v = raw.trim();
    let v = v.strip_prefix("W/").unwrap_or(v).trim_matches('"');
    (!v.is_empty()).then(|| format!("\"{v}\""))
}

fn header_etag(res: &ureq::http::Response<ureq::Body>) -> Option<String> {
    res.headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .and_then(norm_etag)
}

/// 解析 PROPFIND 的 207 回應。`base_path` 是連線根目錄的網址路徑（例如 `/筆記/`，可能有 %XX）。
fn parse_multistatus(xml: &str, base_path: &str) -> Vec<Item> {
    let base = decode_percent(base_path);
    let mut reader = quick_xml::Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut items = Vec::new();
    let (mut href, mut etag, mut is_dir) = (String::new(), None::<String>, false);
    let mut in_href = false;
    let mut in_etag = false;
    let mut in_response = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                "response" => {
                    in_response = true;
                    href.clear();
                    etag = None;
                    is_dir = false;
                }
                "href" if in_response => in_href = true,
                "getetag" => in_etag = true,
                "collection" => is_dir = true,
                _ => {}
            },
            Ok(Event::Empty(e)) if e.local_name().as_ref() == "collection" => is_dir = true,
            Ok(Event::Text(t)) => {
                if in_href {
                    href.push_str(t.as_ref());
                } else if in_etag {
                    etag.get_or_insert_with(String::new).push_str(t.as_ref());
                }
            }
            Ok(Event::GeneralRef(r)) => {
                // `&amp;`、`&#38;` 之類的實體（quick-xml 會分開回報）。
                let ch = match r.resolve_char_ref() {
                    Ok(Some(c)) => c,
                    _ => match r.as_ref() {
                        "amp" => '&',
                        "lt" => '<',
                        "gt" => '>',
                        "quot" => '"',
                        "apos" => '\'',
                        _ => continue,
                    },
                };
                if in_href {
                    href.push(ch);
                } else if in_etag {
                    etag.get_or_insert_with(String::new).push(ch);
                }
            }
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                "href" => in_href = false,
                "getetag" => in_etag = false,
                "response" => {
                    in_response = false;
                    let path = decode_percent(url_path(&href));
                    if let Some(rest) = path
                        .strip_prefix(&base)
                        .or_else(|| (path.clone() + "/").strip_prefix(&base).map(|_| ""))
                    {
                        items.push(Item {
                            rel: rest.trim_matches('/').to_string(),
                            is_dir,
                            etag: etag.as_deref().and_then(norm_etag),
                        });
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    items
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
            host_of(&base).to_string()
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
    crate::io::blocking(move || {
        let items = session
            .client
            .list(&rel)
            .map_err(|e| e.message(&tr!("無法讀取資料夾")))?;
        let mut entries: Vec<Entry> = items
            .into_iter()
            .filter(|i| i.rel != rel && !i.rel.is_empty())
            .filter(|i| !name_of(&i.rel).starts_with('.'))
            .filter(|i| i.is_dir || is_doc(std::path::Path::new(&i.rel)))
            .map(|i| Entry::new(name_of(&i.rel), join(&id, &i.rel), i.is_dir))
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

/// 用最多 `workers` 個執行緒同時處理 `items`，結果依原本的順序回傳。
fn parallel_map<T: Sync, R: Send>(
    items: &[T],
    workers: usize,
    f: &(dyn Fn(&T) -> R + Sync),
) -> Vec<R> {
    use std::sync::atomic::AtomicUsize;
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<R>>> = Mutex::new(items.iter().map(|_| None).collect());
    std::thread::scope(|scope| {
        for _ in 0..workers.min(items.len()) {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(item) = items.get(i) else { break };
                let r = f(item);
                results.lock().unwrap()[i] = Some(r);
            });
        }
    });
    results
        .into_inner()
        .unwrap()
        .into_iter()
        .map(|r| r.expect("每個項目都處理過")) // i18n-ignore：程式錯誤
        .collect()
}

/// 一層一層列出遠端的文件（同一層的資料夾同時查詢），回傳相對路徑。
/// `list` 查詢一個資料夾的直接子項目（Depth 1），失敗時回傳 `None`（略過那個資料夾）。
fn walk_remote(list: &(dyn Fn(&str) -> Option<Vec<Item>> + Sync)) -> Vec<String> {
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
        let results = parallel_map(&level, LIST_WORKERS, &|dir: &String| list(dir));
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
    crate::io::blocking_for(Duration::from_secs(60), move || {
        let id = session.conn.prefix();
        let rels = walk_remote(&|dir: &str| session.client.list(dir).ok());
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
    let (bytes, etag) = crate::io::blocking(move || {
        session
            .client
            .get(&rel)
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
    let result = crate::io::blocking(move || {
        let (if_match, before) = if force {
            // 使用者確認要覆蓋：先取回遠端目前的內容（放進版本記錄），
            // 再用它的 ETag 覆蓋（檔案不存在時就建立）。
            match session.client.get(&rel) {
                Ok((bytes, etag)) => {
                    let etag = etag
                        .or_else(|| session.client.stat(&rel).ok().and_then(|i| i.etag))
                        .or_else(|| Some(ANY_VERSION.into()));
                    (etag, Some(decode(&bytes).0))
                }
                Err(_) => (session.client.stat(&rel).ok().and_then(|i| i.etag), None),
            }
        } else {
            (known, last_read)
        };
        match session.client.put(&rel, t.as_bytes(), if_match.as_deref()) {
            Ok(etag) => Ok(Ok((etag, before))),
            Err(DavError::Changed) => match session.client.get(&rel) {
                Ok((bytes, _)) => Ok(Err(decode(&bytes).0)),
                // 遠端的檔案被刪掉了：和本機檔案一樣直接重新建立（建立時有人搶先建了同名檔才算衝突）。
                Err(DavError::NotFound) => match session.client.put(&rel, t.as_bytes(), None) {
                    Ok(etag) => Ok(Ok((etag, None))),
                    Err(DavError::Changed) => match session.client.get(&rel) {
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
    crate::io::blocking(move || {
        if is_dir {
            session.client.mkdir(&t)
        } else {
            session.client.put(&t, b"", None).map(|_| ())
        }
        .map_err(|e| match e {
            DavError::Changed => DavError::Exists.message(&tr!("無法建立「{name}」", name = name)),
            e => e.message(&tr!("無法建立「{name}」", name = name)),
        })
    })
    .await?;
    Ok(join(&id, &target))
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
    crate::io::blocking(move || {
        session
            .client
            .rename(&from, &to)
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
    crate::io::blocking(move || {
        session
            .client
            .delete(&rel)
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
    crate::io::blocking(move || {
        let assets = if dir.is_empty() {
            "assets".to_string()
        } else {
            format!("{dir}/assets")
        };
        match session.client.mkdir(&assets) {
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
    let (bytes, _) = crate::io::blocking(move || {
        session
            .client
            .get(&rel)
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
    let (bytes, _) = crate::io::blocking(move || {
        session
            .client
            .get(&rel)
            .map_err(|e| e.message(&tr!("無法讀取圖片")))
    })
    .await?;
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
    Ok(crate::io::blocking_for(Duration::from_secs(10), move || {
        Ok(session.client.stat("").is_ok())
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
fn remote_etags(
    stat: &dyn Fn(&str) -> Result<Item, DavError>,
    list: &dyn Fn(&str) -> Result<Vec<Item>, DavError>,
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
            match list(parent) {
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
            out.insert(rel.clone(), stat(rel).map(|i| i.etag));
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
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL_INTERVAL);
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
        let mut states = remote_etags(
            &|rel| session.client.stat(rel),
            &|dir| session.client.list(dir),
            &rels,
        );
        for (path, rel, etag) in open {
            let Some(state) = states.remove(&rel) else {
                continue;
            };
            match state {
                Ok(remote) => {
                    let Some(remote) = remote else { continue };
                    let already = dav.notified.lock().unwrap().get(&path) == Some(&remote);
                    if remote != etag && etag != ANY_VERSION && !already {
                        if let Ok((bytes, _)) = session.client.get(&rel) {
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
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(rel: &str, is_dir: bool, etag: Option<&str>) -> Item {
        Item {
            rel: rel.into(),
            is_dir,
            etag: etag.map(Into::into),
        }
    }

    #[test]
    fn remote_listing_is_bounded() {
        // 惡意的伺服器：每個資料夾都有更深的資料夾與很多檔案，還有指回自己的連結。
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let list = |dir: &str| {
            calls.fetch_add(1, Ordering::Relaxed);
            let mut items = vec![item(dir, true, None), item("", true, None)];
            for n in 0..5 {
                let sub = if dir.is_empty() {
                    format!("d{n}")
                } else {
                    format!("{dir}/d{n}")
                };
                items.push(item(&sub, true, None));
                items.push(item(&format!("{sub}.md"), false, None));
            }
            Some(items)
        };
        let files = walk_remote(&list);
        let calls = calls.load(Ordering::Relaxed);
        assert!(calls <= LIST_MAX_DIRS, "查了 {calls} 個資料夾");
        assert!(files.len() <= MAX_FILES);
        assert!(files.contains(&"d0.md".to_string()));
        assert!(files
            .iter()
            .all(|f| f.split('/').count() <= LIST_MAX_DEPTH + 1));
    }

    #[test]
    fn walks_a_normal_tree_in_parallel() {
        let list = |dir: &str| {
            Some(match dir {
                "" => vec![
                    item("", true, None),
                    item("筆記", true, None),
                    item(".git", true, None),
                    item("a.md", false, None),
                    item("圖.png", false, None),
                ],
                "筆記" => vec![item("筆記", true, None), item("筆記/b.md", false, None)],
                _ => return None,
            })
        };
        let mut files = walk_remote(&list);
        files.sort();
        assert_eq!(files, ["a.md", "筆記/b.md"]);
        let doubled = parallel_map(&[1, 2, 3, 4, 5, 6, 7], 3, &|n: &i32| n * 2);
        assert_eq!(doubled, [2, 4, 6, 8, 10, 12, 14]);
    }

    #[test]
    fn polls_folders_with_several_open_files_at_once() {
        let stats = std::cell::RefCell::new(Vec::new());
        let lists = std::cell::RefCell::new(Vec::new());
        let stat = |rel: &str| {
            stats.borrow_mut().push(rel.to_string());
            match rel {
                "b/改名中.md" => Ok(item(rel, false, Some("\"s\""))),
                "c.md" => Ok(item(rel, false, Some("\"c\""))),
                _ => Err(DavError::NotFound),
            }
        };
        let list = |dir: &str| {
            lists.borrow_mut().push(dir.to_string());
            Ok(vec![
                item(dir, true, None),
                item("b/1.md", false, Some("\"1\"")),
                item("b/2.md", false, None),
            ])
        };
        let rels: Vec<String> = ["b/1.md", "b/2.md", "b/改名中.md", "b/不見了.md", "c.md"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let out = remote_etags(&stat, &list, &rels);
        assert_eq!(*lists.borrow(), ["b"]);
        let mut asked = stats.borrow().clone();
        asked.sort();
        assert_eq!(asked, ["b/不見了.md", "b/改名中.md", "c.md"]);
        assert_eq!(out["b/1.md"], Ok(Some("\"1\"".into())));
        assert_eq!(out["b/2.md"], Ok(None));
        assert_eq!(out["b/改名中.md"], Ok(Some("\"s\"".into())));
        assert_eq!(out["b/不見了.md"], Err(DavError::NotFound));
        assert_eq!(out["c.md"], Ok(Some("\"c\"".into())));
        // 資料夾查詢失敗（斷線）：這次都不回報。
        let out = remote_etags(
            &stat,
            &|_| Err(DavError::Network("斷線".into())),
            &rels[..2],
        );
        assert!(out.is_empty());
    }

    #[test]
    fn etags_compare_with_or_without_quotes() {
        assert_eq!(norm_etag("abc-1"), Some("\"abc-1\"".into()));
        assert_eq!(norm_etag("\"abc-1\""), Some("\"abc-1\"".into()));
        assert_eq!(norm_etag(" W/\"abc-1\" "), Some("\"abc-1\"".into()));
        assert_eq!(norm_etag("\"\""), None);
    }

    #[test]
    fn encodes_and_decodes_paths() {
        assert_eq!(encode_segment("週報 1.md"), "%E9%80%B1%E5%A0%B1%201.md");
        assert_eq!(
            decode_percent("/%E7%AD%86%E8%A8%98/a%20b.md"),
            "/筆記/a b.md"
        );
        assert_eq!(decode_percent("%2"), "%2");
        assert_eq!(decode_percent("%中文"), "%中文");
        assert_eq!(url_path("https://nas.local:5006/筆記/"), "/筆記/");
        assert_eq!(url_path("https://nas.local"), "/");
        assert_eq!(
            encode_base("http://nas:5005/筆記/週報 2/"),
            "http://nas:5005/%E7%AD%86%E8%A8%98/%E9%80%B1%E5%A0%B1%202/"
        );
        assert_eq!(
            encode_base("http://nas:5005/%E7%AD%86%E8%A8%98"),
            "http://nas:5005/%E7%AD%86%E8%A8%98/"
        );
        assert_eq!(encode_base("https://nas"), "https://nas/");
        assert_eq!(host_of("https://user@[fe80::1]:5006/x"), "fe80::1");
        assert_eq!(host_of("http://192.168.1.10:5005/home/"), "192.168.1.10");
    }

    #[test]
    fn only_allows_http_on_local_network_with_consent() {
        assert_eq!(
            normalize_url("https://nas.example.com/筆記", false).unwrap(),
            "https://nas.example.com/筆記/"
        );
        assert!(normalize_url("http://nas.example.com/", true)
            .unwrap_err()
            .contains("HTTPS"));
        assert_eq!(
            normalize_url("http://192.168.1.10:5005/", false).unwrap_err(),
            "HTTP_CONFIRM"
        );
        assert_eq!(
            normalize_url("http://192.168.1.10:5005", true).unwrap(),
            "http://192.168.1.10:5005/"
        );
        assert!(normalize_url("http://diskstation:5005/", true).is_ok());
        assert!(normalize_url("ftp://nas/", true).is_err());
        assert!(normalize_url("https:///", false).is_err());
    }

    #[test]
    fn parses_multistatus_from_different_servers() {
        // Synology／Apache 風格：前綴 D:，href 是完整路徑並以 %XX 編碼。
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response><D:href>/%E7%AD%86%E8%A8%98/</D:href><D:propstat><D:prop>
    <D:resourcetype><D:collection/></D:resourcetype><D:getetag>"dir"</D:getetag></D:prop>
    <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
  <D:response><D:href>/%E7%AD%86%E8%A8%98/%E9%80%B1%E5%A0%B1.md</D:href><D:propstat><D:prop>
    <D:resourcetype/><D:getetag>"abc-123"</D:getetag></D:prop></D:propstat></D:response>
  <D:response><D:href>http://nas:5005/%E7%AD%86%E8%A8%98/sub%20dir/</D:href><D:propstat><D:prop>
    <D:resourcetype><D:collection></D:collection></D:resourcetype></D:prop></D:propstat></D:response>
  <D:response><D:href>/%E7%AD%86%E8%A8%98/a&amp;b.md</D:href><D:propstat><D:prop>
    <D:resourcetype/><D:getetag>W/"x&amp;y"</D:getetag></D:prop></D:propstat></D:response>
</D:multistatus>"#;
        let items = parse_multistatus(xml, "/%E7%AD%86%E8%A8%98/");
        assert_eq!(
            items,
            vec![
                Item {
                    rel: "".into(),
                    is_dir: true,
                    etag: Some("\"dir\"".into())
                },
                Item {
                    rel: "週報.md".into(),
                    is_dir: false,
                    etag: Some("\"abc-123\"".into())
                },
                Item {
                    rel: "sub dir".into(),
                    is_dir: true,
                    etag: None
                },
                Item {
                    rel: "a&b.md".into(),
                    is_dir: false,
                    etag: Some("\"x&y\"".into())
                },
            ]
        );
        // Nextcloud 風格：小寫前綴 d:。
        let xml = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/files/eric/</d:href>
            <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
            <d:response><d:href>/remote.php/dav/files/eric/x.md</d:href><d:propstat><d:prop><d:resourcetype/>
            <d:getetag>&quot;e1&quot;</d:getetag></d:prop></d:propstat></d:response></d:multistatus>"#;
        let items = parse_multistatus(xml, "/remote.php/dav/files/eric/");
        assert_eq!(
            items[1],
            Item {
                rel: "x.md".into(),
                is_dir: false,
                etag: Some("\"e1\"".into())
            }
        );
    }

    #[test]
    fn splits_remote_paths_safely() {
        assert_eq!(
            split("webdav://ab12/筆記/週報.md"),
            Some(("webdav://ab12", "筆記/週報.md"))
        );
        assert_eq!(split("webdav://ab12/"), Some(("webdav://ab12", "")));
        assert_eq!(split("webdav://ab12"), Some(("webdav://ab12", "")));
        assert_eq!(split("ssh://cd34/a/b.md"), Some(("ssh://cd34", "a/b.md")));
        assert_eq!(join("webdav://ab12", ""), "webdav://ab12");
        assert_eq!(join("ssh://cd34", "a/b.md"), "ssh://cd34/a/b.md");
        assert_eq!(split("webdav://ab12/../etc"), None);
        assert_eq!(split("ssh:///etc"), None);
        assert_eq!(split("C:\\notes"), None);
    }

    /// 需要本機的 WebDAV 伺服器（例如 wsgidav），預設不執行：
    /// `MD_DAV_TEST=http://127.0.0.1:8765/ MD_DAV_USER=eric MD_DAV_PASS=secret cargo test -- --ignored dav_live`
    #[test]
    #[ignore]
    fn dav_live() {
        let base = std::env::var("MD_DAV_TEST").unwrap();
        let c = Client::new(
            &base,
            &std::env::var("MD_DAV_USER").unwrap(),
            &std::env::var("MD_DAV_PASS").unwrap(),
        );
        let wrong = Client::new(&base, "eric", "錯誤的密碼");
        assert_eq!(wrong.stat("").unwrap_err(), DavError::Unauthorized);
        assert!(c.stat("").unwrap().is_dir);
        let _ = c.delete("測試 資料夾");
        c.mkcol("測試 資料夾").unwrap();
        assert_eq!(c.mkcol("測試 資料夾").unwrap_err(), DavError::Exists);
        let etag = c
            .put("測試 資料夾/週報.md", "第一版".as_bytes(), None)
            .unwrap()
            .unwrap();
        // 已存在時不能用「新建」覆蓋。
        assert_eq!(
            c.put("測試 資料夾/週報.md", b"x", None).unwrap_err(),
            DavError::Changed
        );
        let (body, got) = c.get("測試 資料夾/週報.md").unwrap();
        assert_eq!(String::from_utf8(body).unwrap(), "第一版");
        assert_eq!(got.as_deref(), Some(etag.as_str()));
        // 用正確的 ETag 更新成功；用舊的 ETag 更新回 412。
        // （wsgidav 的 ETag 以秒為單位，內容長度不同才保證 ETag 會變。）
        let etag2 = c
            .put(
                "測試 資料夾/週報.md",
                "第二版，比較長".as_bytes(),
                Some(&etag),
            )
            .unwrap()
            .unwrap();
        assert_ne!(etag, etag2);
        assert_eq!(
            c.put("測試 資料夾/週報.md", b"x", Some(&etag)).unwrap_err(),
            DavError::Changed
        );
        let list = c.propfind("測試 資料夾", 1).unwrap();
        assert!(list
            .iter()
            .any(|i| i.rel == "測試 資料夾/週報.md" && !i.is_dir));
        c.move_to("測試 資料夾/週報.md", "測試 資料夾/改名.md")
            .unwrap();
        assert_eq!(
            c.stat("測試 資料夾/週報.md").unwrap_err(),
            DavError::NotFound
        );
        c.delete("測試 資料夾").unwrap();
    }
}
