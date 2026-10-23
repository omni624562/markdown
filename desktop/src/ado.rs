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
use crate::workspace::FolderInfo;

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

fn account(app: &AppHandle) -> Option<Account> {
    let text = fs::read_to_string(account_file(app)?).ok()?;
    serde_json::from_str(&text).ok()
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
        return Err("請輸入 https:// 或 http:// 開頭的網址".into());
    }
    if let Some(q) = url.find(['?', '#']) {
        url.truncate(q);
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
    match res {
        Ok(mut r) => {
            let text = r
                .body_mut()
                .read_to_string()
                .map_err(|e| format!("{what}失敗：{e}"))?;
            // 權杖不對時，雲端版會回傳登入網頁（HTML）而不是錯誤碼。
            serde_json::from_str(&text).map_err(|_| {
                format!("{what}失敗：伺服器的回應不是預期的格式，請確認網址與個人存取權杖")
            })
        }
        Err(ureq::Error::StatusCode(401)) => Err(format!(
            "{what}失敗：個人存取權杖無效或已過期，請到設定的 Git 頁重新連線"
        )),
        Err(ureq::Error::StatusCode(403)) => Err(format!("{what}失敗：沒有權限")),
        Err(ureq::Error::StatusCode(404)) => Err(format!("{what}失敗：找不到（404），請確認網址")),
        Err(ureq::Error::StatusCode(code)) => Err(format!("{what}失敗：伺服器回應 {code}")),
        // 409（例如 PR 已經存在）由呼叫端說明。
        Err(e) => Err(format!("{what}失敗：無法連線到 Azure DevOps（{e}）")),
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
    e.contains("（404）")
}

/// 讀取登入資訊。connectionData 是預覽版的 API，伺服器可能不接受正式版號（5.0），
/// 所以用預覽版號；還是被拒絕時（舊版伺服器）不帶版號再試一次。
fn connection_data(base: &str, pat: &str) -> Result<Value, String> {
    let path = "/_apis/connectionData";
    get_version(base, pat, path, Some("5.0-preview"), "連線").or_else(|e| {
        if e.contains("伺服器回應 400") || is_not_found(&e) {
            get_version(base, pat, path, None, "連線").map_err(|_| e)
        } else {
            Err(e)
        }
    })
}

/// 確認 `base` 是可以使用的集合。網址是伺服器（例如 https://伺服器/tfs）而不是集合時，
/// 伺服器上只有一個集合就自動使用它，有好幾個就請使用者指定。
fn connect_at(base: &str, pat: &str) -> Result<Account, String> {
    let data = connection_data(base, pat)?;
    let (name, account) = user_of(&data).ok_or("連線失敗：個人存取權杖無效或已過期")?;
    let check = |url: &str| get(url, pat, "/_apis/projects?$top=1", "連線");
    let url = match check(base) {
        Ok(_) => base.to_string(),
        Err(e) if is_not_found(&e) => {
            let list = get(base, pat, "/_apis/projectCollections", "連線").map_err(|_| e)?;
            let names: Vec<&str> = values(&list)
                .iter()
                .filter_map(|c| str_of(c, "name"))
                .collect();
            match names.as_slice() {
                [] => return Err("連線失敗：這台伺服器上沒有可以使用的集合".into()),
                [one] => {
                    let url = format!("{base}/{}", encode_segment(one));
                    check(&url)?;
                    url
                }
                many => {
                    return Err(format!(
                        "這台伺服器上有好幾個集合（{}），請在網址後面加上集合名稱，例如 {base}/{}",
                        many.join("、"),
                        encode_segment(many[0])
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
    format!(
        "連線失敗：找不到 Azure DevOps（404）。已試過：{}。請輸入集合的網址，\
         例如 https://伺服器/tfs/DefaultCollection（在瀏覽器打開 TFS，網址裡專案名稱前面的那一段）",
        tries.join("、")
    )
}

/// 用網址與個人存取權杖連線：確認可以登入後記住（權杖存在 Windows 認證管理員）。
#[tauri::command]
pub async fn ado_connect(app: AppHandle, url: String, pat: String) -> Result<Account, String> {
    let pat = pat.trim().to_string();
    if pat.is_empty() {
        return Err("請輸入個人存取權杖".into());
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
    let path = account_file(&app).ok_or("找不到設定資料夾")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("無法建立設定資料夾：{e}"))?;
    }
    let json = serde_json::to_string_pretty(&account).unwrap_or_default();
    crate::files::write_atomic(&path, json.as_bytes()).map_err(|e| format!("無法儲存：{e}"))?;
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
}

fn require(app: &AppHandle) -> Result<(Account, String), String> {
    connection(app).ok_or_else(|| "請先到設定的 Git 頁連線到 Azure DevOps".to_string())
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
        let repos = get(&base, &pat, "/_apis/git/repositories", "讀取儲存庫清單")?;
        // 讀不到 Wiki（例如沒有權限）時仍然列出儲存庫。
        let wikis = get(&base, &pat, "/_apis/wiki/wikis", "讀取 Wiki").unwrap_or(Value::Null);
        let projects = if values(&wikis).is_empty() {
            Value::Null
        } else {
            get(&base, &pat, "/_apis/projects?$top=1000", "讀取專案").unwrap_or(Value::Null)
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
) -> Result<Option<FolderInfo>, String> {
    let (a, _) = require(&app)?;
    // 只下載這台伺服器上的儲存庫，避免前端傳來任意網址時把權杖送到別的地方。
    if !starts_with_base(&clone_url, &a.url) {
        return Err("儲存庫網址不在目前連線的 Azure DevOps 上".into());
    }
    let folder = name.trim().trim_end_matches(".wiki").to_string();
    let folder = if name.trim().ends_with(".wiki") {
        format!("{folder}-wiki")
    } else {
        folder
    };
    let Some(dest) = crate::github::pick_clone_dest(&app, &window, &folder).await? else {
        return Ok(None);
    };
    let auth = crate::git::auth(&app);
    let target = dest.clone();
    crate::io::blocking_for(crate::git::NETWORK_TIMEOUT, move || {
        crate::git::clone_to(&clone_url, &target, &auth)
    })
    .await?;
    Ok(Some(crate::workspace::open_folder_from_cli(&app, dest)))
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
    let (project, repo) =
        project_and_repo(remote, &base).ok_or("這個儲存庫不在目前連線的 Azure DevOps 上")?;
    let what = "建立 Pull Request";
    let info = get(
        &base,
        &pat,
        &format!("/{project}/_apis/git/repositories/{repo}"),
        what,
    )?;
    let id = str_of(&info, "id").ok_or("讀取儲存庫失敗")?.to_string();
    let target = str_of(&info, "defaultBranch")
        .unwrap_or("refs/heads/main")
        .to_string();
    if target == format!("refs/heads/{branch}") {
        return Err(format!(
            "目前在預設分支「{branch}」上，請先建立新分支再建立 Pull Request"
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
            format!("{what}失敗：這個分支已經有一個開著的 Pull Request")
        } else {
            e
        }
    })?;
    let number = res
        .get("pullRequestId")
        .and_then(Value::as_u64)
        .ok_or("建立 Pull Request 失敗：回應的格式不正確")?;
    Ok(format!("{web}/pullrequest/{number}"))
}

// ---- 工作項目 ---------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    id: u64,
    title: String,
    state: String,
    kind: String,
    project: String,
    changed: Option<String>,
    web_url: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemDetail {
    #[serde(flatten)]
    item: WorkItem,
    assigned_to: Option<String>,
    /// 說明（HTML，前端轉成純文字顯示）。
    description: Option<String>,
    /// 驗收條件或重現步驟（HTML）。
    details: Option<String>,
}

/// 指派給我、還沒結束的工作項目；中英文的流程範本都有對應的「結束」狀態名稱。
const CLOSED_STATES: &[&str] = &[
    "Closed",
    "Done",
    "Removed",
    "Completed",
    "Cut",
    "Inactive",
    "已關閉",
    "已完成",
    "已移除",
    "已刪除",
    "關閉",
    "完成",
];
const FIELDS: &str =
    "System.Id,System.Title,System.State,System.WorkItemType,System.TeamProject,System.ChangedDate";

fn wiql_string(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 依搜尋文字決定查詢：空白是「指派給我」，數字是工作項目編號，其他搜尋標題。
fn wiql_for(search: &str) -> Option<String> {
    let q = search.trim().trim_start_matches('#');
    if q.chars().all(|c| c.is_ascii_digit()) && !q.is_empty() {
        return None;
    }
    let select = "SELECT [System.Id] FROM WorkItems WHERE";
    let order = "ORDER BY [System.ChangedDate] DESC";
    Some(if q.is_empty() {
        let closed: Vec<String> = CLOSED_STATES.iter().map(|s| wiql_string(s)).collect();
        format!(
            "{select} [System.AssignedTo] = @Me AND [System.State] NOT IN ({}) {order}",
            closed.join(", ")
        )
    } else {
        format!(
            "{select} [System.Title] CONTAINS {} {order}",
            wiql_string(q)
        )
    })
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
        changed: field(v, "System.ChangedDate")
            .and_then(Value::as_str)
            .map(str::to_string),
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
pub async fn ado_work_items(app: AppHandle, search: String) -> Result<Vec<WorkItem>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let base = a.url;
        let ids: Vec<u64> = match wiql_for(&search) {
            Some(query) => {
                let res = post(
                    &base,
                    &pat,
                    "/_apis/wit/wiql?$top=100",
                    &serde_json::json!({ "query": query }),
                    "查詢工作項目",
                )?;
                res.get("workItems")
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .filter_map(|w| w.get("id").and_then(Value::as_u64))
                            .take(100)
                            .collect()
                    })
                    .unwrap_or_default()
            }
            None => vec![search.trim().trim_start_matches('#').parse().unwrap_or(0)],
        };
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let list: Vec<String> = ids.iter().map(u64::to_string).collect();
        let res = get(
            &base,
            &pat,
            &format!(
                "/_apis/wit/workitems?ids={}&fields={FIELDS}&errorPolicy=omit",
                list.join(",")
            ),
            "讀取工作項目",
        )?;
        let items: Vec<WorkItem> = values(&res)
            .iter()
            .filter_map(|v| item_of(&base, v))
            .collect();
        // 保持查詢的排序（最近更新的在前面）。
        Ok(ids
            .iter()
            .filter_map(|id| items.iter().find(|w| w.id == *id))
            .map(|w| WorkItem {
                id: w.id,
                title: w.title.clone(),
                state: w.state.clone(),
                kind: w.kind.clone(),
                project: w.project.clone(),
                changed: w.changed.clone(),
                web_url: w.web_url.clone(),
            })
            .collect())
    })
    .await
}

/// 一個工作項目的內容。
#[tauri::command]
pub async fn ado_work_item(app: AppHandle, id: u64) -> Result<WorkItemDetail, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let v = get(
            &a.url,
            &pat,
            &format!("/_apis/wit/workitems/{id}"),
            "讀取工作項目",
        )?;
        detail_of(&a.url, &v).ok_or_else(|| "讀取工作項目失敗：回應的格式不正確".to_string())
    })
    .await
}

fn detail_of(base: &str, v: &Value) -> Option<WorkItemDetail> {
    let html = |name: &str| {
        field(v, name)
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
    };
    Some(WorkItemDetail {
        item: item_of(base, v)?,
        assigned_to: person(field(v, "System.AssignedTo")),
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
    fn builds_wiql_for_each_search() {
        assert!(wiql_for("").unwrap().contains("[System.AssignedTo] = @Me"));
        assert!(wiql_for("").unwrap().contains("'已關閉'"));
        assert_eq!(wiql_for("#123"), None);
        assert!(wiql_for("登入 bug")
            .unwrap()
            .contains("CONTAINS '登入 bug'"));
        assert!(wiql_for("it's").unwrap().contains("'it''s'"));
    }

    #[test]
    fn reads_work_item_fields() {
        let v = json!({"id": 42, "fields": {
            "System.Title": "修正登入", "System.State": "Active", "System.WorkItemType": "Bug",
            "System.TeamProject": "產品", "System.AssignedTo": {"displayName": "王小明"},
            "Microsoft.VSTS.TCM.ReproSteps": "<div>步驟</div>"
        }});
        let d = detail_of("https://tfs/DC", &v).unwrap();
        assert_eq!(d.item.title, "修正登入");
        assert_eq!(d.assigned_to.as_deref(), Some("王小明"));
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
