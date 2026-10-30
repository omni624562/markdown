//! Azure DevOps（雲端版與公司自架的 Azure DevOps Server／TFS）：用個人存取權杖（PAT）連線，
//! 列出 Git 儲存庫與專案 Wiki、下載（clone），以及查看工作項目。
//! 權杖存在 Windows 認證管理員；伺服器網址與顯示名稱存在設定資料夾（不含權杖）。
//! 推送、拉取時，權杖被拒絕而這台伺服器要求 Windows 整合式驗證，Git 會改用目前登入 Windows 的帳號（見 git.rs）。

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Window};

use crate::git::{AdoCred, Identity};

mod access;
mod files;
mod repos;
mod search;
#[cfg(test)]
mod tests;
mod wiki;
mod workitems;

pub use access::*;
pub use files::*;
pub use repos::*;
pub use search::*;
pub use wiki::*;
pub use workitems::*;

const SERVICE: &str = "omarker-ado";
/// Azure DevOps Server 2019 起支援的 REST API 版本。
const API_VERSION: &str = "5.0";
const TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// 集合（collection）或組織的網址，例如 https://tfs.公司.com/tfs/DefaultCollection。
    pub url: String,
    /// 登入者的顯示名稱。
    pub name: String,
    /// 登入帳號（Email 或「網域\帳號」）。
    #[serde(default)]
    pub account: Option<String>,
}

/// 這次開啟期間的權杖（非 Windows 平台不保存到磁碟，只記在這裡）。
static TOKEN: Mutex<Option<String>> = Mutex::new(None);

fn account_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("ado-account.json"))
}

static ACCOUNT: crate::secrets::CachedAccount<Account> = crate::secrets::CachedAccount::new();

fn account(app: &AppHandle) -> Option<Account> {
    ACCOUNT.get(|| account_file(app))
}

fn token() -> Option<String> {
    let mut cached = TOKEN.lock().ok()?;
    if cached.is_none() {
        *cached = crate::secrets::get(SERVICE, "pat");
    }
    cached.clone()
}

/// 連線資料：網址與權杖（兩者都有才算已連線）。
fn connection(app: &AppHandle) -> Option<(Account, String)> {
    Some((account(app)?, token()?))
}

/// Git 推送、拉取時用的認證：網址在這台伺服器底下就用權杖。
pub fn cred(app: &AppHandle) -> Option<AdoCred> {
    let a = account(app)?;
    Some(AdoCred {
        base: a.url,
        pat: token(),
    })
}

/// 提交時的名字與 Email：ADO 的顯示名稱與帳號。
pub fn identity(app: &AppHandle) -> Option<Identity> {
    identity_of(&account(app)?)
}

fn identity_of(a: &Account) -> Option<Identity> {
    let name = a.name.trim();
    if name.is_empty() {
        return None;
    }
    let email = match a.account.as_deref().map(str::trim) {
        Some(acc) if acc.contains('@') => acc.to_string(),
        // 公司自架版常是「網域\帳號」：寫成「帳號@網域」。
        Some(acc) if acc.contains('\\') => {
            let (domain, user) = acc.split_once('\\').unwrap_or_default();
            format!("{user}@{}", domain.to_lowercase())
        }
        Some(acc) if !acc.is_empty() => format!("{acc}@{}", host_of(&a.url)),
        _ => format!("{}@{}", name.replace(' ', "."), host_of(&a.url)),
    };
    Some(Identity {
        name: name.to_string(),
        email,
    })
}

fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    rest.split(['/', ':'])
        .next()
        .unwrap_or_default()
        .to_lowercase()
}

// ---- 網址 -------------------------------------------------------------------

/// 網址中的一段（專案名稱、Wiki 名稱）：保留英數字與 `-._~`，其餘轉成 %XX。
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

/// 使用者貼上的網址可能是集合、專案、儲存庫或工作項目的網址：
/// 去掉結尾的 `/` 與 `/_git/…`、`/_wiki/…` 這類頁面路徑，回傳要依序嘗試的集合網址
/// （原本的網址，以及往上一層，因為可能貼的是專案網址）。
fn candidates(input: &str) -> Result<Vec<String>, String> {
    let mut url = input.trim().trim_end_matches('/').to_string();
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err(tr!("請輸入 https:// 或 http:// 開頭的網址"));
    }
    if let Some(q) = url.find(['?', '#']) {
        url.truncate(q);
    }
    // 不加密的 HTTP 會讓個人存取權杖以明文傳出去：只允許公司內部網路的位址。
    if lower.starts_with("http://") && !crate::dav::is_private_host(&crate::dav::host_of(&url)) {
        return Err(tr!(
            "HTTP 不會加密，個人存取權杖可能被看到，只能用在公司內部網路的伺服器。請改用 https:// 開頭的網址"
        ));
    }
    if let Some(i) = url.find("/_") {
        url.truncate(i);
    }
    let url = url.trim_end_matches('/').to_string();
    let scheme_end = url.find("://").map_or(0, |i| i + 3);
    let mut out = vec![url.clone()];
    match url.rfind('/').filter(|&i| i > scheme_end) {
        Some(i) => out.push(url[..i].to_string()),
        // 只有主機名稱：TFS 2019 以前預設裝在 /tfs 底下。
        None => out.push(format!("{url}/tfs")),
    }
    Ok(out)
}

// ---- HTTP -------------------------------------------------------------------

fn basic(pat: &str) -> String {
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!(":{pat}"))
    )
}

fn read(
    res: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    what: &str,
) -> Result<Value, String> {
    read_with_etag(res, what).map(|(v, _)| v)
}

/// 和 `read` 一樣，另外回傳回應的 ETag（Wiki 頁面的版本，存回去時用來確認沒有被別人改過）。
fn read_with_etag(
    res: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    what: &str,
) -> Result<(Value, Option<String>), String> {
    match res {
        Ok(mut r) => {
            let etag = r
                .headers()
                .get("ETag")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let text = r
                .body_mut()
                .read_to_string()
                .map_err(|e| tr!("{what}失敗：{e}", what = what, e = e))?;
            // 權杖不對時，雲端版會回傳登入網頁（HTML）而不是錯誤碼。
            let v = serde_json::from_str(&text).map_err(|_| {
                tr!(
                    "{what}失敗：伺服器的回應不是預期的格式，請確認網址與個人存取權杖",
                    what = what
                )
            })?;
            Ok((v, etag))
        }
        Err(ureq::Error::StatusCode(401)) => Err(tr!(
            "{what}失敗：個人存取權杖無效或已過期，請到設定的 Azure DevOps／TFS 頁更新權杖",
            what = what
        )),
        Err(ureq::Error::StatusCode(403)) => Err(tr!("{what}失敗：沒有權限", what = what)),
        Err(ureq::Error::StatusCode(404)) => {
            Err(tr!("{what}失敗：找不到（404），請確認網址", what = what))
        }
        Err(ureq::Error::StatusCode(code)) => Err(tr!(
            "{what}失敗：伺服器回應 {code}",
            what = what,
            code = code
        )),
        // 409（例如 PR 已經存在）由呼叫端說明。
        Err(e) => Err(tr!(
            "{what}失敗：連不到 Azure DevOps 伺服器，請確認網路或 VPN 連線（{e}）",
            what = what,
            e = e
        )),
    }
}

/// `path` 以 `/_apis/` 開頭，會自動加上 api-version。
fn get(base: &str, pat: &str, path: &str, what: &str) -> Result<Value, String> {
    get_version(base, pat, path, Some(API_VERSION), what)
}

/// 指定 api-version（None 代表不帶，由伺服器決定）。
fn get_version(
    base: &str,
    pat: &str,
    path: &str,
    version: Option<&str>,
    what: &str,
) -> Result<Value, String> {
    let url = match version {
        Some(v) => {
            let sep = if path.contains('?') { '&' } else { '?' };
            format!("{base}{path}{sep}api-version={v}")
        }
        None => format!("{base}{path}"),
    };
    read(
        crate::update::agent()
            .get(&url)
            .header("Authorization", &basic(pat))
            .header("Accept", "application/json")
            .call(),
        what,
    )
}

fn post(base: &str, pat: &str, path: &str, body: &Value, what: &str) -> Result<Value, String> {
    let sep = if path.contains('?') { '&' } else { '?' };
    read(
        crate::update::agent()
            .post(&format!("{base}{path}{sep}api-version={API_VERSION}"))
            .header("Authorization", &basic(pat))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .send(&body.to_string()),
        what,
    )
}

fn values(v: &Value) -> &[Value] {
    v.get("value")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

// ---- 連線 -------------------------------------------------------------------

#[tauri::command]
pub fn ado_account(app: AppHandle) -> Option<Account> {
    connection(&app).map(|(a, _)| a)
}

/// 從 connectionData 讀出登入者；不是登入狀態（例如匿名）時回傳 None。
fn user_of(data: &Value) -> Option<(String, Option<String>)> {
    let user = data.get("authenticatedUser")?;
    let name = str_of(user, "providerDisplayName")
        .or_else(|| str_of(user, "customDisplayName"))?
        .trim()
        .to_string();
    if name.is_empty() || name.eq_ignore_ascii_case("Anonymous") {
        return None;
    }
    let account = user
        .pointer("/properties/Account/$value")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some((name, account))
}

fn is_not_found(e: &str) -> bool {
    e.contains("（404）") || e.contains("(404)") // i18n-ignore：比對中英文的訊息
}

/// 讀取登入資訊。connectionData 是預覽版的 API，伺服器可能不接受正式版號（5.0），
/// 所以用預覽版號；還是被拒絕時（舊版伺服器）不帶版號再試一次。
fn connection_data(base: &str, pat: &str) -> Result<Value, String> {
    let path = "/_apis/connectionData";
    let what = tr!("連線");
    get_version(base, pat, path, Some("5.0-preview"), &what).or_else(|e| {
        // i18n-ignore：比對中英文的訊息
        if e.contains("伺服器回應 400") || e.contains("responded with 400") || is_not_found(&e)
        {
            get_version(base, pat, path, None, &what).map_err(|_| e)
        } else {
            Err(e)
        }
    })
}

/// 確認 `base` 是可以使用的集合。網址是伺服器（例如 https://伺服器/tfs）而不是集合時，
/// 伺服器上只有一個集合就自動使用它，有好幾個就請使用者指定。
fn connect_at(base: &str, pat: &str) -> Result<Account, String> {
    let data = connection_data(base, pat)?;
    let (name, account) =
        user_of(&data).ok_or_else(|| tr!("連線失敗：個人存取權杖無效或已過期"))?;
    let what = tr!("連線");
    let check = |url: &str| get(url, pat, "/_apis/projects?$top=1", &what);
    let url = match check(base) {
        Ok(_) => base.to_string(),
        Err(e) if is_not_found(&e) => {
            let list = get(base, pat, "/_apis/projectCollections", &what).map_err(|_| e)?;
            let names: Vec<&str> = values(&list)
                .iter()
                .filter_map(|c| str_of(c, "name"))
                .collect();
            match names.as_slice() {
                [] => return Err(tr!("連線失敗：這台伺服器上沒有可以使用的集合")),
                [one] => {
                    let url = format!("{base}/{}", encode_segment(one));
                    check(&url)?;
                    url
                }
                many => {
                    return Err(tr!(
                        "這台伺服器上有好幾個集合（{many}），請在網址後面加上集合名稱，例如 {base}/{first}",
                        many = many.join(&tr!("、")),
                        base = base,
                        first = encode_segment(many[0])
                    ))
                }
            }
        }
        Err(e) => return Err(e),
    };
    Ok(Account { url, name, account })
}

/// 每個網址都連不上時，挑最有用的錯誤：先看不是 404 的（例如權杖錯誤），
/// 全部都是 404 就說明要輸入哪一種網址。
fn connect_error(tries: &[String], errors: Vec<String>) -> String {
    if let Some(e) = errors.iter().find(|e| !is_not_found(e)) {
        return e.clone();
    }
    tr!(
        "連線失敗：找不到 Azure DevOps（404）。已試過：{tries}。請輸入集合的網址，例如 https://伺服器/tfs/DefaultCollection（在瀏覽器打開 TFS，網址裡專案名稱前面的那一段）",
        tries = tries.join(&tr!("、"))
    )
}

/// 用網址與個人存取權杖連線：確認可以登入後記住（權杖存在 Windows 認證管理員）。
#[tauri::command]
pub async fn ado_connect(app: AppHandle, url: String, pat: String) -> Result<Account, String> {
    let pat = pat.trim().to_string();
    if pat.is_empty() {
        return Err(tr!("請輸入個人存取權杖"));
    }
    let tries = candidates(&url)?;
    let token = pat.clone();
    let account = crate::io::blocking_for(TIMEOUT, move || {
        let mut errors = Vec::new();
        for base in &tries {
            match connect_at(base, &token) {
                Ok(a) => return Ok(a),
                Err(e) => errors.push(e),
            }
        }
        Err(connect_error(&tries, errors))
    })
    .await?;
    let path = account_file(&app).ok_or_else(|| tr!("找不到設定資料夾"))?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| tr!("無法建立設定資料夾：{e}", e = e))?;
    }
    let json = serde_json::to_string_pretty(&account).unwrap_or_default();
    crate::files::write_atomic(&path, json.as_bytes()).map_err(|e| tr!("無法儲存：{e}", e = e))?;
    ACCOUNT.set(Some(account.clone()));
    crate::secrets::set(SERVICE, "pat", &pat);
    if let Ok(mut t) = TOKEN.lock() {
        *t = Some(pat);
    }
    Ok(account)
}

#[tauri::command]
pub fn ado_disconnect(app: AppHandle) {
    crate::secrets::forget(SERVICE, "pat");
    if let Ok(mut t) = TOKEN.lock() {
        *t = None;
    }
    if let Some(p) = account_file(&app) {
        let _ = fs::remove_file(p);
    }
    ACCOUNT.set(None);
}

fn require(app: &AppHandle) -> Result<(Account, String), String> {
    connection(app).ok_or_else(|| tr!("請先到設定的 Azure DevOps／TFS 頁連線"))
}
