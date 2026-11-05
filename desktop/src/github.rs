//! GitHub 帳號：用「裝置碼」登入（在瀏覽器輸入一組代碼授權，程式裡不需要輸入密碼），
//! 列出儲存庫、下載（clone）、把資料夾上傳成新的儲存庫。
//! 權杖存在 Windows 認證管理員；帳號名稱存在設定資料夾（不含權杖）。

use parking_lot::Mutex;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, Window};

use crate::confirm::Question;
use crate::git::{Auth, Identity};
use crate::workspace::Workspace;

/// GitHub OAuth App「oMarker」的 Client ID（公開資訊，不是密碼）。
/// 建置時可以用環境變數 `OMARKER_GITHUB_CLIENT_ID` 換成別的 App；空字串（CI 沒設定變數時）視為沒有設定。
const CLIENT_ID: &str = match option_env!("OMARKER_GITHUB_CLIENT_ID") {
    Some(id) if !id.is_empty() => id,
    _ => "Ov23liehNX3rQk93c6rf",
};
const SERVICE: &str = "omarker-github";
const API: &str = "https://api.github.com";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub login: String,
    pub id: u64,
    pub name: Option<String>,
}

/// 這次開啟期間的權杖（非 Windows 平台不保存到磁碟，只記在這裡）。
static TOKEN: Mutex<Option<String>> = Mutex::new(None);
static CANCEL: AtomicBool = AtomicBool::new(false);

fn account_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("github-account.json"))
}

fn token(app: &AppHandle) -> Option<String> {
    let mut cached = TOKEN.lock();
    if cached.is_none() {
        *cached = crate::secrets::get(SERVICE, "token");
    }
    // 權杖還在但帳號資料不見了（例如手動刪了設定檔）：當成沒有登入。
    cached.clone().filter(|_| account(app).is_some())
}

static ACCOUNT: crate::secrets::CachedAccount<Account> = crate::secrets::CachedAccount::new();

fn account(app: &AppHandle) -> Option<Account> {
    ACCOUNT.get(|| account_file(app))
}

/// 連到 GitHub 時用的認證。
pub fn auth(app: &AppHandle) -> Auth {
    Auth {
        github_token: token(app),
        ..Auth::default()
    }
}

/// 提交時的名字與 Email：GitHub 的帳號名稱與不公開的 noreply 信箱。
pub fn identity(app: &AppHandle) -> Option<Identity> {
    token(app)?;
    identity_of(&account(app)?)
}

fn identity_of(a: &Account) -> Option<Identity> {
    Some(Identity {
        name: a
            .name
            .clone()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| a.login.clone()),
        email: format!("{}+{}@users.noreply.github.com", a.id, a.login),
    })
}

// ---- HTTP -------------------------------------------------------------------

fn read(
    res: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    what: &str,
) -> Result<String, String> {
    match res {
        Ok(mut r) => r
            .body_mut()
            .read_to_string()
            .map_err(|e| tr!("{what}失敗：{e}", what = what, e = e)),
        Err(ureq::Error::StatusCode(401)) => Err(tr!("GitHub 登入已過期，請重新登入")),
        Err(ureq::Error::StatusCode(422)) => Err(tr!(
            "{what}失敗：名稱已經被使用，或不符合 GitHub 的規定",
            what = what
        )),
        Err(ureq::Error::StatusCode(code)) => Err(tr!(
            "{what}失敗：GitHub 回應 {code}",
            what = what,
            code = code
        )),
        Err(e) => Err(tr!(
            "{what}失敗：無法連線到 GitHub（{e}）",
            what = what,
            e = e
        )),
    }
}

fn api_get(token: &str, path: &str, what: &str) -> Result<String, String> {
    read(
        crate::update::agent()
            .get(&format!("{API}{path}"))
            .header("Authorization", &format!("Bearer {token}"))
            .header("Accept", "application/vnd.github+json")
            .call(),
        what,
    )
}

fn form(url: &str, body: &str, what: &str) -> Result<serde_json::Value, String> {
    let text = read(
        crate::update::agent()
            .post(url)
            .header("Accept", "application/json")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .send(body),
        what,
    )?;
    serde_json::from_str(&text).map_err(|e| tr!("{what}失敗：{e}", what = what, e = e))
}

// ---- 登入 -------------------------------------------------------------------

/// 給網頁顯示的登入代碼。換權杖用的 `device_code` 不交給網頁，只記在原生端（`PENDING`）：
/// 網頁萬一被注入程式碼，也不能拿別人（例如攻擊者自己帳號）授權過的代碼來登入。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    user_code: String,
    verification_uri: String,
    interval: u64,
    expires_in: u64,
}

/// 這次登入要等的代碼：`github_login_start` 向 GitHub 要到的，`github_login_wait` 取出來換權杖。
#[derive(Debug, PartialEq)]
struct Pending {
    device_code: String,
    interval: u64,
    expires_in: u64,
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

const DEVICE_PAGE: &str = "https://github.com/login/device";

/// 讀出 GitHub 回傳的代碼。輸入代碼的網頁只接受 `https://github.com/…`，其他網址改用預設的網頁。
fn device_code_of(v: &serde_json::Value) -> Result<(Pending, DeviceCode), String> {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let n = |k: &str, d: u64| v.get(k).and_then(|x| x.as_u64()).unwrap_or(d);
    let missing = || tr!("登入失敗：GitHub 沒有回傳代碼");
    let pending = Pending {
        device_code: s("device_code").ok_or_else(missing)?,
        interval: n("interval", 5),
        expires_in: n("expires_in", 900),
    };
    let code = DeviceCode {
        user_code: s("user_code").ok_or_else(missing)?,
        verification_uri: s("verification_uri")
            .filter(|u| u.starts_with("https://github.com/"))
            .unwrap_or_else(|| DEVICE_PAGE.into()),
        interval: pending.interval,
        expires_in: pending.expires_in,
    };
    Ok((pending, code))
}

#[tauri::command]
pub fn github_account(app: AppHandle) -> Option<Account> {
    token(&app)?;
    account(&app)
}

/// 開始登入：向 GitHub 要一組代碼，並在瀏覽器開啟輸入代碼的網頁。
#[tauri::command]
pub async fn github_login_start(app: AppHandle) -> Result<DeviceCode, String> {
    let id = CLIENT_ID;
    let v = crate::io::blocking_for(Duration::from_secs(30), move || {
        form(
            "https://github.com/login/device/code",
            // repo：儲存庫、issue、PR、Pages；gist：分享成 Gist。
            &format!("client_id={id}&scope=repo%20gist"),
            &tr!("登入"),
        )
    })
    .await?;
    let (pending, code) = device_code_of(&v)?;
    *PENDING.lock() = Some(pending);
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_url(&code.verification_uri, None::<&str>);
    Ok(code)
}

/// 等使用者在瀏覽器授權（依 GitHub 指定的間隔詢問），成功後記住權杖與帳號。
/// 代碼用 `github_login_start` 記在原生端的那一組，網頁不能指定。
#[tauri::command]
pub async fn github_login_wait(app: AppHandle, window: Window) -> Result<Account, String> {
    let id = CLIENT_ID;
    let Pending {
        device_code,
        interval,
        expires_in,
    } = PENDING
        .lock()
        .take()
        .ok_or_else(|| tr!("代碼已過期，請重新登入"))?;
    CANCEL.store(false, Ordering::SeqCst);
    let limit = Duration::from_secs(expires_in.clamp(60, 1800));
    let token = crate::io::blocking_for(limit + Duration::from_secs(30), move || {
        let start = Instant::now();
        let mut wait = interval.clamp(1, 60);
        loop {
            // 每秒檢查一次有沒有按「取消」。
            for _ in 0..wait {
                if CANCEL.load(Ordering::SeqCst) {
                    return Err(tr!("已取消登入"));
                }
                std::thread::sleep(Duration::from_secs(1));
            }
            if start.elapsed() > limit {
                return Err(tr!("代碼已過期，請重新登入"));
            }
            let v = form(
                "https://github.com/login/oauth/access_token",
                &format!(
                    "client_id={id}&device_code={device_code}&grant_type=urn:ietf:params:oauth:grant-type:device_code"
                ),
                &tr!("登入"),
            )?;
            if let Some(t) = v.get("access_token").and_then(|x| x.as_str()) {
                return Ok(t.to_string());
            }
            match v.get("error").and_then(|x| x.as_str()) {
                Some("authorization_pending") => {}
                Some("slow_down") => wait += 5,
                Some("expired_token") => return Err(tr!("代碼已過期，請重新登入")),
                Some("access_denied") => return Err(tr!("你在 GitHub 拒絕了授權")),
                Some(other) => return Err(tr!("登入失敗：{other}", other = other)),
                None => return Err(tr!("登入失敗：GitHub 的回應不正確")),
            }
        }
    })
    .await?;
    let t = token.clone();
    let text = crate::io::blocking_for(Duration::from_secs(30), move || {
        api_get(&t, "/user", &tr!("讀取帳號"))
    })
    .await?;
    let account: Account =
        serde_json::from_str(&text).map_err(|e| tr!("讀取帳號失敗：{e}", e = e))?;
    if !crate::confirm::confirm(&window, Some(login_question(&account.login))).await {
        return Err(tr!("已取消登入"));
    }
    let path = account_file(&app).ok_or_else(|| tr!("找不到設定資料夾"))?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| tr!("無法建立設定資料夾：{e}", e = e))?;
    }
    let json = serde_json::to_string_pretty(&account).unwrap_or_default();
    crate::files::write_atomic(&path, json.as_bytes()).map_err(|e| tr!("無法儲存：{e}", e = e))?;
    ACCOUNT.set(Some(account.clone()));
    crate::secrets::set(SERVICE, "token", &token);
    *TOKEN.lock() = Some(token);
    Ok(account)
}

/// 登入完成、記住權杖前要問的話。網頁看得到要輸入的代碼：被注入的網頁可以把代碼交給別人，
/// 讓對方用自己的帳號授權，之後上傳、分享就會送到那個帳號。所以由使用者確認帳號名稱。
fn login_question(login: &str) -> Question {
    Question::new(
        tr!("登入 GitHub"),
        tr!(
            "要用 GitHub 帳號「{login}」登入 oMarker 嗎？之後上傳、分享成 Gist 都會用這個帳號。只有在你自己剛剛在瀏覽器授權時才選「是」。",
            login = login
        ),
    )
}

#[tauri::command]
pub fn github_login_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn github_logout(app: AppHandle) {
    crate::secrets::forget(SERVICE, "token");
    *TOKEN.lock() = None;
    if let Some(p) = account_file(&app) {
        let _ = fs::remove_file(p);
    }
    ACCOUNT.set(None);
}

// ---- 儲存庫 -----------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    #[serde(alias = "full_name")]
    full_name: String,
    name: String,
    private: bool,
    description: Option<String>,
    #[serde(alias = "updated_at")]
    updated_at: Option<String>,
    #[serde(alias = "clone_url")]
    clone_url: String,
}

fn require_token(app: &AppHandle) -> Result<String, String> {
    token(app).ok_or_else(|| tr!("請先用 GitHub 登入"))
}

/// 自己的、參與的、組織的儲存庫，最近更新的在前面（最多 300 個）。
#[tauri::command]
pub async fn github_repos(app: AppHandle) -> Result<Vec<Repo>, String> {
    let token = require_token(&app)?;
    crate::io::blocking_for(Duration::from_secs(60), move || {
        let mut out = Vec::new();
        for page in 1..=3 {
            let text = api_get(
                &token,
                &format!("/user/repos?per_page=100&sort=updated&page={page}"),
                &tr!("讀取儲存庫清單"),
            )?;
            let list: Vec<Repo> =
                serde_json::from_str(&text).map_err(|e| tr!("讀取儲存庫清單失敗：{e}", e = e))?;
            let done = list.len() < 100;
            out.extend(list);
            if done {
                break;
            }
        }
        Ok(out)
    })
    .await
}

/// 下載儲存庫：選擇要放在哪個資料夾，下載到裡面的「儲存庫名稱」資料夾，然後開啟它。
#[tauri::command]
pub async fn github_clone(
    app: AppHandle,
    window: Window,
    full_name: String,
) -> Result<Option<crate::git_clone::Cloned>, String> {
    let auth = Auth {
        github_token: Some(require_token(&app)?),
        ..Auth::default()
    };
    let name = full_name
        .rsplit('/')
        .next()
        .filter(|n| !n.is_empty() && !n.starts_with('.') && !n.contains(['\\', ':']))
        .ok_or_else(|| tr!("儲存庫名稱不正確"))?
        .to_string();
    if full_name.split('/').count() != 2 {
        return Err(tr!("儲存庫名稱不正確"));
    }
    let url = format!("https://github.com/{full_name}.git");
    let Some(dest) = crate::git_clone::pick_clone_dest(&app, &window, &name, &url).await? else {
        return Ok(None);
    };
    crate::git_clone::clone_and_open(&app, dest, url, auth, "GitHub")
        .await
        .map(Some)
}

#[derive(Deserialize)]
struct Created {
    clone_url: String,
    html_url: String,
}

/// 目前登入的帳號名稱（確認對話框裡顯示用）。
fn login_name(app: &AppHandle) -> String {
    account(app).map(|a| a.login).unwrap_or_default()
}

/// 上傳成新的儲存庫前要問的話：公開的儲存庫一定要問；私人的只有在會換掉資料夾原本的遠端 origin 時才問
/// （原本的 origin 已經是同一個 GitHub 儲存庫時不算換掉）。
fn publish_question(
    login: &str,
    name: &str,
    folder: &str,
    private: bool,
    origin: Option<&str>,
) -> Option<Question> {
    let replaced = origin
        .filter(|o| {
            crate::git_files::github_repo(o).is_none_or(|(owner, repo)| {
                !owner.eq_ignore_ascii_case(login) || !repo.eq_ignore_ascii_case(name)
            })
        })
        .map(crate::git_files::display_remote);
    if !private {
        let mut message = tr!(
            "要在 GitHub 帳號「{login}」建立公開的儲存庫「{name}」，並上傳「{folder}」資料夾裡所有的檔案和版本紀錄嗎？所有人都看得到。",
            login = login,
            name = name,
            folder = folder
        );
        if let Some(origin) = replaced {
            message.push_str("\n\n");
            message.push_str(&tr!(
                "這個資料夾原本的遠端 origin「{origin}」會改成新的儲存庫。",
                origin = origin
            ));
        }
        return Some(Question::new(tr!("公開到 GitHub"), message));
    }
    let origin = replaced?;
    Some(Question::new(
        tr!("上傳到 GitHub"),
        tr!(
            "「{folder}」資料夾原本的遠端 origin 是「{origin}」。要改成 GitHub 帳號「{login}」新的私人儲存庫「{name}」，並上傳所有的檔案和版本紀錄嗎？",
            folder = folder,
            origin = origin,
            login = login,
            name = name
        ),
    ))
}

/// 把目前開啟的資料夾上傳成新的 GitHub 儲存庫，回傳儲存庫的網頁網址。
/// 建立公開的儲存庫、或會換掉資料夾原本的遠端 origin 時，先用系統的對話框確認；
/// 使用者選「否」時什麼都不做，回傳 `None`。
#[tauri::command]
pub async fn github_publish(
    app: AppHandle,
    window: Window,
    workspace: State<'_, Workspace>,
    name: String,
    private: bool,
) -> Result<Option<String>, String> {
    let token = require_token(&app)?;
    let dir = workspace.root().ok_or_else(|| tr!("還沒有開啟資料夾"))?;
    let who = identity(&app);
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(tr!("請輸入儲存庫名稱"));
    }
    let d = dir.clone();
    let origin = crate::io::blocking(move || Ok(crate::git::origin_at(&d))).await?;
    let question = publish_question(
        &login_name(&app),
        &name,
        &crate::files::display_name(&dir),
        private,
        origin.as_deref(),
    );
    if !crate::confirm::confirm(&window, question).await {
        return Ok(None);
    }
    crate::io::blocking_for(crate::git::NETWORK_TIMEOUT, move || {
        let body = serde_json::json!({ "name": name, "private": private }).to_string();
        let text = read(
            crate::update::agent()
                .post(&format!("{API}/user/repos"))
                .header("Authorization", &format!("Bearer {token}"))
                .header("Accept", "application/vnd.github+json")
                .header("Content-Type", "application/json")
                .send(&body),
            &tr!("建立儲存庫"),
        )?;
        let created: Created =
            serde_json::from_str(&text).map_err(|e| tr!("建立儲存庫失敗：{e}", e = e))?;
        let auth = Auth {
            github_token: Some(token),
            ..Auth::default()
        };
        crate::git::publish_at(&dir, &created.clone_url, &auth, who.as_ref())?;
        Ok(Some(created.html_url))
    })
    .await
}

// ---- 建立 PR、GitHub Pages、Gist ----------------------------------------------

/// 送出 JSON；回傳狀態碼與內容（4xx 也回傳，讓呼叫端依狀態碼說明）。
fn api_send(
    token: &str,
    method: &str,
    path: &str,
    body: &serde_json::Value,
    what: &str,
) -> Result<(u16, serde_json::Value), String> {
    let agent = crate::update::agent();
    let url = format!("{API}{path}");
    let req = match method {
        "PUT" => agent.put(&url),
        _ => agent.post(&url),
    };
    let res = req
        .config()
        .http_status_as_error(false)
        .build()
        .header("Authorization", &format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("Content-Type", "application/json")
        .send(&body.to_string());
    match res {
        Ok(mut r) => {
            let code = r.status().as_u16();
            let text = r.body_mut().read_to_string().unwrap_or_default();
            Ok((
                code,
                serde_json::from_str(&text).unwrap_or(serde_json::Value::Null),
            ))
        }
        Err(e) => Err(tr!(
            "{what}失敗：無法連線到 GitHub（{e}）",
            what = what,
            e = e
        )),
    }
}

fn github_message(v: &serde_json::Value) -> String {
    let main = v
        .get("message")
        .and_then(|x| x.as_str())
        .unwrap_or_default();
    let detail = v
        .get("errors")
        .and_then(|x| x.as_array())
        .and_then(|l| l.first())
        .and_then(|e| e.get("message").and_then(|m| m.as_str()))
        .unwrap_or_default();
    [main, detail]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(&tr!("："))
}

/// 儲存庫的預設分支（通常是 main）。
pub(crate) fn default_branch(token: &str, owner: &str, name: &str) -> Result<String, String> {
    let v: serde_json::Value = serde_json::from_str(&api_get(
        token,
        &format!("/repos/{owner}/{name}"),
        &tr!("讀取儲存庫"),
    )?)
    .map_err(|e| tr!("讀取儲存庫失敗：{e}", e = e))?;
    Ok(v.get("default_branch")
        .and_then(|x| x.as_str())
        .unwrap_or("main")
        .to_string())
}

/// 建立 PR：從 `branch` 合併到預設分支；這個分支已經有開著的 PR 時直接回傳它的網址。
pub(crate) fn create_pull(
    token: &str,
    owner: &str,
    name: &str,
    branch: &str,
    title: &str,
    body: &str,
) -> Result<String, String> {
    let base = default_branch(token, owner, name)?;
    if branch == base {
        return Err(tr!(
            "目前在預設分支「{base}」上，請先建立新分支再建立 Pull Request",
            base = base
        ));
    }
    let what = &tr!("建立 Pull Request");
    let (code, v) = api_send(
        token,
        "POST",
        &format!("/repos/{owner}/{name}/pulls"),
        &serde_json::json!({ "title": title, "head": branch, "base": base, "body": body }),
        what,
    )?;
    if code == 201 {
        return v
            .get("html_url")
            .and_then(|x| x.as_str())
            .map(str::to_string)
            .ok_or_else(|| tr!("{what}失敗：GitHub 的回應不正確", what = what));
    }
    if code == 422 {
        // 已經有 PR，或兩個分支沒有差異。
        let existing = api_get(
            token,
            &format!(
                "/repos/{owner}/{name}/pulls?state=open&head={}",
                crate::git_files::encode(&format!("{owner}:{branch}"))
            ),
            what,
        )
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|l| {
            l.as_array()?
                .first()?
                .get("html_url")?
                .as_str()
                .map(str::to_string)
        });
        if let Some(url) = existing {
            return Ok(url);
        }
        return Err(tr!(
            "{what}失敗：「{branch}」和「{base}」沒有差異，或 GitHub 不接受（{msg}）",
            msg = github_message(&v),
            what = what,
            branch = branch,
            base = base
        ));
    }
    Err(tr!(
        "{what}失敗：GitHub 回應 {code}（{msg}）",
        msg = github_message(&v),
        what = what,
        code = code
    ))
}

/// 開啟 GitHub Pages 前要問的話（網站一定是公開的）。
fn pages_question(login: &str, owner: &str, name: &str) -> Question {
    Question::new(
        tr!("發佈成網站（GitHub Pages）"),
        tr!(
            "要用 GitHub 帳號「{login}」開啟 GitHub Pages，把儲存庫「{repo}」預設分支的內容發佈成公開的網站嗎？就算儲存庫是私人的，所有人也都看得到這個網站。",
            login = login,
            repo = format!("{owner}/{name}")
        ),
    )
}

/// 用 GitHub Pages 把儲存庫發佈成網站（從預設分支的根目錄），回傳網站網址。
/// 網站是公開的，先用系統的對話框確認；使用者選「否」時回傳 `None`。
#[tauri::command]
pub async fn github_pages(app: AppHandle, window: Window) -> Result<Option<String>, String> {
    let token = require_token(&app)?;
    let (owner, name) = crate::git_files::workspace_github_repo(&app)?;
    let question = pages_question(&login_name(&app), &owner, &name);
    if !crate::confirm::confirm(&window, Some(question)).await {
        return Ok(None);
    }
    crate::io::blocking_for(Duration::from_secs(60), move || {
        let what = &tr!("發佈網站");
        let branch = default_branch(&token, &owner, &name)?;
        let (code, v) = api_send(
            &token,
            "POST",
            &format!("/repos/{owner}/{name}/pages"),
            &serde_json::json!({ "source": { "branch": branch, "path": "/" } }),
            what,
        )?;
        let url = match code {
            201 => v
                .get("html_url")
                .and_then(|x| x.as_str())
                .map(str::to_string),
            // 已經開啟過：讀出目前的網址。
            409 => api_get(&token, &format!("/repos/{owner}/{name}/pages"), what)
                .ok()
                .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .and_then(|p| p.get("html_url")?.as_str().map(str::to_string)),
            422 => {
                return Err(tr!(
                    "{what}失敗：私人儲存庫需要 GitHub 付費方案才能使用 GitHub Pages（{msg}）",
                    msg = github_message(&v),
                    what = what
                ))
            }
            403 | 404 => {
                return Err(tr!(
                    "{what}失敗：沒有權限設定這個儲存庫的 GitHub Pages（{msg}）",
                    msg = github_message(&v),
                    what = what
                ))
            }
            _ => {
                return Err(tr!(
                    "{what}失敗：GitHub 回應 {code}（{msg}）",
                    msg = github_message(&v),
                    what = what,
                    code = code
                ))
            }
        };
        Ok(Some(url.unwrap_or_else(|| {
            format!("https://{owner}.github.io/{name}/")
        })))
    })
    .await
}

/// 分享成 Gist 前要問的話：只有公開的 Gist 要問（秘密 Gist 要知道網址才看得到）。
fn gist_question(login: &str, file_name: &str, public: bool) -> Option<Question> {
    public.then(|| {
        Question::new(
            tr!("公開分享成 Gist"),
            tr!(
                "要用 GitHub 帳號「{login}」把「{name}」公開分享成 Gist 嗎？所有人都找得到、看得到內容。",
                login = login,
                name = file_name
            ),
        )
    })
}

/// 把文字分享成 Gist，回傳網址。`public` 為 false 時是秘密 Gist（知道網址的人才看得到）。
/// 公開的 Gist 先用系統的對話框確認；使用者選「否」時回傳 `None`。
#[tauri::command]
pub async fn github_gist(
    app: AppHandle,
    window: Window,
    file_name: String,
    content: String,
    description: String,
    public: bool,
) -> Result<Option<String>, String> {
    let token = require_token(&app)?;
    if content.trim().is_empty() {
        return Err(tr!("沒有內容可以分享"));
    }
    let file_name = file_name
        .trim()
        .replace(['/', '\\'], "-")
        .chars()
        .take(100)
        .collect::<String>();
    let file_name = if file_name.is_empty() {
        tr!("筆記.md")
    } else {
        file_name
    };
    let question = gist_question(&login_name(&app), &file_name, public);
    if !crate::confirm::confirm(&window, question).await {
        return Ok(None);
    }
    crate::io::blocking_for(Duration::from_secs(60), move || {
        let what = &tr!("分享成 Gist");
        let (code, v) = api_send(
            &token,
            "POST",
            "/gists",
            &serde_json::json!({
                "description": description,
                "public": public,
                "files": { file_name: { "content": content } },
            }),
            what,
        )?;
        match code {
            201 => v
                .get("html_url")
                .and_then(|x| x.as_str())
                .map(|u| Some(u.to_string()))
                .ok_or_else(|| tr!("{what}失敗：GitHub 的回應不正確", what = what)),
            // 1.8.0 以前登入的權杖沒有 gist 權限。
            403 | 404 => Err(tr!(
                "{what}失敗：目前的 GitHub 登入沒有 Gist 權限。請到設定的 GitHub 頁按「重新登入」",
                what = what
            )),
            _ => Err(tr!(
                "{what}失敗：GitHub 回應 {code}（{msg}）",
                msg = github_message(&v),
                what = what,
                code = code
            )),
        }
    })
    .await
}

// ---- Issues -----------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    number: u64,
    title: String,
    state: String,
    labels: Vec<String>,
    author: String,
    comments: u64,
    updated: Option<String>,
    web_url: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IssueComment {
    author: String,
    created: Option<String>,
    body: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    #[serde(flatten)]
    issue: Issue,
    assignees: Vec<String>,
    body: String,
    comment_list: Vec<IssueComment>,
}

fn login_of(v: &serde_json::Value) -> String {
    v.get("login")
        .and_then(|x| x.as_str())
        .unwrap_or_default()
        .to_string()
}

/// GitHub 的 issue 清單也會包含 PR（有 `pull_request` 欄位），這裡只留下 issue。
fn issue_of(v: &serde_json::Value) -> Option<Issue> {
    if v.get("pull_request").is_some() {
        return None;
    }
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    Some(Issue {
        number: v.get("number")?.as_u64()?,
        title: s("title").unwrap_or_default(),
        state: s("state").unwrap_or_default(),
        labels: v
            .get("labels")
            .and_then(|x| x.as_array())
            .map(|l| {
                l.iter()
                    .filter_map(|x| x.get("name").and_then(|n| n.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        author: v.get("user").map(login_of).unwrap_or_default(),
        comments: v.get("comments").and_then(|x| x.as_u64()).unwrap_or(0),
        updated: s("updated_at"),
        web_url: s("html_url")?,
    })
}

fn json(text: &str, what: &str) -> Result<serde_json::Value, String> {
    serde_json::from_str(text).map_err(|e| tr!("{what}失敗：{e}", what = what, e = e))
}

/// 目前資料夾的 GitHub 儲存庫的 issue：搜尋文字空白時是還沒關閉的，數字是編號，其他搜尋標題與內容。
#[tauri::command]
pub async fn github_issues(app: AppHandle, search: String) -> Result<Vec<Issue>, String> {
    let token = require_token(&app)?;
    let (owner, name) = crate::git_files::workspace_github_repo(&app)?;
    crate::io::blocking_for(Duration::from_secs(60), move || {
        let q = search.trim().trim_start_matches('#').to_string();
        let what = &tr!("讀取 issue");
        if !q.is_empty() && q.chars().all(|c| c.is_ascii_digit()) {
            let v = json(
                &api_get(&token, &format!("/repos/{owner}/{name}/issues/{q}"), what).or_else(
                    |e| {
                        if e.contains("404") {
                            Ok("{}".into())
                        } else {
                            Err(e)
                        }
                    },
                )?,
                what,
            )?;
            return Ok(issue_of(&v).into_iter().collect());
        }
        if q.is_empty() {
            let v = json(
                &api_get(
                    &token,
                    &format!("/repos/{owner}/{name}/issues?state=open&sort=updated&per_page=100"),
                    what,
                )?,
                what,
            )?;
            return Ok(v
                .as_array()
                .map(|l| l.iter().filter_map(issue_of).collect())
                .unwrap_or_default());
        }
        let query = crate::git_files::encode(&format!("repo:{owner}/{name} is:issue {q}"));
        let v = json(
            &api_get(
                &token,
                &format!("/search/issues?q={query}&sort=updated&per_page=50"),
                what,
            )?,
            what,
        )?;
        Ok(v.get("items")
            .and_then(|x| x.as_array())
            .map(|l| l.iter().filter_map(issue_of).collect())
            .unwrap_or_default())
    })
    .await
}

/// 一個 issue 的內容與最近的留言（最多 30 則）。
#[tauri::command]
pub async fn github_issue(app: AppHandle, number: u64) -> Result<IssueDetail, String> {
    let token = require_token(&app)?;
    let (owner, name) = crate::git_files::workspace_github_repo(&app)?;
    crate::io::blocking_for(Duration::from_secs(60), move || {
        let what = &tr!("讀取 issue");
        let v = json(
            &api_get(
                &token,
                &format!("/repos/{owner}/{name}/issues/{number}"),
                what,
            )?,
            what,
        )?;
        let issue = issue_of(&v).ok_or_else(|| tr!("讀取 issue 失敗：這個編號是 Pull Request"))?;
        let comments = if issue.comments > 0 {
            json(
                &api_get(
                    &token,
                    &format!("/repos/{owner}/{name}/issues/{number}/comments?per_page=30"),
                    what,
                )?,
                what,
            )?
        } else {
            serde_json::Value::Null
        };
        Ok(IssueDetail {
            assignees: v
                .get("assignees")
                .and_then(|x| x.as_array())
                .map(|l| l.iter().map(login_of).collect())
                .unwrap_or_default(),
            body: v
                .get("body")
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .to_string(),
            comment_list: comments
                .as_array()
                .map(|l| {
                    l.iter()
                        .map(|c| IssueComment {
                            author: c.get("user").map(login_of).unwrap_or_default(),
                            created: c
                                .get("created_at")
                                .and_then(|x| x.as_str())
                                .map(str::to_string),
                            body: c
                                .get("body")
                                .and_then(|x| x.as_str())
                                .unwrap_or_default()
                                .to_string(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            issue,
        })
    })
    .await
}

/// 目前資料夾是不是連到 GitHub 的儲存庫（前端決定要不要顯示 Issues）。
#[tauri::command]
pub fn github_workspace_repo(app: AppHandle) -> Option<String> {
    crate::git_files::workspace_github_repo(&app)
        .ok()
        .map(|(o, n)| format!("{o}/{n}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_pull_requests_in_issue_lists() {
        let list: serde_json::Value = serde_json::from_str(
            r#"[{"number":3,"title":"錯字","state":"open","labels":[{"name":"文件"}],"user":{"login":"a"},"comments":2,"updated_at":"2026-10-22T00:00:00Z","html_url":"https://github.com/o/r/issues/3"},
               {"number":4,"title":"PR","pull_request":{},"html_url":"x"}]"#,
        )
        .unwrap();
        let issues: Vec<Issue> = list
            .as_array()
            .unwrap()
            .iter()
            .filter_map(issue_of)
            .collect();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].labels, ["文件"]);
        assert_eq!(issues[0].author, "a");
    }

    #[test]
    fn identity_uses_noreply_email() {
        let a = Account {
            login: "omni".into(),
            id: 42,
            name: None,
        };
        let id = identity_of(&a).unwrap();
        assert_eq!(id.name, "omni");
        assert_eq!(id.email, "42+omni@users.noreply.github.com");
        let b = Account {
            name: Some("小明".into()),
            ..a
        };
        assert_eq!(identity_of(&b).unwrap().name, "小明");
    }

    #[test]
    fn device_code_stays_on_the_native_side() {
        let v = serde_json::json!({
            "device_code": "secret-device",
            "user_code": "ABCD-1234",
            "verification_uri": "https://github.com/login/device",
            "interval": 7,
            "expires_in": 600
        });
        let (pending, code) = device_code_of(&v).unwrap();
        assert_eq!(pending.device_code, "secret-device");
        assert_eq!((pending.interval, pending.expires_in), (7, 600));
        // 給網頁的內容沒有 device_code。
        let page = serde_json::to_value(&code).unwrap();
        assert_eq!(
            page,
            serde_json::json!({
                "userCode": "ABCD-1234",
                "verificationUri": "https://github.com/login/device",
                "interval": 7,
                "expiresIn": 600
            })
        );
        assert!(!page.to_string().contains("secret-device"));
    }

    #[test]
    fn device_page_must_be_on_github() {
        for bad in [
            "http://github.com/login/device",
            "https://github.com.evil.test/login/device",
            "https://evil.test/https://github.com/",
            "javascript:alert(1)",
        ] {
            let v = serde_json::json!({ "device_code": "d", "user_code": "u", "verification_uri": bad });
            assert_eq!(
                device_code_of(&v).unwrap().1.verification_uri,
                DEVICE_PAGE,
                "{bad}"
            );
        }
        let v = serde_json::json!({ "user_code": "u" });
        assert!(device_code_of(&v).is_err());
    }

    #[test]
    fn public_repositories_are_confirmed() {
        let q = publish_question("wang", "產品筆記", "筆記", false, None).unwrap();
        assert_eq!(q.title, "公開到 GitHub");
        assert!(q.message.contains("「wang」"), "{}", q.message);
        assert!(q.message.contains("「產品筆記」"), "{}", q.message);
        assert!(q.message.contains("公開"), "{}", q.message);
        assert!(!q.message.contains("origin"), "{}", q.message);
        // 會換掉原本的 origin 時一起說明（不顯示網址裡的帳號密碼）。
        let q = publish_question(
            "wang",
            "notes",
            "筆記",
            false,
            Some("https://user:secret@ado.test/tfs/C/_git/notes"),
        )
        .unwrap();
        assert!(
            q.message.contains("https://ado.test/tfs/C/_git/notes"),
            "{}",
            q.message
        );
        assert!(!q.message.contains("secret"), "{}", q.message);
    }

    #[test]
    fn private_repositories_are_confirmed_only_when_origin_changes() {
        assert_eq!(publish_question("wang", "notes", "筆記", true, None), None);
        // 原本的 origin 已經是同一個儲存庫：不算換掉。
        assert_eq!(
            publish_question(
                "wang",
                "notes",
                "筆記",
                true,
                Some("https://github.com/Wang/Notes.git")
            ),
            None
        );
        let q = publish_question(
            "wang",
            "notes",
            "筆記",
            true,
            Some("https://github.com/lee/notes.git"),
        )
        .unwrap();
        assert_eq!(q.title, "上傳到 GitHub");
        assert!(
            q.message.contains("https://github.com/lee/notes"),
            "{}",
            q.message
        );
        assert!(q.message.contains("「wang」"), "{}", q.message);
        assert!(q.message.contains("私人"), "{}", q.message);
    }

    #[test]
    fn only_public_gists_and_pages_are_confirmed() {
        assert!(login_question("wang").message.contains("「wang」"));
        assert_eq!(gist_question("wang", "會議.md", false), None);
        let q = gist_question("wang", "會議.md", true).unwrap();
        assert!(q.message.contains("「wang」") && q.message.contains("「會議.md」"));
        let q = pages_question("wang", "contoso", "產品筆記");
        assert!(q.message.contains("「wang」"), "{}", q.message);
        assert!(q.message.contains("「contoso/產品筆記」"), "{}", q.message);
    }

    #[test]
    fn parses_repo_list() {
        let json = r#"[{"full_name":"a/筆記","name":"筆記","private":true,"description":null,"updated_at":"2026-10-22T00:00:00Z","clone_url":"https://github.com/a/x.git","owner":{}}]"#;
        let list: Vec<Repo> = serde_json::from_str(json).unwrap();
        assert_eq!(list[0].full_name, "a/筆記");
        assert!(list[0].private);
    }
}
