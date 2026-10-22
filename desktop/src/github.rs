//! GitHub 帳號：用「裝置碼」登入（在瀏覽器輸入一組代碼授權，程式裡不需要輸入密碼），
//! 列出儲存庫、下載（clone）、把資料夾上傳成新的儲存庫。
//! 權杖存在 Windows 認證管理員；帳號名稱存在設定資料夾（不含權杖）。

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::files::path_string;
use crate::git::{Auth, Identity};
use crate::workspace::{FolderInfo, Workspace};

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
    let mut cached = TOKEN.lock().ok()?;
    if cached.is_none() {
        *cached = crate::secrets::get(SERVICE, "token");
    }
    // 權杖還在但帳號資料不見了（例如手動刪了設定檔）：當成沒有登入。
    cached.clone().filter(|_| account(app).is_some())
}

fn account(app: &AppHandle) -> Option<Account> {
    let text = fs::read_to_string(account_file(app)?).ok()?;
    serde_json::from_str(&text).ok()
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
            .map_err(|e| format!("{what}失敗：{e}")),
        Err(ureq::Error::StatusCode(401)) => Err("GitHub 登入已過期，請重新登入".into()),
        Err(ureq::Error::StatusCode(422)) => Err(format!(
            "{what}失敗：名稱已經被使用，或不符合 GitHub 的規定"
        )),
        Err(ureq::Error::StatusCode(code)) => Err(format!("{what}失敗：GitHub 回應 {code}")),
        Err(e) => Err(format!("{what}失敗：無法連線到 GitHub（{e}）")),
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
    serde_json::from_str(&text).map_err(|e| format!("{what}失敗：{e}"))
}

// ---- 登入 -------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    device_code: String,
    user_code: String,
    verification_uri: String,
    interval: u64,
    expires_in: u64,
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
            &format!("client_id={id}&scope=repo"),
            "登入",
        )
    })
    .await?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let n = |k: &str, d: u64| v.get(k).and_then(|x| x.as_u64()).unwrap_or(d);
    let code = DeviceCode {
        device_code: s("device_code").ok_or("登入失敗：GitHub 沒有回傳代碼")?,
        user_code: s("user_code").ok_or("登入失敗：GitHub 沒有回傳代碼")?,
        verification_uri: s("verification_uri")
            .unwrap_or_else(|| "https://github.com/login/device".into()),
        interval: n("interval", 5),
        expires_in: n("expires_in", 900),
    };
    use tauri_plugin_opener::OpenerExt;
    if code.verification_uri.starts_with("https://github.com/") {
        let _ = app.opener().open_url(&code.verification_uri, None::<&str>);
    }
    Ok(code)
}

/// 等使用者在瀏覽器授權（依 GitHub 指定的間隔詢問），成功後記住權杖與帳號。
#[tauri::command]
pub async fn github_login_wait(
    app: AppHandle,
    device_code: String,
    interval: u64,
    expires_in: u64,
) -> Result<Account, String> {
    let id = CLIENT_ID;
    CANCEL.store(false, Ordering::SeqCst);
    let limit = Duration::from_secs(expires_in.clamp(60, 1800));
    let token = crate::io::blocking_for(limit + Duration::from_secs(30), move || {
        let start = Instant::now();
        let mut wait = interval.clamp(1, 60);
        loop {
            // 每秒檢查一次有沒有按「取消」。
            for _ in 0..wait {
                if CANCEL.load(Ordering::SeqCst) {
                    return Err("已取消登入".to_string());
                }
                std::thread::sleep(Duration::from_secs(1));
            }
            if start.elapsed() > limit {
                return Err("代碼已過期，請重新登入".into());
            }
            let v = form(
                "https://github.com/login/oauth/access_token",
                &format!(
                    "client_id={id}&device_code={device_code}&grant_type=urn:ietf:params:oauth:grant-type:device_code"
                ),
                "登入",
            )?;
            if let Some(t) = v.get("access_token").and_then(|x| x.as_str()) {
                return Ok(t.to_string());
            }
            match v.get("error").and_then(|x| x.as_str()) {
                Some("authorization_pending") => {}
                Some("slow_down") => wait += 5,
                Some("expired_token") => return Err("代碼已過期，請重新登入".into()),
                Some("access_denied") => return Err("你在 GitHub 拒絕了授權".into()),
                Some(other) => return Err(format!("登入失敗：{other}")),
                None => return Err("登入失敗：GitHub 的回應不正確".into()),
            }
        }
    })
    .await?;
    let t = token.clone();
    let text = crate::io::blocking_for(Duration::from_secs(30), move || {
        api_get(&t, "/user", "讀取帳號")
    })
    .await?;
    let account: Account = serde_json::from_str(&text).map_err(|e| format!("讀取帳號失敗：{e}"))?;
    let path = account_file(&app).ok_or("找不到設定資料夾")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("無法建立設定資料夾：{e}"))?;
    }
    let json = serde_json::to_string_pretty(&account).unwrap_or_default();
    crate::files::write_atomic(&path, json.as_bytes()).map_err(|e| format!("無法儲存：{e}"))?;
    crate::secrets::set(SERVICE, "token", &token);
    if let Ok(mut t) = TOKEN.lock() {
        *t = Some(token);
    }
    Ok(account)
}

#[tauri::command]
pub fn github_login_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn github_logout(app: AppHandle) {
    crate::secrets::forget(SERVICE, "token");
    if let Ok(mut t) = TOKEN.lock() {
        *t = None;
    }
    if let Some(p) = account_file(&app) {
        let _ = fs::remove_file(p);
    }
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
    token(app).ok_or_else(|| "請先用 GitHub 登入".to_string())
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
                "讀取儲存庫清單",
            )?;
            let list: Vec<Repo> =
                serde_json::from_str(&text).map_err(|e| format!("讀取儲存庫清單失敗：{e}"))?;
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
    window: WebviewWindow,
    full_name: String,
) -> Result<Option<FolderInfo>, String> {
    let auth = Auth {
        github_token: Some(require_token(&app)?),
        ..Auth::default()
    };
    let name = full_name
        .rsplit('/')
        .next()
        .filter(|n| !n.is_empty() && !n.starts_with('.') && !n.contains(['\\', ':']))
        .ok_or("儲存庫名稱不正確")?
        .to_string();
    if full_name.split('/').count() != 2 {
        return Err("儲存庫名稱不正確".into());
    }
    let Some(dest) = pick_clone_dest(&app, &window, &name).await? else {
        return Ok(None);
    };
    let url = format!("https://github.com/{full_name}.git");
    let target = dest.clone();
    crate::io::blocking_for(crate::git::NETWORK_TIMEOUT, move || {
        crate::git::clone_to(&url, &target, &auth)
    })
    .await?;
    Ok(Some(crate::workspace::open_folder_from_cli(&app, dest)))
}

/// 選擇下載到哪個資料夾：回傳「選的資料夾／名稱」；使用者取消時回傳 None。
pub(crate) async fn pick_clone_dest(
    app: &AppHandle,
    window: &WebviewWindow,
    name: &str,
) -> Result<Option<PathBuf>, String> {
    if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\', ':']) {
        return Err("儲存庫名稱不正確".into());
    }
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_parent(window)
        .set_title(format!("選擇要把「{name}」放在哪個資料夾"));
    if let Ok(docs) = app.path().document_dir() {
        dialog = dialog.set_directory(docs);
    }
    let Some(parent) = dialog.pick_folder().await else {
        return Ok(None);
    };
    let dest = parent.path().join(name);
    if dest.exists()
        && fs::read_dir(&dest)
            .map(|mut d| d.next().is_some())
            .unwrap_or(true)
    {
        return Err(format!(
            "「{}」已經存在而且不是空的，請換一個位置",
            path_string(&dest)
        ));
    }
    Ok(Some(dest))
}

#[derive(Deserialize)]
struct Created {
    clone_url: String,
    html_url: String,
}

/// 把目前開啟的資料夾上傳成新的 GitHub 儲存庫，回傳儲存庫的網頁網址。
#[tauri::command]
pub async fn github_publish(
    app: AppHandle,
    workspace: State<'_, Workspace>,
    name: String,
    private: bool,
) -> Result<String, String> {
    let token = require_token(&app)?;
    let dir = workspace.root().ok_or("還沒有開啟資料夾")?;
    let who = identity(&app);
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("請輸入儲存庫名稱".into());
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
            "建立儲存庫",
        )?;
        let created: Created =
            serde_json::from_str(&text).map_err(|e| format!("建立儲存庫失敗：{e}"))?;
        let auth = Auth {
            github_token: Some(token),
            ..Auth::default()
        };
        crate::git::publish_at(&dir, &created.clone_url, &auth, who.as_ref())?;
        Ok(created.html_url)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn parses_repo_list() {
        let json = r#"[{"full_name":"a/筆記","name":"筆記","private":true,"description":null,"updated_at":"2026-10-22T00:00:00Z","clone_url":"https://github.com/a/x.git","owner":{}}]"#;
        let list: Vec<Repo> = serde_json::from_str(json).unwrap();
        assert_eq!(list[0].full_name, "a/筆記");
        assert!(list[0].private);
    }
}
