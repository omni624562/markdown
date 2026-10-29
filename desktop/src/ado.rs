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
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::git::{AdoCred, Identity};

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

// ---- 權限檢查 ---------------------------------------------------------------

/// 一項權限檢查的結果。`status` 是 `ok`、`fail` 或 `unknown`（無法事先檢查）。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccessCheck {
    id: &'static str,
    label: String,
    status: &'static str,
    detail: String,
}

fn check(id: &'static str, label: String, result: Result<String, String>) -> AccessCheck {
    match result {
        Ok(detail) => AccessCheck {
            id,
            label,
            status: "ok",
            detail,
        },
        Err(detail) => AccessCheck {
            id,
            label,
            status: "fail",
            detail,
        },
    }
}

/// 用 `validateOnly` 試改工作項目（不會真的存檔）：確認權杖與帳號能不能修改工作項目。
fn can_edit_work_item(base: &str, pat: &str, id: u64) -> Result<String, String> {
    let res = crate::update::agent()
        .patch(&format!(
            "{base}/_apis/wit/workitems/{id}?validateOnly=true&api-version={API_VERSION}"
        ))
        .config()
        .http_status_as_error(false)
        .build()
        .header("Authorization", &basic(pat))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json-patch+json")
        .send(r#"[{"op":"add","path":"/fields/System.History","value":""}]"#)
        .map_err(|e| e.to_string())?;
    match res.status().as_u16() {
        code if code < 400 => Ok(tr!(
            "可以修改（用工作項目 {id} 試過，沒有真的修改）",
            id = id
        )),
        401 => Err(tr!("權杖沒有「Work Items（Read & write）」權限")),
        403 => Err(tr!("帳號沒有修改這個專案工作項目的權限")),
        code => Err(tr!("無法確認：伺服器回應 {code}", code = code)),
    }
}

/// 逐項檢查這個權杖能做什麼：登入、專案、工作項目（讀、改）、Wiki、程式碼。
#[tauri::command]
pub async fn ado_check(app: AppHandle) -> Result<Vec<AccessCheck>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let base = a.url.as_str();
        let mut out = vec![];
        out.push(check(
            "login",
            tr!("登入"),
            connection_data(base, &pat).and_then(|d| {
                user_of(&d)
                    .map(|(name, _)| tr!("以「{name}」登入", name = name))
                    .ok_or_else(|| tr!("個人存取權杖無效或已過期"))
            }),
        ));
        out.push(check(
            "projects",
            tr!("讀取專案"),
            get(base, &pat, "/_apis/projects?$top=100", &tr!("讀取專案"))
                .map(|v| tr!("看得到 {n} 個專案", n = values(&v).len())),
        ));
        let wiql = serde_json::json!({
            "query": "SELECT [System.Id] FROM WorkItems ORDER BY [System.ChangedDate] DESC"
        });
        let items = post(
            base,
            &pat,
            "/_apis/wit/wiql?$top=1",
            &wiql,
            &tr!("讀取工作項目"),
        );
        let first = items.as_ref().ok().and_then(|v| {
            v.get("workItems")
                .and_then(Value::as_array)
                .and_then(|l| l.first())
                .and_then(|w| w.get("id"))
                .and_then(Value::as_u64)
        });
        out.push(check(
            "workItemsRead",
            tr!("讀取工作項目"),
            items.map(|_| tr!("可以讀取")),
        ));
        out.push(match first {
            Some(id) => check(
                "workItemsWrite",
                tr!("修改工作項目（改狀態、指派、留言）"),
                can_edit_work_item(base, &pat, id),
            ),
            None => AccessCheck {
                id: "workItemsWrite",
                label: tr!("修改工作項目（改狀態、指派、留言）"),
                status: "unknown",
                detail: tr!("沒有可以試的工作項目，無法確認"),
            },
        });
        out.push(check(
            "wikiRead",
            tr!("讀取 Wiki"),
            get(base, &pat, "/_apis/wiki/wikis", &tr!("讀取 Wiki"))
                .map(|v| tr!("看得到 {n} 個 Wiki", n = values(&v).len())),
        ));
        out.push(AccessCheck {
            id: "wikiWrite",
            label: tr!("編輯 Wiki 頁面"),
            status: "unknown",
            detail: tr!("無法事先確認，第一次存回時就知道；權杖需要「Wiki（Read & write）」權限"),
        });
        out.push(check(
            "code",
            tr!("讀取程式碼（儲存庫）"),
            get(base, &pat, "/_apis/git/repositories", &tr!("讀取儲存庫"))
                .map(|v| tr!("看得到 {n} 個儲存庫", n = values(&v).len())),
        ));
        Ok(out)
    })
    .await
}

// ---- 連線狀態（狀態列） --------------------------------------------------------

/// 連線狀態：`ok`（連得到、權杖有效）、`offline`（連不到伺服器）、`auth`（權杖無效或過期）、
/// `error`（其他錯誤）、`none`（還沒有設定連線）。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AdoPing {
    status: &'static str,
    /// 登入者（`ok` 時）。
    name: Option<String>,
    message: String,
}

/// 依 connectionData 的回應分類（`code` 是 HTTP 狀態碼，`body` 是內容）。
fn ping_of(code: u16, body: &str) -> AdoPing {
    let auth = || AdoPing {
        status: "auth",
        name: None,
        message: tr!("個人存取權杖無效或已過期，請到設定的 Azure DevOps／TFS 頁更新權杖"),
    };
    match code {
        401 | 403 => auth(),
        c if c < 400 => match serde_json::from_str::<Value>(body)
            .ok()
            .as_ref()
            .and_then(user_of)
        {
            Some((name, _)) => AdoPing {
                status: "ok",
                name: Some(name),
                message: String::new(),
            },
            // 權杖不對時，雲端版會回傳登入網頁（不是 JSON）或匿名使用者。
            None => auth(),
        },
        c => AdoPing {
            status: "error",
            name: None,
            message: tr!("伺服器回應 {code}", code = c),
        },
    }
}

/// 檢查連線狀態（不會修改任何資料，最多等 20 秒）。
#[tauri::command]
pub async fn ado_ping(app: AppHandle) -> Result<AdoPing, String> {
    let Some((a, pat)) = connection(&app) else {
        return Ok(AdoPing {
            status: "none",
            name: None,
            message: String::new(),
        });
    };
    crate::io::blocking_for(Duration::from_secs(20), move || {
        let call = |version: Option<&str>| {
            let url = match version {
                Some(v) => format!("{}/_apis/connectionData?api-version={v}", a.url),
                None => format!("{}/_apis/connectionData", a.url),
            };
            crate::update::agent()
                .get(&url)
                .config()
                .http_status_as_error(false)
                .build()
                .header("Authorization", &basic(&pat))
                .header("Accept", "application/json")
                .call()
        };
        // 舊版伺服器不接受預覽版號（回 400），再不帶版號試一次。
        let res = match call(Some("5.0-preview")) {
            Ok(r) if r.status().as_u16() == 400 => call(None),
            other => other,
        };
        Ok(match res {
            Ok(mut r) => {
                let code = r.status().as_u16();
                let body = r.body_mut().read_to_string().unwrap_or_default();
                ping_of(code, &body)
            }
            Err(e) => AdoPing {
                status: "offline",
                name: None,
                message: tr!(
                    "連不到 Azure DevOps 伺服器，請確認網路或 VPN 連線（{e}）",
                    e = e
                ),
            },
        })
    })
    .await
}

// ---- 儲存庫 -----------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    name: String,
    project: String,
    clone_url: String,
    web_url: Option<String>,
    /// 專案 Wiki（不是一般的程式碼儲存庫）。
    wiki: bool,
}

fn repos_from(base: &str, repos: &Value, wikis: &Value, projects: &Value) -> Vec<Repo> {
    let mut out: Vec<Repo> = values(repos)
        .iter()
        .filter(|r| r.get("isDisabled").and_then(Value::as_bool) != Some(true))
        .filter_map(|r| {
            Some(Repo {
                name: str_of(r, "name")?.to_string(),
                project: r
                    .pointer("/project/name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                clone_url: str_of(r, "remoteUrl")?.to_string(),
                web_url: str_of(r, "webUrl").map(str::to_string),
                wiki: false,
            })
        })
        .collect();
    // 專案 Wiki 的儲存庫不會出現在儲存庫清單裡，用專案名稱組出網址。
    for w in values(wikis) {
        if str_of(w, "type") != Some("projectWiki") {
            continue;
        }
        let (Some(name), Some(project_id)) = (str_of(w, "name"), str_of(w, "projectId")) else {
            continue;
        };
        let Some(project) = values(projects)
            .iter()
            .find(|p| str_of(p, "id") == Some(project_id))
            .and_then(|p| str_of(p, "name"))
        else {
            continue;
        };
        out.push(Repo {
            name: name.to_string(),
            project: project.to_string(),
            clone_url: format!(
                "{base}/{}/_git/{}",
                encode_segment(project),
                encode_segment(name)
            ),
            web_url: str_of(w, "remoteUrl").map(str::to_string),
            wiki: true,
        });
    }
    out.sort_by(|a, b| {
        (a.project.to_lowercase(), a.wiki, a.name.to_lowercase()).cmp(&(
            b.project.to_lowercase(),
            b.wiki,
            b.name.to_lowercase(),
        ))
    });
    out
}

/// 集合裡所有專案的 Git 儲存庫與專案 Wiki。
#[tauri::command]
pub async fn ado_repos(app: AppHandle) -> Result<Vec<Repo>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let base = a.url;
        let repos = get(
            &base,
            &pat,
            "/_apis/git/repositories",
            &tr!("讀取儲存庫清單"),
        )?;
        // 讀不到 Wiki（例如沒有權限）時仍然列出儲存庫。
        let wikis = get(&base, &pat, "/_apis/wiki/wikis", &tr!("讀取 Wiki")).unwrap_or(Value::Null);
        let projects = if values(&wikis).is_empty() {
            Value::Null
        } else {
            get(&base, &pat, "/_apis/projects?$top=1000", &tr!("讀取專案")).unwrap_or(Value::Null)
        };
        Ok(repos_from(&base, &repos, &wikis, &projects))
    })
    .await
}

/// 下載儲存庫或 Wiki：選擇要放在哪個資料夾，下載到裡面的「名稱」資料夾，然後開啟它。
#[tauri::command]
pub async fn ado_clone(
    app: AppHandle,
    window: WebviewWindow,
    clone_url: String,
    name: String,
) -> Result<Option<crate::github::Cloned>, String> {
    let (a, _) = require(&app)?;
    // 只下載這台伺服器上的儲存庫，避免前端傳來任意網址時把權杖送到別的地方。
    if !starts_with_base(&clone_url, &a.url) {
        return Err(tr!("儲存庫網址不在目前連線的 Azure DevOps 上"));
    }
    let folder = name.trim().trim_end_matches(".wiki").to_string();
    let folder = if name.trim().ends_with(".wiki") {
        format!("{folder}-wiki")
    } else {
        folder
    };
    let Some(dest) = crate::github::pick_clone_dest(&app, &window, &folder, &clone_url).await?
    else {
        return Ok(None);
    };
    let auth = crate::git::auth(&app);
    crate::github::clone_and_open(&app, dest, clone_url, auth, "Azure DevOps")
        .await
        .map(Some)
}

/// `url` 和 `base` 是不是同一台伺服器（通訊協定、主機與連接埠都相同）。
pub fn same_server(url: &str, base: &str) -> bool {
    let origin = |u: &str| {
        let lower = u.to_ascii_lowercase();
        let start = lower.find("://").map_or(0, |i| i + 3);
        let end = lower[start..].find('/').map_or(lower.len(), |i| start + i);
        lower[..end].to_string()
    };
    origin(url) == origin(base)
}

/// `url` 是不是在 `base`（集合網址）底下；比對時不分大小寫，也不會把 `…/tfs2` 當成 `…/tfs` 底下。
pub fn starts_with_base(url: &str, base: &str) -> bool {
    let url = url.to_ascii_lowercase();
    let base = base.trim_end_matches('/').to_ascii_lowercase();
    url == base || url.starts_with(&format!("{base}/"))
}

// ---- Pull Request -------------------------------------------------------------

/// 儲存庫網址（…/專案/_git/儲存庫）裡的專案與儲存庫兩段（保持原本的編碼）。
fn project_and_repo(remote: &str, base: &str) -> Option<(String, String)> {
    let clean = remote.trim().trim_end_matches('/');
    // 去掉網址裡的帳號（https://帳號@主機/…）。
    let clean = match clean.split_once("://") {
        Some((scheme, rest)) => {
            let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
            format!(
                "{scheme}://{}/{path}",
                host.rsplit('@').next().unwrap_or(host)
            )
        }
        None => clean.to_string(),
    };
    if !starts_with_base(&clean, base) {
        return None;
    }
    let rest = &clean[base.trim_end_matches('/').len()..];
    let (project, repo) = rest.trim_start_matches('/').split_once("/_git/")?;
    let repo = repo.split('/').next()?;
    (!project.is_empty() && !repo.is_empty()).then(|| (project.to_string(), repo.to_string()))
}

/// 建立 PR：從 `branch` 合併到儲存庫的預設分支，回傳 PR 的網頁網址。
pub fn create_pull(
    app: &AppHandle,
    remote: &str,
    branch: &str,
    title: &str,
    body: &str,
) -> Result<String, String> {
    let (a, pat) = require(app)?;
    let base = a.url;
    let (project, repo) = project_and_repo(remote, &base)
        .ok_or_else(|| tr!("這個儲存庫不在目前連線的 Azure DevOps 上"))?;
    let what = &tr!("建立 Pull Request");
    let info = get(
        &base,
        &pat,
        &format!("/{project}/_apis/git/repositories/{repo}"),
        what,
    )?;
    let id = str_of(&info, "id")
        .ok_or_else(|| tr!("讀取儲存庫失敗"))?
        .to_string();
    let target = str_of(&info, "defaultBranch")
        .unwrap_or("refs/heads/main")
        .to_string();
    if target == format!("refs/heads/{branch}") {
        return Err(tr!(
            "目前在預設分支「{branch}」上，請先建立新分支再建立 Pull Request",
            branch = branch
        ));
    }
    let web = str_of(&info, "webUrl")
        .map(str::to_string)
        .unwrap_or_else(|| format!("{base}/{project}/_git/{repo}"));
    let res = post(
        &base,
        &pat,
        &format!("/{project}/_apis/git/repositories/{id}/pullrequests"),
        &serde_json::json!({
            "sourceRefName": format!("refs/heads/{branch}"),
            "targetRefName": target,
            "title": title,
            "description": body,
        }),
        what,
    )
    .map_err(|e| {
        if e.contains("409") {
            tr!(
                "{what}失敗：這個分支已經有一個開著的 Pull Request",
                what = what
            )
        } else {
            e
        }
    })?;
    let number = res
        .get("pullRequestId")
        .and_then(Value::as_u64)
        .ok_or_else(|| tr!("建立 Pull Request 失敗：回應的格式不正確"))?;
    Ok(format!("{web}/pullrequest/{number}"))
}

// ---- 工作項目 ---------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    id: u64,
    title: String,
    state: String,
    kind: String,
    project: String,
    /// 指派給誰（清單上看所有人的工作項目時顯示）。
    assigned_to: Option<String>,
    changed: Option<String>,
    /// 優先順序（1 最高）；流程範本沒有這個欄位時是空的。
    priority: Option<u64>,
    web_url: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemDetail {
    #[serde(flatten)]
    item: WorkItem,
    created_by: Option<String>,
    /// 區域與反覆項目（例如「產品\前端」「產品\Sprint 3」）。
    area: Option<String>,
    iteration: Option<String>,
    tags: Vec<String>,
    /// 說明（HTML，前端轉成 Markdown 顯示）。
    description: Option<String>,
    /// 驗收條件或重現步驟（HTML）。
    details: Option<String>,
    /// 留言（舊到新）；伺服器不支援或讀不到時是空的。
    comments: Vec<WorkItemComment>,
    /// 修訂版本（改狀態、指派時用來確認這段時間沒有被別人改過）。
    rev: Option<u64>,
    /// 相關的工作項目（上層、子項目、相關、前置、後續…）；讀不到時是空的。
    relations: Vec<WorkItemRelation>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemRelation {
    /// `parent`、`child`、`related`、`predecessor`、`successor` 或 `other`。
    link: &'static str,
    /// 伺服器上的連結名稱（例如 Parent、Tested By），`other` 時顯示。
    link_name: String,
    #[serde(flatten)]
    item: WorkItem,
}

/// 最多列出幾個相關的工作項目（一次查詢的上限是 200）。
const MAX_RELATIONS: usize = 200;

/// 關聯裡連到其他工作項目的部分：(種類, 名稱, 編號)；附件、超連結、認可、PR 等略過。
fn relation_links(v: &Value) -> Vec<(&'static str, String, u64)> {
    let mut seen = std::collections::HashSet::new();
    v.get("relations")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|r| {
            let rel = str_of(r, "rel")?;
            let url = str_of(r, "url")?;
            let at = url.to_ascii_lowercase().rfind("/workitems/")?;
            let id: u64 = url[at + "/workitems/".len()..].parse().ok()?;
            let link = match rel {
                "System.LinkTypes.Hierarchy-Reverse" => "parent",
                "System.LinkTypes.Hierarchy-Forward" => "child",
                "System.LinkTypes.Related" => "related",
                "System.LinkTypes.Dependency-Reverse" => "predecessor",
                "System.LinkTypes.Dependency-Forward" => "successor",
                _ => "other",
            };
            let name = r
                .get("attributes")
                .and_then(|a| str_of(a, "name"))
                .unwrap_or(rel)
                .to_string();
            seen.insert((link, id)).then_some((link, name, id))
        })
        .take(MAX_RELATIONS)
        .collect()
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemComment {
    author: String,
    created: Option<String>,
    /// HTML。
    text: String,
}

/// 指派給我、還沒結束的工作項目；中英文的流程範本都有對應的「結束」狀態名稱。
const CLOSED_STATES: &[&str] = &[
    "Closed",
    "Done",
    "Removed",
    "Completed",
    "Cut",
    "Inactive",
    // 中文的流程範本（不是介面文字）。
    "已關閉", // i18n-ignore
    "已完成", // i18n-ignore
    "已移除", // i18n-ignore
    "已刪除", // i18n-ignore
    "關閉",   // i18n-ignore
    "完成",   // i18n-ignore
];
const FIELDS: &str = "System.Id,System.Title,System.State,System.WorkItemType,System.TeamProject,System.AssignedTo,System.ChangedDate";
/// 優先順序欄位（清單排序用）；自訂的流程範本可能沒有。
const PRIORITY: &str = "Microsoft.VSTS.Common.Priority";

fn wiql_string(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 工作項目清單的篩選條件（前端的篩選列）。
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkItemFilter {
    /// 依 `assigned`（指派給）或 `created`（建立者）篩選人。
    pub role: String,
    /// `@me`（我）、空字串（不限）或名字（部分符合即可）。
    pub person: String,
    /// `open`（還沒結束）、`closed`（已結束）或 `all`。
    pub state: String,
    pub kind: Option<String>,
    pub project: Option<String>,
    /// 區域路徑（例如 `產品\前端`），包含底下的區域。
    pub area: Option<String>,
}

impl Default for WorkItemFilter {
    fn default() -> Self {
        WorkItemFilter {
            role: "assigned".into(),
            person: "@me".into(),
            state: "open".into(),
            kind: None,
            project: None,
            area: None,
        }
    }
}

fn filled(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

/// 搜尋內容時一併搜尋的長文字欄位（全文搜尋）。伺服器沒有全文索引、或流程範本沒有某個欄位時
/// 查詢會失敗，所以依序退回較少的欄位，最後只搜尋標題。
const CONTENT_FIELDS: [&[&str]; 3] = [
    &[
        "System.Description",
        "Microsoft.VSTS.TCM.ReproSteps",
        "Microsoft.VSTS.Common.AcceptanceCriteria",
    ],
    &["System.Description"],
    &[],
];

/// 依搜尋文字與篩選條件產生 WIQL；輸入的是編號（`123`、`#123`）時回傳 None，直接讀取那一個。
fn wiql_for(search: &str, f: &WorkItemFilter, content: &[&str]) -> Option<String> {
    let q = search.trim().trim_start_matches('#');
    if q.chars().all(|c| c.is_ascii_digit()) && !q.is_empty() {
        return None;
    }
    let mut cond: Vec<String> = vec![];
    let role = if f.role == "created" {
        "System.CreatedBy"
    } else {
        "System.AssignedTo"
    };
    match f.person.trim() {
        "" => {}
        "@me" => cond.push(format!("[{role}] = @Me")),
        name => cond.push(format!("[{role}] CONTAINS {}", wiql_string(name))),
    }
    let closed: Vec<String> = CLOSED_STATES.iter().map(|s| wiql_string(s)).collect();
    match f.state.as_str() {
        "open" => cond.push(format!("[System.State] NOT IN ({})", closed.join(", "))),
        "closed" => cond.push(format!("[System.State] IN ({})", closed.join(", "))),
        _ => {}
    }
    if let Some(k) = filled(&f.kind) {
        cond.push(format!("[System.WorkItemType] = {}", wiql_string(k)));
    }
    if let Some(p) = filled(&f.project) {
        cond.push(format!("[System.TeamProject] = {}", wiql_string(p)));
    }
    if let Some(a) = filled(&f.area) {
        cond.push(format!("[System.AreaPath] UNDER {}", wiql_string(a)));
    }
    if !q.is_empty() {
        let mut any = vec![format!("[System.Title] CONTAINS {}", wiql_string(q))];
        for field in content {
            any.push(format!("[{field}] CONTAINS WORDS {}", wiql_string(q)));
        }
        cond.push(format!("({})", any.join(" OR ")));
    }
    if cond.is_empty() {
        cond.push("[System.Id] > 0".into());
    }
    Some(format!(
        "SELECT [System.Id] FROM WorkItems WHERE {} ORDER BY [System.ChangedDate] DESC",
        cond.join(" AND ")
    ))
}

fn work_item_url(base: &str, project: &str, id: u64) -> String {
    format!("{base}/{}/_workitems/edit/{id}", encode_segment(project))
}

fn field<'a>(item: &'a Value, name: &str) -> Option<&'a Value> {
    item.get("fields")?.get(name)
}

fn field_str(item: &Value, name: &str) -> String {
    field(item, name)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn item_of(base: &str, v: &Value) -> Option<WorkItem> {
    let id = v.get("id").and_then(Value::as_u64)?;
    let project = field_str(v, "System.TeamProject");
    Some(WorkItem {
        id,
        title: field_str(v, "System.Title"),
        state: field_str(v, "System.State"),
        kind: field_str(v, "System.WorkItemType"),
        web_url: work_item_url(base, &project, id),
        project,
        assigned_to: person(field(v, "System.AssignedTo")),
        changed: field(v, "System.ChangedDate")
            .and_then(Value::as_str)
            .map(str::to_string),
        priority: field(v, PRIORITY).and_then(Value::as_u64),
    })
}

/// 指派對象：新版是物件（取 displayName），舊版是「名字 <網域\帳號>」字串。
fn person(v: Option<&Value>) -> Option<String> {
    let v = v?;
    let name = match v {
        Value::Object(_) => str_of(v, "displayName")?.to_string(),
        Value::String(s) => s.split(" <").next().unwrap_or(s).to_string(),
        _ => return None,
    };
    Some(name).filter(|n| !n.trim().is_empty())
}

/// 工作項目清單（最多 100 個）：搜尋文字空白時是「指派給我、還沒結束的」。
#[tauri::command]
pub async fn ado_work_items(
    app: AppHandle,
    search: String,
    filter: Option<WorkItemFilter>,
) -> Result<Vec<WorkItem>, String> {
    let (a, pat) = require(&app)?;
    let filter = filter.unwrap_or_default();
    crate::io::blocking_for(TIMEOUT, move || {
        let base = a.url;
        let ids: Vec<u64> = if wiql_for(&search, &filter, &[]).is_none() {
            vec![search.trim().trim_start_matches('#').parse().unwrap_or(0)]
        } else {
            let mut last = String::new();
            let mut found = None;
            // 有搜尋文字時先試全文搜尋內容，失敗（伺服器不支援）再退回較少的欄位。
            let levels: &[&[&str]] = if search.trim().is_empty() {
                &[&[]]
            } else {
                &CONTENT_FIELDS
            };
            for content in levels {
                let query = wiql_for(&search, &filter, content).unwrap_or_default();
                match post(
                    &base,
                    &pat,
                    "/_apis/wit/wiql?$top=100",
                    &serde_json::json!({ "query": query }),
                    &tr!("查詢工作項目"),
                ) {
                    Ok(res) => {
                        found = Some(res);
                        break;
                    }
                    // 權杖或權限的問題換欄位也沒用。
                    Err(e) if e.contains("401") || e.contains("403") => return Err(e),
                    Err(e) => last = e,
                }
            }
            let res = found.ok_or(last)?;
            res.get("workItems")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|w| w.get("id").and_then(Value::as_u64))
                        .take(100)
                        .collect()
                })
                .unwrap_or_default()
        };
        if ids.is_empty() {
            return Ok(vec![]);
        }
        fetch_work_items(&base, &pat, &ids)
    })
    .await
}

/// 讀取工作項目的摘要，保持 `ids` 的順序（查詢的排序）；讀不到的略過。
fn fetch_work_items(base: &str, pat: &str, ids: &[u64]) -> Result<Vec<WorkItem>, String> {
    let list: Vec<String> = ids.iter().map(u64::to_string).collect();
    let fetch = |fields: &str| {
        get(
            base,
            pat,
            &format!(
                "/_apis/wit/workitems?ids={}&fields={fields}&errorPolicy=omit",
                list.join(",")
            ),
            &tr!("讀取工作項目"),
        )
    };
    // 連優先順序一起讀；流程範本沒有這個欄位（伺服器回錯誤）時改成不讀。
    let res = match fetch(&format!("{FIELDS},{PRIORITY}")) {
        Ok(res) => res,
        Err(e) if e.contains("401") || e.contains("403") => return Err(e),
        Err(_) => fetch(FIELDS)?,
    };
    let mut items: Vec<WorkItem> = values(&res)
        .iter()
        .filter_map(|v| item_of(base, v))
        .collect();
    // 保持查詢的排序（最近更新的在前面）。
    items.sort_by_key(|w| ids.iter().position(|id| *id == w.id).unwrap_or(usize::MAX));
    Ok(items)
}

/// TFS 上存的查詢（我的查詢、共用查詢）。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    id: String,
    project: String,
    name: String,
    /// 所在的資料夾（例如 `Shared Queries/團隊`）。
    folder: String,
}

/// 查詢樹（`wit/queries?$depth=2`）攤平成查詢清單（資料夾不列）。
fn flatten_queries(project: &str, nodes: &[Value], out: &mut Vec<SavedQuery>) {
    for node in nodes {
        if node
            .get("isFolder")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            if let Some(children) = node.get("children").and_then(Value::as_array) {
                flatten_queries(project, children, out);
            }
            continue;
        }
        let (Some(id), Some(name)) = (str_of(node, "id"), str_of(node, "name")) else {
            continue;
        };
        let path = str_of(node, "path").unwrap_or(name);
        let folder = path.rsplit_once('/').map_or("", |(f, _)| f).to_string();
        out.push(SavedQuery {
            id: id.to_string(),
            project: project.to_string(),
            name: name.to_string(),
            folder,
        });
    }
}

/// 所有專案（最多 20 個）存的查詢；讀不到的專案略過。
#[tauri::command]
pub async fn ado_queries(app: AppHandle) -> Result<Vec<SavedQuery>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let res = get(&a.url, &pat, "/_apis/projects?$top=1000", &tr!("讀取專案"))?;
        let mut projects: Vec<String> = values(&res)
            .iter()
            .filter_map(|p| str_of(p, "name").map(str::to_string))
            .collect();
        projects.sort_by_key(|p| p.to_lowercase());
        let mut out = vec![];
        for project in projects.iter().take(20) {
            let path = format!(
                "/{}/_apis/wit/queries?$depth=2&$expand=minimal",
                encode_segment(project)
            );
            if let Ok(res) = get(&a.url, &pat, &path, &tr!("讀取已儲存的查詢")) {
                flatten_queries(project, values(&res), &mut out);
            }
        }
        Ok(out)
    })
    .await
}

/// 查詢結果裡的工作項目編號（一般查詢是 `workItems`，樹狀、連結查詢是 `workItemRelations`），不重複、照順序。
fn query_ids(v: &Value) -> Vec<u64> {
    let mut ids: Vec<u64> = vec![];
    let mut push = |id: Option<u64>| {
        if let Some(id) = id {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    };
    for w in v
        .get("workItems")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        push(w.get("id").and_then(Value::as_u64));
    }
    for r in v
        .get("workItemRelations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        push(r.pointer("/source/id").and_then(Value::as_u64));
        push(r.pointer("/target/id").and_then(Value::as_u64));
    }
    ids.truncate(200);
    ids
}

/// 執行存的查詢，回傳工作項目（最多 200 個，照查詢的排序）。
#[tauri::command]
pub async fn ado_query_run(
    app: AppHandle,
    project: String,
    id: String,
) -> Result<Vec<WorkItem>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let path = format!(
            "/{}/_apis/wit/wiql/{}?$top=200",
            encode_segment(&project),
            encode_segment(&id)
        );
        let res = get(&a.url, &pat, &path, &tr!("執行查詢"))?;
        let ids = query_ids(&res);
        if ids.is_empty() {
            return Ok(vec![]);
        }
        // 一次最多讀 200 個（伺服器的上限）。
        fetch_work_items(&a.url, &pat, &ids)
    })
    .await
}

/// 依編號讀取工作項目（文件裡連結旁的狀態標籤用）；最多 200 個，讀不到的（刪除、沒權限）略過。
#[tauri::command]
pub async fn ado_work_items_by_ids(app: AppHandle, ids: Vec<u64>) -> Result<Vec<WorkItem>, String> {
    let (a, pat) = require(&app)?;
    let mut ids = ids;
    ids.sort_unstable();
    ids.dedup();
    ids.truncate(200);
    if ids.is_empty() {
        return Ok(vec![]);
    }
    crate::io::blocking_for(TIMEOUT, move || {
        let list: Vec<String> = ids.iter().map(u64::to_string).collect();
        let res = get(
            &a.url,
            &pat,
            &format!(
                "/_apis/wit/workitems?ids={}&fields={FIELDS}&errorPolicy=omit",
                list.join(",")
            ),
            &tr!("讀取工作項目"),
        )?;
        Ok(values(&res)
            .iter()
            .filter_map(|v| item_of(&a.url, v))
            .collect())
    })
    .await
}

/// 工作項目的上層項目（例如 Task 屬於哪個 User Story）：`links` 是 (項目, 上層)，`parents` 是上層項目本身（分組標題用）。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemParents {
    links: Vec<(u64, u64)>,
    parents: Vec<WorkItem>,
}

/// 新版伺服器有 `System.Parent` 欄位。
fn parent_field(v: &Value) -> Option<(u64, u64)> {
    Some((v.get("id")?.as_u64()?, field(v, "System.Parent")?.as_u64()?))
}

/// 舊版（TFS 2019 以前）沒有那個欄位，從關聯裡找「上層」。
fn parent_relation(v: &Value) -> Option<(u64, u64)> {
    let id = v.get("id")?.as_u64()?;
    let parent = relation_links(v)
        .into_iter()
        .find(|(link, ..)| *link == "parent")?
        .2;
    Some((id, parent))
}

/// 依清單上的工作項目讀出上層項目（「依上層項目分組」用）；最多 200 個。
#[tauri::command]
pub async fn ado_work_item_parents(
    app: AppHandle,
    ids: Vec<u64>,
) -> Result<WorkItemParents, String> {
    let (a, pat) = require(&app)?;
    let mut ids = ids;
    ids.sort_unstable();
    ids.dedup();
    ids.truncate(200);
    if ids.is_empty() {
        return Ok(WorkItemParents {
            links: vec![],
            parents: vec![],
        });
    }
    crate::io::blocking_for(TIMEOUT, move || {
        let list = ids.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
        let what = tr!("讀取上層項目");
        let links: Vec<(u64, u64)> = match get(
            &a.url,
            &pat,
            &format!(
                "/_apis/wit/workitems?ids={list}&fields=System.Id,System.Parent&errorPolicy=omit"
            ),
            &what,
        ) {
            Ok(res) => values(&res).iter().filter_map(parent_field).collect(),
            Err(e) if e.contains("401") || e.contains("403") => return Err(e),
            // 沒有 System.Parent 欄位的伺服器：改讀關聯（會帶回所有欄位，比較慢）。
            Err(_) => {
                let res = get(
                    &a.url,
                    &pat,
                    &format!("/_apis/wit/workitems?ids={list}&$expand=relations&errorPolicy=omit"),
                    &what,
                )?;
                values(&res).iter().filter_map(parent_relation).collect()
            }
        };
        let mut parent_ids: Vec<u64> = links.iter().map(|(_, p)| *p).collect();
        parent_ids.sort_unstable();
        parent_ids.dedup();
        let parents = if parent_ids.is_empty() {
            vec![]
        } else {
            fetch_work_items(&a.url, &pat, &parent_ids)?
        };
        Ok(WorkItemParents { links, parents })
    })
    .await
}

/// 一個工作項目的內容。
/// 篩選列的選項：專案與工作項目類型。
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemFilterOptions {
    projects: Vec<String>,
    kinds: Vec<String>,
}

/// 不會出現在一般清單的類型（測試、程式碼檢閱、意見反應等）。
const HIDDEN_KINDS: &[&str] = &[
    "Code Review Request",
    "Code Review Response",
    "Feedback Request",
    "Feedback Response",
    "Shared Steps",
    "Shared Parameter",
    "Test Case",
    "Test Plan",
    "Test Suite",
];

#[tauri::command]
pub async fn ado_work_item_filters(app: AppHandle) -> Result<WorkItemFilterOptions, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let res = get(&a.url, &pat, "/_apis/projects?$top=1000", &tr!("讀取專案"))?;
        let mut projects: Vec<String> = values(&res)
            .iter()
            .filter_map(|p| str_of(p, "name").map(str::to_string))
            .collect();
        projects.sort_by_key(|p| p.to_lowercase());
        let mut kinds: Vec<String> = vec![];
        for p in projects.iter().take(20) {
            let path = format!("/{}/_apis/wit/workitemtypes", encode_segment(p));
            let Ok(res) = get(&a.url, &pat, &path, &tr!("讀取工作項目類型")) else {
                continue;
            };
            for k in values(&res).iter().filter_map(|t| str_of(t, "name")) {
                if !HIDDEN_KINDS.contains(&k) && !kinds.iter().any(|x| x == k) {
                    kinds.push(k.to_string());
                }
            }
        }
        kinds.sort_by_key(|k| k.to_lowercase());
        Ok(WorkItemFilterOptions { projects, kinds })
    })
    .await
}

/// 一個專案（或所有專案）可以篩選的區域與人。
#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemScopeOptions {
    /// 區域路徑（不含專案本身），依樹狀順序。
    areas: Vec<String>,
    /// 團隊成員的顯示名稱。
    people: Vec<String>,
}

const MAX_AREAS: usize = 500;
const MAX_TEAMS: usize = 20;

/// 把區域樹攤平成路徑（`產品\前端\登入`）；最上層是專案本身，不列出。
fn area_paths(root: &Value) -> Vec<String> {
    fn walk(node: &Value, path: &str, out: &mut Vec<String>) {
        for child in node
            .get("children")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            if out.len() >= MAX_AREAS {
                return;
            }
            let Some(name) = str_of(child, "name") else {
                continue;
            };
            let p = format!("{path}\\{name}");
            out.push(p.clone());
            walk(child, &p, out);
        }
    }
    let mut out = vec![];
    if let Some(name) = str_of(root, "name") {
        walk(root, name, &mut out);
    }
    out
}

/// 團隊成員的名字：新版在 `identity` 裡，舊版直接是成員；群組不列出。
fn member_names(res: &Value) -> Vec<String> {
    values(res)
        .iter()
        .map(|m| m.get("identity").unwrap_or(m))
        .filter(|m| m.get("isContainer").and_then(Value::as_bool) != Some(true))
        .filter_map(|m| str_of(m, "displayName"))
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .collect()
}

/// 篩選列的區域與人：有選專案時讀那個專案的區域與團隊成員；沒選時只讀前幾個專案的成員。
#[tauri::command]
pub async fn ado_work_item_scope(
    app: AppHandle,
    project: Option<String>,
) -> Result<WorkItemScopeOptions, String> {
    let (a, pat) = require(&app)?;
    let project = project.filter(|p| !p.trim().is_empty());
    crate::io::blocking_for(TIMEOUT, move || {
        let mut areas = vec![];
        let projects: Vec<String> = match &project {
            Some(p) => {
                let path = format!(
                    "/{}/_apis/wit/classificationnodes/areas?$depth=10",
                    encode_segment(p)
                );
                areas = area_paths(&get(&a.url, &pat, &path, &tr!("讀取區域"))?);
                vec![p.clone()]
            }
            None => {
                let res = get(&a.url, &pat, "/_apis/projects?$top=10", &tr!("讀取專案"))?;
                values(&res)
                    .iter()
                    .filter_map(|p| str_of(p, "name").map(str::to_string))
                    .collect()
            }
        };
        let mut seen = std::collections::HashSet::new();
        let mut people: Vec<String> = vec![];
        let mut teams = 0;
        // 讀不到成員（權限不足、舊版伺服器）時只是沒有建議名字，仍可自己輸入。
        'projects: for p in &projects {
            let path = format!("/_apis/projects/{}/teams?$top=100", encode_segment(p));
            let Ok(res) = get(&a.url, &pat, &path, &tr!("讀取團隊")) else {
                continue;
            };
            for team in values(&res) {
                if teams >= MAX_TEAMS {
                    break 'projects;
                }
                let Some(id) = str_of(team, "id") else {
                    continue;
                };
                teams += 1;
                let path = format!(
                    "/_apis/projects/{}/teams/{}/members?$top=1000",
                    encode_segment(p),
                    encode_segment(id)
                );
                if let Ok(res) = get(&a.url, &pat, &path, &tr!("讀取團隊成員")) {
                    for name in member_names(&res) {
                        if seen.insert(name.clone()) {
                            people.push(name);
                        }
                    }
                }
            }
        }
        people.sort_by_key(|n| n.to_lowercase());
        Ok(WorkItemScopeOptions { areas, people })
    })
    .await
}

#[tauri::command]
pub async fn ado_work_item(app: AppHandle, id: u64) -> Result<WorkItemDetail, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let v = get(
            &a.url,
            &pat,
            &format!("/_apis/wit/workitems/{id}?$expand=relations"),
            &tr!("讀取工作項目"),
        )?;
        let mut d =
            detail_of(&a.url, &v).ok_or_else(|| tr!("讀取工作項目失敗：回應的格式不正確"))?;
        // 相關工作項目的標題、狀態要另外查；讀不到不影響其他內容。
        let links = relation_links(&v);
        if !links.is_empty() {
            let mut ids: Vec<u64> = links.iter().map(|(_, _, id)| *id).collect();
            ids.sort_unstable();
            ids.dedup();
            let ids: Vec<String> = ids.iter().map(u64::to_string).collect();
            let path = format!(
                "/_apis/wit/workitems?ids={}&fields={FIELDS}&errorPolicy=omit",
                ids.join(",")
            );
            if let Ok(res) = get(&a.url, &pat, &path, &tr!("讀取工作項目")) {
                let items: Vec<WorkItem> = values(&res)
                    .iter()
                    .filter_map(|v| item_of(&a.url, v))
                    .collect();
                d.relations = links
                    .into_iter()
                    .filter_map(|(link, link_name, id)| {
                        let item = items.iter().find(|w| w.id == id)?.clone();
                        Some(WorkItemRelation {
                            link,
                            link_name,
                            item,
                        })
                    })
                    .collect();
            }
        }
        // 留言是另外的 API（2019 起的預覽版）；讀不到不影響其他內容。
        let path = format!(
            "/{}/_apis/wit/workItems/{id}/comments",
            encode_segment(&d.item.project)
        );
        if let Ok(c) = get_version(&a.url, &pat, &path, Some("5.0-preview.2"), &tr!("讀取留言"))
        {
            d.comments = comments_of(&c);
        }
        Ok(d)
    })
    .await
}

fn comments_of(v: &Value) -> Vec<WorkItemComment> {
    let mut list: Vec<WorkItemComment> = v
        .get("comments")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|c| {
            let text = str_of(c, "text")?.trim().to_string();
            (!text.is_empty()).then(|| WorkItemComment {
                author: person(c.get("createdBy")).unwrap_or_default(),
                created: str_of(c, "createdDate").map(str::to_string),
                text,
            })
        })
        .collect();
    list.sort_by(|a, b| a.created.cmp(&b.created));
    list
}

// ---- 工作項目：改狀態、指派給我、留言 ---------------------------------------------

/// 這個類型的工作項目可以設定的狀態（依流程的順序）。
#[tauri::command]
pub async fn ado_work_item_states(
    app: AppHandle,
    project: String,
    kind: String,
) -> Result<Vec<String>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let what = tr!("讀取工作項目的狀態");
        let base = format!(
            "/{}/_apis/wit/workitemtypes/{}",
            encode_segment(&project),
            encode_segment(&kind)
        );
        // 狀態清單是 2018 起的預覽版 API；舊版伺服器改從類型定義的狀態轉換整理出來。
        if let Ok(v) = get_version(
            &a.url,
            &pat,
            &format!("{base}/states"),
            Some("4.1-preview.1"),
            &what,
        ) {
            let states: Vec<String> = values(&v)
                .iter()
                .filter_map(|s| str_of(s, "name").map(str::to_string))
                .collect();
            if !states.is_empty() {
                return Ok(states);
            }
        }
        let v = get(&a.url, &pat, &base, &what)?;
        Ok(states_from_transitions(&v))
    })
    .await
}

/// 類型定義裡的狀態轉換（`{"Active": [{"to": "Resolved"}], ...}`）出現過的所有狀態。
fn states_from_transitions(v: &Value) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut add = |s: &str| {
        if !s.is_empty() && !out.iter().any(|x| x == s) {
            out.push(s.to_string());
        }
    };
    if let Some(map) = v.get("transitions").and_then(Value::as_object) {
        for (from, list) in map {
            add(from);
            for t in list.as_array().map_or(&[][..], Vec::as_slice) {
                add(str_of(t, "to").unwrap_or_default());
            }
        }
    }
    out
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkItemChange {
    pub state: Option<String>,
    pub assign_to_me: bool,
    /// 留言（HTML），加到討論裡。
    pub comment: Option<String>,
    /// 開啟時的修訂版本：伺服器上的版本不同（被別人改過）時不更新。
    pub rev: Option<u64>,
}

/// 更新工作項目要送出的 JSON Patch。`me` 是登入的帳號（指派給我用）。
fn change_ops(change: &WorkItemChange, me: &str) -> Vec<Value> {
    let mut ops = vec![];
    if let Some(rev) = change.rev {
        ops.push(serde_json::json!({ "op": "test", "path": "/rev", "value": rev }));
    }
    if let Some(state) = change.state.as_deref().filter(|s| !s.is_empty()) {
        ops.push(
            serde_json::json!({ "op": "add", "path": "/fields/System.State", "value": state }),
        );
    }
    if change.assign_to_me {
        ops.push(
            serde_json::json!({ "op": "add", "path": "/fields/System.AssignedTo", "value": me }),
        );
    }
    if let Some(comment) = change.comment.as_deref().filter(|c| !c.trim().is_empty()) {
        // System.History 就是工作項目的討論（所有版本的伺服器都支援）。
        ops.push(
            serde_json::json!({ "op": "add", "path": "/fields/System.History", "value": comment }),
        );
    }
    ops
}

/// 改狀態、指派給我、留言（可以一起）。
#[tauri::command]
pub async fn ado_work_item_update(
    app: AppHandle,
    id: u64,
    change: WorkItemChange,
) -> Result<(), String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let me = a.account.clone().unwrap_or_else(|| a.name.clone());
        let ops = change_ops(&change, &me);
        if ops.iter().all(|op| op["op"] == "test") {
            return Ok(());
        }
        let res = crate::update::agent()
            .patch(&format!(
                "{}/_apis/wit/workitems/{id}?api-version={API_VERSION}",
                a.url
            ))
            .config()
            .http_status_as_error(false)
            .build()
            .header("Authorization", &basic(&pat))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json-patch+json")
            .send(&Value::Array(ops).to_string());
        let mut r = res.map_err(|e| {
            tr!(
                "更新工作項目失敗：連不到 Azure DevOps 伺服器，請確認網路或 VPN 連線（{e}）",
                e = e
            )
        })?;
        let code = r.status().as_u16();
        if code < 400 {
            return Ok(());
        }
        let text = r.body_mut().read_to_string().unwrap_or_default();
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| str_of(&v, "message").map(str::to_string))
            .unwrap_or_default();
        Err(match code {
            401 => tr!("更新工作項目失敗：個人存取權杖無效或已過期，或權杖沒有「工作項目：讀取與寫入」的權限"),
            403 => tr!("更新工作項目失敗：沒有權限修改這個工作項目"),
            // 修訂版本不同：開啟之後被別人改過了。
            409 | 412 => tr!("這個工作項目在你開啟之後被別人改過了，請重新整理後再試一次"),
            _ if message.is_empty() => tr!("更新工作項目失敗：伺服器回應 {code}", code = code),
            _ => tr!("更新工作項目失敗：{message}", message = message),
        })
    })
    .await
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NewWorkItem {
    pub project: String,
    pub kind: String,
    pub title: String,
    /// 內容（HTML）；Bug 放在「重現步驟」，其他類型放在「描述」。
    pub description: Option<String>,
    pub assign_to_me: bool,
    /// 上層工作項目的編號。
    pub parent: Option<u64>,
}

/// 建立工作項目要送出的 JSON Patch。`me` 是登入的帳號，`base` 是集合的網址（上層連結用）。
fn create_ops(item: &NewWorkItem, me: &str, base: &str) -> Vec<Value> {
    let mut ops = vec![
        serde_json::json!({ "op": "add", "path": "/fields/System.Title", "value": item.title.trim() }),
    ];
    if let Some(html) = item.description.as_deref().filter(|d| !d.trim().is_empty()) {
        let field = if item.kind.eq_ignore_ascii_case("Bug") {
            "Microsoft.VSTS.TCM.ReproSteps"
        } else {
            "System.Description"
        };
        ops.push(
            serde_json::json!({ "op": "add", "path": format!("/fields/{field}"), "value": html }),
        );
    }
    if item.assign_to_me {
        ops.push(
            serde_json::json!({ "op": "add", "path": "/fields/System.AssignedTo", "value": me }),
        );
    }
    if let Some(parent) = item.parent {
        ops.push(serde_json::json!({
            "op": "add",
            "path": "/relations/-",
            "value": {
                "rel": "System.LinkTypes.Hierarchy-Reverse",
                "url": format!("{}/_apis/wit/workItems/{parent}", base.trim_end_matches('/')),
            }
        }));
    }
    ops
}

/// 建立工作項目，回傳新的工作項目。
#[tauri::command]
pub async fn ado_work_item_create(app: AppHandle, item: NewWorkItem) -> Result<WorkItem, String> {
    let (a, pat) = require(&app)?;
    if item.title.trim().is_empty() {
        return Err(tr!("請輸入標題"));
    }
    crate::io::blocking_for(TIMEOUT, move || {
        let me = a.account.clone().unwrap_or_else(|| a.name.clone());
        let ops = create_ops(&item, &me, &a.url);
        let res = crate::update::agent()
            .post(&format!(
                "{}/{}/_apis/wit/workitems/${}?api-version={API_VERSION}",
                a.url,
                encode_segment(&item.project),
                encode_segment(&item.kind)
            ))
            .config()
            .http_status_as_error(false)
            .build()
            .header("Authorization", &basic(&pat))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json-patch+json")
            .send(&Value::Array(ops).to_string());
        let mut r = res.map_err(|e| {
            tr!(
                "建立工作項目失敗：連不到 Azure DevOps 伺服器，請確認網路或 VPN 連線（{e}）",
                e = e
            )
        })?;
        let code = r.status().as_u16();
        let text = r.body_mut().read_to_string().unwrap_or_default();
        let v = serde_json::from_str::<Value>(&text).ok();
        if code < 400 {
            return v
                .as_ref()
                .and_then(|v| item_of(&a.url, v))
                .ok_or_else(|| tr!("建立工作項目失敗：伺服器的回應不是預期的格式"));
        }
        let message = v
            .as_ref()
            .and_then(|v| str_of(v, "message").map(str::to_string))
            .unwrap_or_default();
        Err(match code {
            401 => tr!("建立工作項目失敗：個人存取權杖無效或已過期，或權杖沒有「工作項目：讀取與寫入」的權限"),
            403 => tr!("建立工作項目失敗：沒有權限在這個專案建立工作項目"),
            _ if message.is_empty() => tr!("建立工作項目失敗：伺服器回應 {code}", code = code),
            _ => tr!("建立工作項目失敗：{message}", message = message),
        })
    })
    .await
}

/// 工作項目內文裡的圖片：附件要用權杖才能讀，網頁元件自己載不到。
/// 只讀取連線中那台伺服器上的網址，不跟隨轉址（權杖不會被送到別的地方），回傳 data: 網址。
#[tauri::command]
pub async fn ado_image(app: AppHandle, url: String) -> Result<String, String> {
    let (a, pat) = require(&app)?;
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://"))
        || !same_server(&url, &a.url)
    {
        return Err(tr!("只能讀取 Azure DevOps 伺服器上的圖片"));
    }
    crate::io::blocking_for(TIMEOUT, move || {
        let mut res = crate::update::agent()
            .get(&url)
            .config()
            .max_redirects(0)
            .build()
            .header("Authorization", &basic(&pat))
            .call()
            .map_err(|e| tr!("無法讀取圖片：{e}", e = e))?;
        let mime = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if !mime.starts_with("image/") || mime == "image/svg+xml" {
            return Err(tr!("無法讀取圖片：不是圖片"));
        }
        let bytes = res
            .body_mut()
            .with_config()
            .limit(10 * 1024 * 1024)
            .read_to_vec()
            .map_err(|e| tr!("無法讀取圖片：{e}", e = e))?;
        Ok(data_url(&mime, bytes))
    })
    .await
}

// ---- Wiki -------------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Wiki {
    id: String,
    name: String,
    project: String,
    project_id: String,
    /// 從程式碼儲存庫發佈的 Wiki（不是專案 Wiki）。
    code: bool,
    repository_id: String,
    /// 程式碼 Wiki 在儲存庫裡的資料夾（專案 Wiki 是 `/`）。
    mapped_path: String,
    /// 分支（程式碼 Wiki 讀頁面時要指定）。
    version: Option<String>,
    web_url: Option<String>,
}

fn wikis_from(wikis: &Value, projects: &Value) -> Vec<Wiki> {
    let mut out: Vec<Wiki> = values(wikis)
        .iter()
        .filter_map(|w| {
            let project_id = str_of(w, "projectId")?;
            let project = values(projects)
                .iter()
                .find(|p| str_of(p, "id") == Some(project_id))
                .and_then(|p| str_of(p, "name"))
                .unwrap_or(project_id);
            Some(Wiki {
                id: str_of(w, "id")?.to_string(),
                name: str_of(w, "name")?.to_string(),
                project: project.to_string(),
                project_id: project_id.to_string(),
                code: str_of(w, "type") == Some("codeWiki"),
                repository_id: str_of(w, "repositoryId")?.to_string(),
                mapped_path: str_of(w, "mappedPath").unwrap_or("/").to_string(),
                version: w
                    .pointer("/versions/0/version")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                web_url: str_of(w, "remoteUrl").map(str::to_string),
            })
        })
        .collect();
    out.sort_by_key(|w| (w.project.to_lowercase(), w.code, w.name.to_lowercase()));
    out
}

/// 集合裡所有的 Wiki（專案 Wiki 與程式碼 Wiki）。
#[tauri::command]
pub async fn ado_wikis(app: AppHandle) -> Result<Vec<Wiki>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let wikis = get(&a.url, &pat, "/_apis/wiki/wikis", &tr!("讀取 Wiki"))?;
        let projects =
            get(&a.url, &pat, "/_apis/projects?$top=1000", &tr!("讀取專案")).unwrap_or(Value::Null);
        Ok(wikis_from(&wikis, &projects))
    })
    .await
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WikiPage {
    /// 頁面路徑，例如 `/產品/安裝說明`。
    path: String,
    /// 頁面編號（瀏覽器網址列上的數字）；舊版伺服器沒有。
    id: Option<u64>,
    children: Vec<WikiPage>,
}

fn page_tree(v: &Value) -> Vec<WikiPage> {
    v.get("subPages")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|p| {
            Some(WikiPage {
                path: str_of(p, "path")?.to_string(),
                id: p.get("id").and_then(Value::as_u64),
                children: page_tree(p),
            })
        })
        .collect()
}

/// Wiki 頁面 API 的路徑（`path` 是頁面路徑；程式碼 Wiki 要指定分支）。
fn wiki_pages_path(project_id: &str, wiki_id: &str, path: &str, version: Option<&str>) -> String {
    let mut out = format!(
        "/{}/_apis/wiki/wikis/{}/pages?path={}",
        encode_segment(project_id),
        encode_segment(wiki_id),
        encode_segment(path)
    );
    if let Some(v) = version.filter(|v| !v.is_empty()) {
        out.push_str(&format!("&versionDescriptor.version={}", encode_segment(v)));
    }
    out
}

/// Wiki 的頁面樹（最上層頁面的清單）。
#[tauri::command]
pub async fn ado_wiki_pages(
    app: AppHandle,
    project_id: String,
    wiki_id: String,
    version: Option<String>,
) -> Result<Vec<WikiPage>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let path = wiki_pages_path(&project_id, &wiki_id, "/", version.as_deref())
            + "&recursionLevel=full";
        Ok(page_tree(&get(
            &a.url,
            &pat,
            &path,
            &tr!("讀取 Wiki 頁面"),
        )?))
    })
    .await
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WikiContent {
    content: String,
    web_url: Option<String>,
    /// 頁面的版本（存回去時帶上，確認這段時間沒有被別人改過）。
    etag: Option<String>,
}

/// 讀取 Wiki 頁面的內容、網址與版本。
fn read_wiki_page(
    base: &str,
    pat: &str,
    project_id: &str,
    wiki_id: &str,
    path: &str,
    version: Option<&str>,
) -> Result<WikiContent, String> {
    let api = wiki_pages_path(project_id, wiki_id, path, version) + "&includeContent=true";
    let (v, etag) = read_with_etag(
        crate::update::agent()
            .get(&format!("{base}{api}&api-version={API_VERSION}"))
            .header("Authorization", &basic(pat))
            .header("Accept", "application/json")
            .call(),
        &tr!("讀取 Wiki 頁面"),
    )?;
    Ok(WikiContent {
        content: str_of(&v, "content").unwrap_or_default().to_string(),
        web_url: str_of(&v, "remoteUrl").map(str::to_string),
        etag,
    })
}

#[derive(Serialize, Debug)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WikiSaveOutcome {
    /// 已存回伺服器；`etag` 是新的版本。
    Saved { etag: Option<String> },
    /// 開始編輯之後頁面被別人改過：回傳伺服器上的內容與版本，交給使用者決定。
    Conflict {
        content: String,
        etag: Option<String>,
    },
}

/// 把編輯好的內容存回 Wiki 頁面（只限專案 Wiki）。`etag` 是開始編輯時的版本：
/// 伺服器上的版本不同（被別人改過）時不覆蓋，回傳衝突。
#[tauri::command]
pub async fn ado_wiki_save(
    app: AppHandle,
    project_id: String,
    wiki_id: String,
    path: String,
    content: String,
    etag: String,
) -> Result<WikiSaveOutcome, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let api = wiki_pages_path(&project_id, &wiki_id, &path, None);
        let res = crate::update::agent()
            .put(&format!("{}{api}&api-version={API_VERSION}", a.url))
            .header("Authorization", &basic(&pat))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .header("If-Match", &etag)
            .send(&serde_json::json!({ "content": content }).to_string());
        match res {
            Err(ureq::Error::StatusCode(409 | 412)) => {
                let page = read_wiki_page(&a.url, &pat, &project_id, &wiki_id, &path, None)?;
                Ok(WikiSaveOutcome::Conflict {
                    content: page.content,
                    etag: page.etag,
                })
            }
            res => {
                let (_, etag) = read_with_etag(res, &tr!("儲存 Wiki 頁面"))?;
                // 回應沒有帶版本時再讀一次，下次存檔才比得出有沒有被別人改過。
                let etag = match etag {
                    Some(etag) => Some(etag),
                    None => read_wiki_page(&a.url, &pat, &project_id, &wiki_id, &path, None)?.etag,
                };
                Ok(WikiSaveOutcome::Saved { etag })
            }
        }
    })
    .await
}

/// 建立新的 Wiki 頁面（只限專案 Wiki）：`path` 是完整路徑（例如 `/產品/新頁面`），上層頁面要已經存在。
/// 已經有同名的頁面時不覆蓋。回傳新頁面的版本（之後存回時用）。
#[tauri::command]
pub async fn ado_wiki_create(
    app: AppHandle,
    project_id: String,
    wiki_id: String,
    path: String,
    content: String,
) -> Result<Option<String>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let api = wiki_pages_path(&project_id, &wiki_id, &path, None);
        let res = crate::update::agent()
            .put(&format!("{}{api}&api-version={API_VERSION}", a.url))
            .header("Authorization", &basic(&pat))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .send(&serde_json::json!({ "content": content }).to_string());
        match res {
            // 沒帶 If-Match 時，已經有這一頁會被拒絕（不會覆蓋）。
            Err(ureq::Error::StatusCode(409 | 412)) => Err(tr!("已經有同名的頁面了，請換一個名稱")),
            res => {
                let (_, etag) = read_with_etag(res, &tr!("建立 Wiki 頁面"))?;
                Ok(match etag {
                    Some(etag) => Some(etag),
                    None => read_wiki_page(&a.url, &pat, &project_id, &wiki_id, &path, None)?.etag,
                })
            }
        }
    })
    .await
}

/// 刪除 Wiki 頁面（只限專案 Wiki）；底下的子頁面會一起刪除（和網頁版一樣）。
#[tauri::command]
pub async fn ado_wiki_delete(
    app: AppHandle,
    project_id: String,
    wiki_id: String,
    path: String,
) -> Result<(), String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let api = wiki_pages_path(&project_id, &wiki_id, &path, None);
        let res = crate::update::agent()
            .delete(&format!("{}{api}&api-version={API_VERSION}", a.url))
            .header("Authorization", &basic(&pat))
            .header("Accept", "application/json")
            .call();
        match res {
            // 回應的內容是被刪掉的頁面，不需要讀。
            Ok(_) => Ok(()),
            res => read(res, &tr!("刪除 Wiki 頁面")).map(|_| ()),
        }
    })
    .await
}

/// 一個 Wiki 頁面的內容（Markdown）。
#[tauri::command]
pub async fn ado_wiki_page(
    app: AppHandle,
    project_id: String,
    wiki_id: String,
    path: String,
    version: Option<String>,
) -> Result<WikiContent, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        read_wiki_page(
            &a.url,
            &pat,
            &project_id,
            &wiki_id,
            &path,
            version.as_deref(),
        )
    })
    .await
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WikiPageInfo {
    /// 伺服器上目前的版本（和開始編輯時的不同，就是被別人改過了）。
    etag: Option<String>,
    /// 最後修改的人與時間（Wiki 儲存庫裡這一頁的最新提交；查不到時是空的）。
    author: Option<String>,
    date: Option<String>,
}

/// 提交清單（`git/commits`）裡第一筆的作者與時間。
fn latest_author(v: &Value) -> (Option<String>, Option<String>) {
    let author = v
        .get("value")
        .and_then(Value::as_array)
        .and_then(|list| list.first())
        .and_then(|c| c.get("author"));
    let field = |key: &str| {
        author
            .and_then(|a| str_of(a, key))
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    (field("name"), field("date"))
}

/// Wiki 頁面目前的版本與最後修改的人（編輯中定期檢查有沒有人改過，開始編輯前提醒）。
/// 不讀內容，只看版本；最後修改的人另外查 Wiki 儲存庫的提交，查不到不算錯。
#[tauri::command]
pub async fn ado_wiki_page_info(
    app: AppHandle,
    project_id: String,
    wiki_id: String,
    repository_id: Option<String>,
    path: String,
) -> Result<WikiPageInfo, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let api = wiki_pages_path(&project_id, &wiki_id, &path, None);
        let (page, etag) = read_with_etag(
            crate::update::agent()
                .get(&format!("{}{api}&api-version={API_VERSION}", a.url))
                .header("Authorization", &basic(&pat))
                .header("Accept", "application/json")
                .call(),
            &tr!("讀取 Wiki 頁面"),
        )?;
        let (author, date) = match str_of(&page, "gitItemPath") {
            Some(item) => {
                let repo = repository_id.as_deref().filter(|r| !r.is_empty()).unwrap_or(&wiki_id);
                let url = format!(
                    "{}/{}/_apis/git/repositories/{}/commits?searchCriteria.itemPath={}&searchCriteria.$top=1&api-version={API_VERSION}",
                    a.url,
                    encode_segment(&project_id),
                    encode_segment(repo),
                    encode_segment(item)
                );
                read(
                    crate::update::agent()
                        .get(&url)
                        .header("Authorization", &basic(&pat))
                        .header("Accept", "application/json")
                        .call(),
                    &tr!("讀取 Wiki 頁面"),
                )
                .map(|v| latest_author(&v))
                .unwrap_or_default()
            }
            None => (None, None),
        };
        Ok(WikiPageInfo { etag, author, date })
    })
    .await
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WikiRevision {
    id: String,
    author: String,
    date: String,
    comment: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WikiHistory {
    /// 頁面在 Wiki 儲存庫裡的檔案路徑（讀某一版的內容時用）。
    git_path: String,
    /// 新的在前。
    revisions: Vec<WikiRevision>,
}

/// 提交清單（`git/commits`）轉成修改記錄。
fn revisions_of(v: &Value) -> Vec<WikiRevision> {
    v.get("value")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let author = c.get("author");
            Some(WikiRevision {
                id: str_of(c, "commitId")?.to_string(),
                author: author
                    .and_then(|a| str_of(a, "name"))
                    .unwrap_or_default()
                    .to_string(),
                date: author
                    .and_then(|a| str_of(a, "date"))
                    .unwrap_or_default()
                    .to_string(),
                comment: str_of(c, "comment").unwrap_or_default().trim().to_string(),
            })
        })
        .collect()
}

/// Wiki 頁面的修改記錄（最近 100 次）：誰、什麼時候、說明。
#[tauri::command]
pub async fn ado_wiki_history(
    app: AppHandle,
    project_id: String,
    wiki_id: String,
    repository_id: Option<String>,
    path: String,
) -> Result<WikiHistory, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let what = tr!("讀取 Wiki 頁面的修改記錄");
        let api = wiki_pages_path(&project_id, &wiki_id, &path, None);
        let page = read(
            crate::update::agent()
                .get(&format!("{}{api}&api-version={API_VERSION}", a.url))
                .header("Authorization", &basic(&pat))
                .header("Accept", "application/json")
                .call(),
            &what,
        )?;
        let git_path = str_of(&page, "gitItemPath")
            .ok_or_else(|| tr!("{what}失敗：伺服器沒有提供頁面的檔案位置", what = what))?
            .to_string();
        let repo = repository_id
            .as_deref()
            .filter(|r| !r.is_empty())
            .unwrap_or(&wiki_id);
        let url = format!(
            "{}/{}/_apis/git/repositories/{}/commits?searchCriteria.itemPath={}&searchCriteria.$top=100&api-version={API_VERSION}",
            a.url,
            encode_segment(&project_id),
            encode_segment(repo),
            encode_segment(&git_path)
        );
        let v = read(
            crate::update::agent()
                .get(&url)
                .header("Authorization", &basic(&pat))
                .header("Accept", "application/json")
                .call(),
            &what,
        )?;
        Ok(WikiHistory {
            git_path,
            revisions: revisions_of(&v),
        })
    })
    .await
}

// ---- Wiki 全文搜尋 -------------------------------------------------------------

/// 搜尋服務的網址：雲端版在另一個主機（almsearch），自架的伺服器就是集合本身。
fn search_base(base: &str) -> String {
    if let Some(rest) = base.strip_prefix("https://dev.azure.com/") {
        return format!("https://almsearch.dev.azure.com/{rest}");
    }
    if let Some((scheme, rest)) = base.split_once("://") {
        let (host, path) = rest.split_once('/').map_or((rest, ""), |(h, p)| (h, p));
        if let Some(org) = host.strip_suffix(".visualstudio.com") {
            let path = if path.is_empty() {
                String::new()
            } else {
                format!("/{path}")
            };
            return format!("{scheme}://{org}.almsearch.visualstudio.com{path}");
        }
    }
    base.to_string()
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WikiHit {
    /// 頁面在 Wiki 儲存庫裡的檔案路徑（例如 `/產品/安裝-說明.md`）。
    path: String,
    /// 符合的片段（`<highlighthit>` 標出符合的字）。
    snippet: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WikiSearch {
    /// 伺服器有沒有搜尋功能（沒裝 Search 擴充功能時是 false）。
    available: bool,
    results: Vec<WikiHit>,
}

fn wiki_hits(v: &Value) -> Vec<WikiHit> {
    v.get("results")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|r| {
            let path = str_of(r, "path")?.to_string();
            let snippet = r
                .get("hits")
                .and_then(Value::as_array)
                .and_then(|hits| {
                    hits.iter()
                        .find(|h| str_of(h, "fieldReferenceName") == Some("content"))
                        .or_else(|| hits.first())
                })
                .and_then(|h| h.get("highlights"))
                .and_then(Value::as_array)
                .and_then(|l| l.first())
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            Some(WikiHit { path, snippet })
        })
        .collect()
}

/// 在一個 Wiki 的內容裡搜尋（需要伺服器有 Search 擴充功能；沒有時 `available` 是 false）。
#[tauri::command]
pub async fn ado_wiki_search(
    app: AppHandle,
    project: String,
    wiki: String,
    text: String,
) -> Result<WikiSearch, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let url = format!(
            "{}/{}/_apis/search/wikisearchresults?api-version=5.0-preview.1",
            search_base(&a.url),
            encode_segment(&project)
        );
        let body = serde_json::json!({
            "searchText": text,
            "$skip": 0,
            "$top": 50,
            "filters": { "Project": [project], "Wiki": [wiki] },
            "includeFacets": false,
        });
        let mut res = crate::update::agent()
            .post(&url)
            .config()
            .http_status_as_error(false)
            .build()
            .header("Authorization", &basic(&pat))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .send(&body.to_string())
            .map_err(|e| {
                tr!(
                    "{what}失敗：連不到 Azure DevOps 伺服器，請確認網路或 VPN 連線（{e}）",
                    what = tr!("搜尋 Wiki"),
                    e = e
                )
            })?;
        let code = res.status().as_u16();
        let text = res.body_mut().read_to_string().unwrap_or_default();
        match code {
            // 沒有搜尋服務（沒裝擴充功能、舊版伺服器）。
            400 | 404 | 501 => Ok(WikiSearch {
                available: false,
                results: vec![],
            }),
            401 | 403 => Err(tr!("{what}失敗：沒有權限", what = tr!("搜尋 Wiki"))),
            c if c >= 400 => Err(tr!(
                "{what}失敗：伺服器回應 {code}",
                what = tr!("搜尋 Wiki"),
                code = c
            )),
            _ => {
                let v: Value = serde_json::from_str(&text).map_err(|_| {
                    tr!(
                        "{what}失敗：伺服器的回應不是預期的格式，請確認網址與個人存取權杖",
                        what = tr!("搜尋 Wiki")
                    )
                })?;
                Ok(WikiSearch {
                    available: true,
                    results: wiki_hits(&v),
                })
            }
        }
    })
    .await
}

/// 依副檔名判斷圖片類型（不支援 SVG：可能含有指令碼）。
fn image_mime(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

/// Wiki 裡的圖片（放在 Wiki 的 Git 儲存庫裡）：回傳 data: 網址。
#[tauri::command]
pub async fn ado_wiki_image(
    app: AppHandle,
    project_id: String,
    repository_id: String,
    path: String,
    version: Option<String>,
) -> Result<String, String> {
    let (a, pat) = require(&app)?;
    let mime = image_mime(&path).ok_or_else(|| tr!("無法讀取圖片：不是圖片"))?;
    crate::io::blocking_for(TIMEOUT, move || {
        let mut url = format!(
            "{}/{}/_apis/git/repositories/{}/items?path={}&download=true&api-version={API_VERSION}",
            a.url,
            encode_segment(&project_id),
            encode_segment(&repository_id),
            encode_segment(&path)
        );
        if let Some(v) = version.filter(|v| !v.is_empty()) {
            url.push_str(&format!(
                "&versionDescriptor.version={}",
                encode_segment(&v)
            ));
        }
        let bytes = fetch_bytes(&url, &pat)?;
        Ok(data_url(mime, bytes))
    })
    .await
}

/// 上傳到 Wiki 附件的檔名：只留英數字、`-`、`_`、`.`，其餘換成 `-`，加上時間避免和既有的附件同名。
fn attachment_name(stem: &str, ext: &str, stamp: u128) -> String {
    let clean: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let clean = clean.trim_matches('-');
    let stem = if clean.is_empty() { "image" } else { clean };
    let stem: String = stem.chars().take(40).collect();
    format!("{stem}-{stamp}.{ext}")
}

/// 把圖片上傳成 Wiki 的附件（`.attachments` 資料夾），回傳在頁面裡引用的路徑（例如 `/.attachments/image-123.png`）。
/// `data` 是 base64；Wiki 的附件 API 本身就是收 base64 文字。
#[tauri::command]
pub async fn ado_wiki_attach(
    app: AppHandle,
    project_id: String,
    wiki_id: String,
    name: String,
    ext: String,
    data: String,
) -> Result<String, String> {
    let (a, pat) = require(&app)?;
    if image_mime(&format!("x.{ext}")).is_none() {
        return Err(tr!("無法上傳圖片：不是圖片"));
    }
    crate::io::blocking_for(TIMEOUT, move || {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        let file = attachment_name(&name, &ext, stamp);
        let what = tr!("上傳圖片到 Wiki");
        let put = |version: &str| {
            crate::update::agent()
                .put(&format!(
                    "{}/{}/_apis/wiki/wikis/{}/attachments?name={}&api-version={version}",
                    a.url,
                    encode_segment(&project_id),
                    encode_segment(&wiki_id),
                    encode_segment(&file)
                ))
                .header("Authorization", &basic(&pat))
                .header("Accept", "application/json")
                .header("Content-Type", "application/octet-stream")
                .send(data.as_str())
        };
        // 舊版伺服器（Azure DevOps Server 2019）的附件 API 還是預覽版。
        let res = match put(API_VERSION) {
            Err(ureq::Error::StatusCode(400)) => put("5.0-preview.1"),
            res => res,
        };
        let v = read(res, &what)?;
        Ok(str_of(&v, "path")
            .map(str::to_string)
            .unwrap_or_else(|| format!("/.attachments/{file}")))
    })
    .await
}

/// 用權杖讀取伺服器上的檔案（不跟隨轉址，權杖不會被送到別的地方），最多 10 MB。
fn fetch_bytes(url: &str, pat: &str) -> Result<Vec<u8>, String> {
    let mut res = crate::update::agent()
        .get(url)
        .config()
        .max_redirects(0)
        .build()
        .header("Authorization", &basic(pat))
        .call()
        .map_err(|e| tr!("無法讀取圖片：{e}", e = e))?;
    let mime = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    // 權杖不對時，雲端版會回傳登入網頁。
    if mime.starts_with("text/html") {
        return Err(tr!("無法讀取圖片：不是圖片"));
    }
    res.body_mut()
        .with_config()
        .limit(10 * 1024 * 1024)
        .read_to_vec()
        .map_err(|e| tr!("無法讀取圖片：{e}", e = e))
}

// ---- 儲存庫裡的文字檔、工作項目的附件 ---------------------------------------------

/// 文字檔最多讀幾個位元組。
const TEXT_LIMIT: u64 = 5 * 1024 * 1024;

/// 用權杖讀取伺服器上的文字檔（不跟隨轉址），回傳內容；不是文字（含 NUL）時回錯誤。
fn fetch_text(url: &str, pat: &str) -> Result<String, String> {
    let what = tr!("讀取檔案");
    let mut res = crate::update::agent()
        .get(url)
        .config()
        .max_redirects(0)
        .build()
        .header("Authorization", &basic(pat))
        .call()
        .map_err(|e| match e {
            ureq::Error::StatusCode(404) => {
                tr!("{what}失敗：找不到（404），請確認網址", what = what)
            }
            ureq::Error::StatusCode(401 | 403) => tr!("{what}失敗：沒有權限", what = what),
            e => tr!("{what}失敗：{e}", what = what, e = e),
        })?;
    let mime = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    // 權杖不對時，雲端版會回傳登入網頁。
    if mime.starts_with("text/html") {
        return Err(tr!(
            "{what}失敗：伺服器的回應不是預期的格式，請確認網址與個人存取權杖",
            what = what
        ));
    }
    let bytes = res
        .body_mut()
        .with_config()
        .limit(TEXT_LIMIT)
        .read_to_vec()
        .map_err(|e| tr!("{what}失敗：{e}", what = what, e = e))?;
    text_of(bytes)
}

/// 檔案內容轉成文字：有 NUL 就不是文字檔；不是 UTF-8 的字元換成替代字元。
fn text_of(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.contains(&0) {
        return Err(tr!("這個檔案不是文字檔，請用瀏覽器開啟"));
    }
    let text = String::from_utf8(bytes)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    Ok(text
        .strip_prefix('\u{feff}')
        .map(str::to_string)
        .unwrap_or(text))
}

/// Git 儲存庫裡的文字檔（例如文件連到 `/_git/repo?path=/docs/a.md`）。
/// `version_type` 是 branch、tag 或 commit。
#[tauri::command]
pub async fn ado_repo_text(
    app: AppHandle,
    project: String,
    repo: String,
    path: String,
    version: Option<String>,
    version_type: Option<String>,
) -> Result<String, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let mut url = format!(
            "{}/{}/_apis/git/repositories/{}/items?path={}&download=true&api-version={API_VERSION}",
            a.url,
            encode_segment(&project),
            encode_segment(&repo),
            encode_segment(&path)
        );
        if let Some(v) = version.filter(|v| !v.is_empty()) {
            url.push_str(&format!(
                "&versionDescriptor.version={}",
                encode_segment(&v)
            ));
            if let Some(kind) =
                version_type.filter(|k| ["branch", "tag", "commit"].contains(&k.as_str()))
            {
                url.push_str(&format!("&versionDescriptor.versionType={kind}"));
            }
        }
        fetch_text(&url, &pat)
    })
    .await
}

/// 工作項目的附件（文字檔）；只讀取連線中那台伺服器上的附件網址。
#[tauri::command]
pub async fn ado_attachment_text(app: AppHandle, url: String) -> Result<String, String> {
    let (a, pat) = require(&app)?;
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://"))
        || !same_server(&url, &a.url)
        || !lower.contains("/_apis/wit/attachments/")
    {
        return Err(tr!("只能讀取 Azure DevOps 伺服器上的附件"));
    }
    crate::io::blocking_for(TIMEOUT, move || fetch_text(&url, &pat)).await
}

fn data_url(mime: &str, bytes: Vec<u8>) -> String {
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

fn detail_of(base: &str, v: &Value) -> Option<WorkItemDetail> {
    let html = |name: &str| {
        field(v, name)
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
    };
    let text = |name: &str| Some(field_str(v, name)).filter(|s| !s.trim().is_empty());
    Some(WorkItemDetail {
        item: item_of(base, v)?,
        created_by: person(field(v, "System.CreatedBy")),
        area: text("System.AreaPath"),
        iteration: text("System.IterationPath"),
        tags: field_str(v, "System.Tags")
            .split(';')
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .collect(),
        comments: vec![],
        rev: v.get("rev").and_then(Value::as_u64),
        relations: vec![],
        description: html("System.Description"),
        details: html("Microsoft.VSTS.Common.AcceptanceCriteria")
            .or_else(|| html("Microsoft.VSTS.TCM.ReproSteps")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 模擬一台 TFS：只有 /tfs/DefaultCollection 一個集合，connectionData 只接受預覽版號。
    fn fake_tfs() -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let target = req.split(' ').nth(1).unwrap_or("");
                let (status, body) = match target {
                    t if t.contains("/_apis/connectionData?api-version=5.0-preview") => (
                        "200 OK",
                        r#"{"authenticatedUser":{"providerDisplayName":"王小明"}}"#,
                    ),
                    t if t.contains("/_apis/connectionData") => ("400 Bad Request", "{}"),
                    "/tfs/_apis/projectCollections?api-version=5.0" => {
                        ("200 OK", r#"{"value":[{"name":"DefaultCollection"}]}"#)
                    }
                    "/tfs/DefaultCollection/_apis/projects?$top=1&api-version=5.0" => {
                        ("200 OK", r#"{"value":[]}"#)
                    }
                    _ => ("404 Not Found", "{}"),
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        base
    }

    #[test]
    fn connects_to_the_only_collection_when_given_the_server_url() {
        let host = fake_tfs();
        let a = connect_at(&format!("{host}/tfs"), "pat").unwrap();
        assert_eq!(a.url, format!("{host}/tfs/DefaultCollection"));
        assert_eq!(a.name, "王小明");
        // 只輸入主機名稱：自動試 /tfs。
        let tries = candidates(&host).unwrap();
        let ok = tries
            .iter()
            .find_map(|b| connect_at(b, "pat").ok())
            .unwrap();
        assert_eq!(ok.url, format!("{host}/tfs/DefaultCollection"));
    }

    #[test]
    fn explains_not_found_after_trying_every_url() {
        let tries = vec!["https://tfs/a".to_string(), "https://tfs".to_string()];
        let e = connect_error(
            &tries,
            vec!["連線失敗：找不到（404），請確認網址".into(); 2],
        );
        assert!(e.contains("https://tfs/a、https://tfs"));
        assert!(e.contains("DefaultCollection"));
        // 有其他錯誤（例如權杖不對）時優先顯示，不要被 404 蓋掉。
        let e = connect_error(
            &tries,
            vec![
                "連線失敗：個人存取權杖無效或已過期".into(),
                "連線失敗：找不到（404），請確認網址".into(),
            ],
        );
        assert_eq!(e, "連線失敗：個人存取權杖無效或已過期");
    }

    #[test]
    fn finds_collection_url_from_pasted_links() {
        assert_eq!(
            candidates("https://tfs.corp.com/tfs/DefaultCollection/").unwrap(),
            [
                "https://tfs.corp.com/tfs/DefaultCollection",
                "https://tfs.corp.com/tfs"
            ]
        );
        assert_eq!(
            candidates("https://dev.azure.com/org/專案/_git/repo?path=/a").unwrap(),
            [
                "https://dev.azure.com/org/專案",
                "https://dev.azure.com/org"
            ]
        );
        assert_eq!(
            candidates("http://tfs:8080").unwrap(),
            ["http://tfs:8080", "http://tfs:8080/tfs"]
        );
        // 網際網路上的伺服器不能用 HTTP（權杖會以明文傳出去）。
        assert!(candidates("http://tfs.example.com/tfs").is_err());
        assert!(candidates("tfs.corp.com").is_err());
    }

    #[test]
    fn base_match_does_not_cross_sibling_paths() {
        let base = "https://tfs.corp.com/tfs/DefaultCollection";
        assert!(starts_with_base(
            "https://TFS.corp.com/tfs/defaultcollection/P/_git/r",
            base
        ));
        assert!(!starts_with_base(
            "https://tfs.corp.com/tfs/DefaultCollection2/P/_git/r",
            base
        ));
        assert!(!starts_with_base(
            "https://evil.com/tfs/DefaultCollection",
            base
        ));
    }

    #[test]
    fn finds_project_and_repo_in_remote() {
        let base = "https://tfs.corp.com/tfs/DC";
        assert_eq!(
            project_and_repo(
                "https://ming@tfs.corp.com/tfs/DC/%E7%94%A2%E5%93%81/_git/web",
                base
            ),
            Some(("%E7%94%A2%E5%93%81".into(), "web".into()))
        );
        assert_eq!(
            project_and_repo("https://other.com/tfs/DC/P/_git/r", base),
            None
        );
        assert_eq!(
            project_and_repo("https://tfs.corp.com/tfs/DC/P", base),
            None
        );
    }

    #[test]
    fn same_server_compares_scheme_host_and_port() {
        let base = "https://tfs.corp.com/tfs/DC";
        assert!(same_server("https://TFS.corp.com/tfs/Other/_git/r", base));
        assert!(!same_server("http://tfs.corp.com/tfs/DC/_git/r", base));
        assert!(!same_server("https://tfs.corp.com:8443/tfs/DC", base));
        assert!(!same_server("https://tfs.corp.com.evil.com/tfs/DC", base));
    }

    #[test]
    fn flattens_saved_queries() {
        let v = serde_json::json!({ "value": [
            { "id": "f1", "name": "My Queries", "path": "My Queries", "isFolder": true, "children": [
                { "id": "q1", "name": "我的 Bug", "path": "My Queries/我的 Bug" }
            ] },
            { "id": "f2", "name": "Shared Queries", "path": "Shared Queries", "isFolder": true, "children": [
                { "id": "f3", "name": "團隊", "path": "Shared Queries/團隊", "isFolder": true, "children": [
                    { "id": "q2", "name": "本週", "path": "Shared Queries/團隊/本週" }
                ] }
            ] }
        ] });
        let mut out = vec![];
        flatten_queries("P", values(&v), &mut out);
        assert_eq!(
            out,
            vec![
                SavedQuery {
                    id: "q1".into(),
                    project: "P".into(),
                    name: "我的 Bug".into(),
                    folder: "My Queries".into()
                },
                SavedQuery {
                    id: "q2".into(),
                    project: "P".into(),
                    name: "本週".into(),
                    folder: "Shared Queries/團隊".into()
                },
            ]
        );
    }

    #[test]
    fn reads_wiki_revisions() {
        let v = serde_json::json!({ "value": [
            { "commitId": "b2", "comment": " 更新 安裝.md \n", "author": { "name": "王小明", "date": "2026-10-28T02:42:00Z" } },
            { "commitId": "a1", "author": { "name": "陳大文" } },
            { "comment": "沒有 id 的略過" }
        ] });
        assert_eq!(
            revisions_of(&v),
            vec![
                WikiRevision {
                    id: "b2".into(),
                    author: "王小明".into(),
                    date: "2026-10-28T02:42:00Z".into(),
                    comment: "更新 安裝.md".into()
                },
                WikiRevision {
                    id: "a1".into(),
                    author: "陳大文".into(),
                    date: String::new(),
                    comment: String::new()
                },
            ]
        );
    }

    #[test]
    fn reads_work_item_parents() {
        let new = serde_json::json!({ "id": 5, "fields": { "System.Parent": 2 } });
        assert_eq!(parent_field(&new), Some((5, 2)));
        assert_eq!(
            parent_field(&serde_json::json!({ "id": 5, "fields": {} })),
            None
        );
        let old = serde_json::json!({ "id": 7, "relations": [
            { "rel": "System.LinkTypes.Related", "url": "https://tfs/DC/_apis/wit/workItems/3" },
            { "rel": "System.LinkTypes.Hierarchy-Reverse", "url": "https://tfs/DC/_apis/wit/workItems/4" }
        ] });
        assert_eq!(parent_relation(&old), Some((7, 4)));
        assert_eq!(parent_relation(&serde_json::json!({ "id": 7 })), None);
    }

    #[test]
    fn reads_query_result_ids() {
        let flat = serde_json::json!({ "workItems": [{ "id": 3 }, { "id": 1 }, { "id": 3 }] });
        assert_eq!(query_ids(&flat), vec![3, 1]);
        let tree = serde_json::json!({ "workItemRelations": [
            { "target": { "id": 10 } },
            { "source": { "id": 10 }, "target": { "id": 11 } }
        ] });
        assert_eq!(query_ids(&tree), vec![10, 11]);
        assert!(query_ids(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn names_wiki_attachments_safely() {
        assert_eq!(attachment_name("截圖 1", "png", 42), "1-42.png");
        assert_eq!(attachment_name("", "jpg", 7), "image-7.jpg");
        assert_eq!(attachment_name("../a b", "png", 1), "a-b-1.png");
        assert_eq!(
            attachment_name("screen_shot-2", "gif", 3),
            "screen_shot-2-3.gif"
        );
    }

    #[test]
    fn reads_latest_wiki_author() {
        let v = serde_json::json!({ "count": 1, "value": [
            { "commitId": "abc", "author": { "name": "王小明", "email": "a@b", "date": "2026-10-28T02:42:00Z" } }
        ] });
        assert_eq!(
            latest_author(&v),
            (Some("王小明".into()), Some("2026-10-28T02:42:00Z".into()))
        );
        assert_eq!(
            latest_author(&serde_json::json!({ "value": [] })),
            (None, None)
        );
        assert_eq!(latest_author(&serde_json::json!({})), (None, None));
    }

    #[test]
    fn builds_create_ops() {
        let item = NewWorkItem {
            project: "P".into(),
            kind: "Bug".into(),
            title: " 登入失敗 ".into(),
            description: Some("<p>步驟</p>".into()),
            assign_to_me: true,
            parent: Some(42),
        };
        let ops = create_ops(&item, "me@corp", "https://tfs/DC/");
        assert_eq!(ops[0]["value"], "登入失敗");
        assert_eq!(ops[1]["path"], "/fields/Microsoft.VSTS.TCM.ReproSteps");
        assert_eq!(ops[2]["value"], "me@corp");
        assert_eq!(
            ops[3]["value"]["url"],
            "https://tfs/DC/_apis/wit/workItems/42"
        );
        let task = NewWorkItem {
            kind: "Task".into(),
            title: "x".into(),
            description: Some("<p>a</p>".into()),
            ..Default::default()
        };
        let ops = create_ops(&task, "me", "https://tfs/DC");
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[1]["path"], "/fields/System.Description");
    }

    #[test]
    fn encodes_project_names_in_urls() {
        assert_eq!(encode_segment("My Project"), "My%20Project");
        assert_eq!(encode_segment("專案.wiki"), "%E5%B0%88%E6%A1%88.wiki");
    }

    #[test]
    fn identity_uses_account_or_domain_login() {
        let mut a = Account {
            url: "https://tfs.corp.com/tfs/DefaultCollection".into(),
            name: "王小明".into(),
            account: Some("CORP\\ming".into()),
        };
        assert_eq!(identity_of(&a).unwrap().email, "ming@corp");
        a.account = Some("ming@corp.com".into());
        assert_eq!(identity_of(&a).unwrap().email, "ming@corp.com");
        a.account = None;
        assert_eq!(identity_of(&a).unwrap().email, "王小明@tfs.corp.com");
    }

    #[test]
    fn reads_user_from_connection_data() {
        let data = json!({"authenticatedUser": {"providerDisplayName": "王小明",
            "properties": {"Account": {"$type": "System.String", "$value": "CORP\\ming"}}}});
        assert_eq!(
            user_of(&data),
            Some(("王小明".into(), Some("CORP\\ming".into())))
        );
        let anon = json!({"authenticatedUser": {"providerDisplayName": "Anonymous"}});
        assert_eq!(user_of(&anon), None);
    }

    #[test]
    fn lists_repos_and_project_wikis() {
        let base = "https://tfs.corp.com/tfs/DC";
        let repos = json!({"value": [
            {"name": "web", "remoteUrl": "https://tfs.corp.com/tfs/DC/產品/_git/web", "project": {"name": "產品"}},
            {"name": "old", "remoteUrl": "x", "isDisabled": true, "project": {"name": "產品"}}
        ]});
        let wikis = json!({"value": [
            {"name": "產品.wiki", "type": "projectWiki", "projectId": "p1", "remoteUrl": "https://tfs.corp.com/tfs/DC/產品/_wiki/wikis/產品.wiki"},
            {"name": "docs", "type": "codeWiki", "projectId": "p1"}
        ]});
        let projects = json!({"value": [{"id": "p1", "name": "產品"}]});
        let list = repos_from(base, &repos, &wikis, &projects);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "web");
        assert!(list[1].wiki);
        assert_eq!(
            list[1].clone_url,
            "https://tfs.corp.com/tfs/DC/%E7%94%A2%E5%93%81/_git/%E7%94%A2%E5%93%81.wiki"
        );
    }

    #[test]
    fn lists_wikis_and_page_trees() {
        let wikis = json!({"value": [
            {"id": "w2", "name": "docs", "type": "codeWiki", "projectId": "p1", "repositoryId": "r2",
             "mappedPath": "/docs", "versions": [{"version": "main"}]},
            {"id": "w1", "name": "產品.wiki", "type": "projectWiki", "projectId": "p1", "repositoryId": "r1",
             "mappedPath": "/", "versions": [{"version": "wikiMaster"}], "remoteUrl": "https://tfs/DC/x"},
            {"id": "w3", "name": "壞的", "projectId": "p1"}
        ]});
        let projects = json!({"value": [{"id": "p1", "name": "產品"}]});
        let list = wikis_from(&wikis, &projects);
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].id.as_str(), list[0].code), ("w1", false));
        assert_eq!(list[0].project, "產品");
        assert_eq!(list[1].mapped_path, "/docs");
        assert_eq!(list[1].version.as_deref(), Some("main"));
        let tree = json!({"path": "/", "subPages": [
            {"path": "/首頁", "subPages": []},
            {"path": "/產品", "subPages": [{"path": "/產品/安裝", "id": 12}]}
        ]});
        let pages = page_tree(&tree);
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[1].children[0].path, "/產品/安裝");
        assert_eq!(pages[1].children[0].id, Some(12));
        assert_eq!(pages[0].id, None);
        assert_eq!(
            wiki_pages_path("p1", "w1", "/A B", Some("main")),
            "/p1/_apis/wiki/wikis/w1/pages?path=%2FA%20B&versionDescriptor.version=main"
        );
        assert_eq!(image_mime("/.attachments/a.PNG"), Some("image/png"));
        assert_eq!(image_mime("/.attachments/a.svg"), None);
    }

    #[test]
    fn builds_wiql_for_each_search() {
        let mine = WorkItemFilter::default();
        assert!(wiql_for("", &mine, &[])
            .unwrap()
            .contains("[System.AssignedTo] = @Me"));
        assert!(wiql_for("", &mine, &[]).unwrap().contains("'已關閉'"));
        assert_eq!(wiql_for("#123", &mine, &[]), None);
        let all = WorkItemFilter {
            person: "".into(),
            state: "all".into(),
            kind: Some("Bug".into()),
            project: Some("產品".into()),
            ..Default::default()
        };
        let q = wiql_for("登入 bug", &all, CONTENT_FIELDS[0]).unwrap();
        assert!(!q.contains("@Me") && !q.contains("[System.State]"));
        assert!(q.contains("[System.WorkItemType] = 'Bug'"));
        assert!(q.contains("[System.TeamProject] = '產品'"));
        assert!(q.contains(
            "([System.Title] CONTAINS '登入 bug' OR [System.Description] CONTAINS WORDS '登入 bug'"
        ));
        assert!(q.contains("[Microsoft.VSTS.Common.AcceptanceCriteria] CONTAINS WORDS"));
        let closed = WorkItemFilter {
            person: " ".into(),
            state: "closed".into(),
            ..Default::default()
        };
        assert!(wiql_for("", &closed, &[])
            .unwrap()
            .contains("[System.State] IN ("));
        let none = WorkItemFilter {
            state: "all".into(),
            ..closed
        };
        assert!(wiql_for("", &none, &[])
            .unwrap()
            .contains("WHERE [System.Id] > 0"));
        assert!(wiql_for("it's", &mine, &[]).unwrap().contains("'it''s'"));
        // 依人與區域。
        let by = WorkItemFilter {
            role: "created".into(),
            person: "王小明".into(),
            area: Some(" 產品\\前端 ".into()),
            ..Default::default()
        };
        let q = wiql_for("", &by, &[]).unwrap();
        assert!(q.contains("[System.CreatedBy] CONTAINS '王小明'"));
        assert!(!q.contains("AssignedTo"));
        assert!(q.contains("[System.AreaPath] UNDER '產品\\前端'"));
        let me = WorkItemFilter {
            role: "created".into(),
            ..Default::default()
        };
        assert!(wiql_for("", &me, &[])
            .unwrap()
            .contains("[System.CreatedBy] = @Me"));
    }

    #[test]
    fn flattens_areas_and_members() {
        let tree = json!({"name": "產品", "children": [
            {"name": "前端", "children": [{"name": "登入"}]},
            {"name": "後端"}
        ]});
        assert_eq!(
            area_paths(&tree),
            ["產品\\前端", "產品\\前端\\登入", "產品\\後端"]
        );
        let members = json!({"value": [
            {"identity": {"displayName": "王小明"}},
            {"displayName": "Amy Lin"},
            {"identity": {"displayName": "[產品]\\Contributors", "isContainer": true}},
            {"identity": {"displayName": " "}}
        ]});
        assert_eq!(member_names(&members), ["王小明", "Amy Lin"]);
    }

    #[test]
    fn searches_wikis() {
        assert_eq!(
            search_base("https://dev.azure.com/acme"),
            "https://almsearch.dev.azure.com/acme"
        );
        assert_eq!(
            search_base("https://acme.visualstudio.com/DefaultCollection"),
            "https://acme.almsearch.visualstudio.com/DefaultCollection"
        );
        assert_eq!(search_base("https://tfs/DC"), "https://tfs/DC");
        let v = json!({"results": [
            {"path": "/產品/安裝-說明.md", "hits": [{"fieldReferenceName": "fileName", "highlights": ["x"]},
                {"fieldReferenceName": "content", "highlights": ["先<highlighthit>安裝</highlighthit>工具"]}]},
            {"path": "/首頁.md"}
        ]});
        let hits = wiki_hits(&v);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].snippet, "先<highlighthit>安裝</highlighthit>工具");
        assert_eq!(hits[1].snippet, "");
    }

    #[test]
    fn reads_text_files() {
        assert_eq!(
            text_of("\u{feff}# 標題".as_bytes().to_vec()).unwrap(),
            "# 標題"
        );
        assert!(text_of(vec![0x89, b'P', b'N', b'G', 0, 0]).is_err());
        assert_eq!(text_of(vec![b'a', 0xff, b'b']).unwrap(), "a\u{fffd}b");
    }

    #[test]
    fn builds_work_item_change() {
        let change = WorkItemChange {
            state: Some("Resolved".into()),
            assign_to_me: true,
            comment: Some("<p>好了</p>".into()),
            rev: Some(7),
        };
        let ops = change_ops(&change, "CORP\\ming");
        assert_eq!(ops.len(), 4);
        assert_eq!(ops[0], json!({"op": "test", "path": "/rev", "value": 7}));
        assert_eq!(ops[1]["path"], "/fields/System.State");
        assert_eq!(ops[2]["value"], "CORP\\ming");
        assert_eq!(ops[3]["path"], "/fields/System.History");
        let empty = WorkItemChange {
            comment: Some("  ".into()),
            ..Default::default()
        };
        assert!(change_ops(&empty, "x").is_empty());
    }

    #[test]
    fn reads_states_from_transitions() {
        let v = json!({"transitions": {"": [{"to": "New"}], "New": [{"to": "Active"}], "Active": [{"to": "Resolved"}, {"to": "New"}]}});
        let states = states_from_transitions(&v);
        assert_eq!(states.len(), 3);
        assert!(states.contains(&"Resolved".to_string()));
        assert!(!states.contains(&String::new()));
    }

    #[test]
    fn reads_work_item_relations() {
        let v = json!({"relations": [
            {"rel": "System.LinkTypes.Hierarchy-Reverse", "url": "https://tfs/DC/_apis/wit/workItems/10", "attributes": {"name": "Parent"}},
            {"rel": "System.LinkTypes.Hierarchy-Forward", "url": "https://tfs/DC/_apis/wit/workItems/11", "attributes": {"name": "Child"}},
            {"rel": "System.LinkTypes.Hierarchy-Forward", "url": "https://tfs/DC/_apis/wit/workItems/11", "attributes": {"name": "Child"}},
            {"rel": "Microsoft.VSTS.Common.TestedBy-Forward", "url": "https://tfs/DC/_apis/wit/workitems/12", "attributes": {"name": "Tested By"}},
            {"rel": "AttachedFile", "url": "https://tfs/DC/_apis/wit/attachments/abc", "attributes": {"name": "a.png"}},
            {"rel": "ArtifactLink", "url": "vstfs:///Git/Commit/x", "attributes": {"name": "Fixed in Commit"}},
            {"rel": "System.LinkTypes.Related", "url": "https://tfs/DC/_apis/wit/workItems/13"}
        ]});
        assert_eq!(
            relation_links(&v),
            vec![
                ("parent", "Parent".to_string(), 10),
                ("child", "Child".to_string(), 11),
                ("other", "Tested By".to_string(), 12),
                ("related", "System.LinkTypes.Related".to_string(), 13),
            ]
        );
        assert!(relation_links(&json!({})).is_empty());
    }

    #[test]
    fn classifies_ping() {
        let ok = r#"{"authenticatedUser":{"providerDisplayName":"王小明"}}"#;
        assert_eq!(ping_of(200, ok).status, "ok");
        assert_eq!(ping_of(200, ok).name.as_deref(), Some("王小明"));
        assert_eq!(ping_of(200, "<html>login</html>").status, "auth");
        assert_eq!(
            ping_of(
                200,
                r#"{"authenticatedUser":{"providerDisplayName":"Anonymous"}}"#
            )
            .status,
            "auth"
        );
        assert_eq!(ping_of(401, "").status, "auth");
        assert_eq!(ping_of(500, "").status, "error");
    }

    #[test]
    fn reads_comments_oldest_first() {
        let v = json!({"comments": [
            {"text": "<p>第二則</p>", "createdBy": {"displayName": "B"}, "createdDate": "2026-10-02T00:00:00Z"},
            {"text": "  ", "createdBy": {"displayName": "空"}, "createdDate": "2026-10-03T00:00:00Z"},
            {"text": "<p>第一則</p>", "createdBy": {"displayName": "A"}, "createdDate": "2026-10-01T00:00:00Z"}
        ]});
        let c = comments_of(&v);
        assert_eq!(c.len(), 2);
        assert_eq!((c[0].author.as_str(), c[1].author.as_str()), ("A", "B"));
    }

    #[test]
    fn reads_work_item_fields() {
        let v = json!({"id": 42, "fields": {
            "System.Title": "修正登入", "System.State": "Active", "System.WorkItemType": "Bug",
            "System.TeamProject": "產品", "System.AssignedTo": {"displayName": "王小明"},
            "Microsoft.VSTS.TCM.ReproSteps": "<div>步驟</div>",
            "System.Tags": "前端; 登入 ;", "Microsoft.VSTS.Common.Priority": 2,
            "System.AreaPath": "產品\\前端"
        }});
        let d = detail_of("https://tfs/DC", &v).unwrap();
        assert_eq!(d.tags, ["前端", "登入"]);
        assert_eq!(d.item.priority, Some(2));
        assert_eq!(d.area.as_deref(), Some("產品\\前端"));
        assert_eq!(d.iteration, None);
        assert_eq!(d.item.title, "修正登入");
        assert_eq!(d.item.assigned_to.as_deref(), Some("王小明"));
        assert_eq!(d.details.as_deref(), Some("<div>步驟</div>"));
        assert_eq!(
            d.item.web_url,
            "https://tfs/DC/%E7%94%A2%E5%93%81/_workitems/edit/42"
        );
        assert_eq!(
            person(Some(&json!("王小明 <CORP\\ming>"))).as_deref(),
            Some("王小明")
        );
    }
}
