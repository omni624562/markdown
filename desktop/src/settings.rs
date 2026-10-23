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

#[tauri::command]
pub fn save_settings(app: AppHandle, json: String) -> Result<(), String> {
    let path = settings_path(&app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| tr!("無法建立設定資料夾：{e}", e = e))?;
    }
    crate::files::write_atomic(&path, json.as_bytes()).map_err(|e| tr!("無法儲存設定：{e}", e = e))
}
