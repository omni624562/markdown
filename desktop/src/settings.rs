//! 設定檔讀寫（內容由前端驗證，這裡只負責存放）。

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("settings.json"))
        .map_err(|e| e.to_string())
}

/// 讀取設定檔；還沒有設定檔時回傳 `None`。
#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<Option<String>, String> {
    match fs::read_to_string(settings_path(&app)?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(tr!("無法讀取設定：{e}", e = e)),
    }
}

/// 設定檔裡的「啟用 AI 協作」。執行 AI 工具、啟動 MCP 伺服器前，原生端自己再檢查一次，
/// 不只靠網頁那一端（網頁萬一被注入程式碼，也不能自己偷偷開啟）。
pub fn ai_enabled(app: &AppHandle) -> bool {
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .is_some_and(|v| v["aiEnabled"] == true)
}

/// 設定檔裡的「在終端機執行指令」（沒有這一項時是預設的開啟）。AI 要求執行指令時，
/// 原生端自己再檢查一次，不只靠網頁那一端。
pub fn ai_terminal_enabled(app: &AppHandle) -> bool {
    ai_enabled(app)
        && settings_path(app)
            .ok()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .is_some_and(|v| v["aiTerminal"] != false)
}

/// 需要 AI 協作的功能先呼叫：沒有開啟時回傳錯誤。
pub fn require_ai(app: &AppHandle) -> Result<(), String> {
    if ai_enabled(app) {
        Ok(())
    } else {
        Err(tr!("請先在設定開啟「啟用 AI 協作」"))
    }
}

/// 儲存設定。從關閉改成「啟用 AI 協作」時，用系統的對話框再確認一次；
/// 使用者拒絕時存成關閉，並回傳 `false`（前端會把開關改回去）。
#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    window: tauri::WebviewWindow,
    json: String,
) -> Result<bool, String> {
    // 一次只存一份，確認對話框不會重複跳出。
    static SAVING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = SAVING.lock().await;
    let path = settings_path(&app)?;
    let mut accepted = true;
    let mut json = json;
    if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&json) {
        if value["aiEnabled"] == true && !ai_enabled(&app) {
            let answer = rfd::AsyncMessageDialog::new()
                .set_parent(&window)
                .set_level(rfd::MessageLevel::Warning)
                .set_title(tr!("啟用 AI 協作"))
                .set_description(tr!(
                    "啟用後，oMarker 可以執行 Claude Code、Codex 等 AI 工具，並讓它們讀取目前的文件。要啟用嗎？"
                ))
                .set_buttons(rfd::MessageButtons::YesNo)
                .show()
                .await;
            if answer != rfd::MessageDialogResult::Yes {
                accepted = false;
                value["aiEnabled"] = serde_json::Value::Bool(false);
                json = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
            }
        }
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| tr!("無法建立設定資料夾：{e}", e = e))?;
    }
    crate::files::write_atomic(&path, json.as_bytes())
        .map_err(|e| tr!("無法儲存設定：{e}", e = e))?;
    Ok(accepted)
}
