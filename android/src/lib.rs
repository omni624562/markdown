//! oMarker 的 Android 版：把網頁版的畫面放進 Android 的 WebView，原生端只補網頁做不到的事——
//! 用系統的檔案選擇器開啟、另存新檔，並照選到的位置讀寫（存回原檔）。
//! 桌面版的專案資料夾、Git、終端機等功能這裡沒有。
//!
//! 檔案的讀寫在 Kotlin 那邊（`gen/android/app/src/main/java/.../FilesPlugin.kt`）：Android 的檔案是
//! `content://` 開頭的位置，只能透過系統的 ContentResolver 存取。這裡的指令只是把前端的要求轉過去。

// ---- Claude API 助理：直接編譯桌面版的程式（desktop/src/assistant.rs），平台相關的部分在 platform.rs ----

#[macro_use]
#[path = "../../desktop/src/i18n.rs"]
mod i18n;
#[path = "../../desktop/src/assistant.rs"]
mod assistant;
#[path = "../../desktop/src/io.rs"]
#[allow(dead_code)]
mod io;
#[path = "../../desktop/src/locales/mod.rs"]
mod locales;
mod platform;
pub(crate) use platform::{files, git, secrets, settings, update, workspace};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin};
use tauri::{Manager, State, Wry};

/// Kotlin 那邊的檔案外掛；不是 Android（在桌面上開發時）沒有。
struct Files(Option<PluginHandle<Wry>>);

fn files_plugin() -> TauriPlugin<Wry> {
    PluginBuilder::new("files")
        // 讓前端知道這是 Android 版（見 web/src/platform.ts）：不靠瀏覽器的識別字串猜。
        .js_init_script("window.__OMARKER_ANDROID__ = true;".to_string())
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            let handle =
                Some(_api.register_android_plugin("io.github.omni624562.omarker", "FilesPlugin")?);
            #[cfg(not(target_os = "android"))]
            let handle = None;
            app.manage(Files(handle));
            Ok(())
        })
        .build()
}

/// 呼叫 Kotlin 的指令。選檔案時要等使用者，所以放到背景執行緒，不佔住處理其他指令的執行緒。
async fn call<T: DeserializeOwned + Send + 'static>(
    files: &Files,
    command: &'static str,
    payload: impl Serialize + Send + 'static,
) -> Result<T, String> {
    let Some(handle) = files.0.clone() else {
        return Err("只有 Android 版能用系統的檔案選擇器".into());
    };
    #[cfg(mobile)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            handle
                .run_mobile_plugin::<T>(command, payload)
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    // 在桌面上編譯（跑測試、開發）時沒有 Kotlin 那一側。
    #[cfg(not(mobile))]
    {
        let _ = (handle, command, payload);
        Err("只有 Android 版能用系統的檔案選擇器".into())
    }
}

/// 選到的檔案；使用者取消時 `uri` 是空的。
#[derive(Serialize, Deserialize)]
struct Picked {
    uri: Option<String>,
    #[serde(default)]
    name: String,
}

#[derive(Serialize, Deserialize)]
struct FileData {
    /// 內容（Base64）。
    data: String,
    #[serde(default)]
    name: String,
    /// 最後修改的時間（毫秒）；來源沒有提供時是 0。
    #[serde(default)]
    modified: i64,
}

#[derive(Serialize, Deserialize)]
struct Written {
    #[serde(default)]
    modified: i64,
}

/// 位置只接受系統檔案選擇器給的那一種（`content://`）。
fn check_uri(uri: &str) -> Result<(), String> {
    if uri.starts_with("content://") && uri.len() <= 4096 {
        Ok(())
    } else {
        Err("檔案的位置不正確".into())
    }
}

#[tauri::command]
async fn mobile_pick_file(files: State<'_, Files>) -> Result<Picked, String> {
    call(&files, "pickFile", ()).await
}

#[tauri::command]
async fn mobile_create_file(
    files: State<'_, Files>,
    name: String,
    mime: String,
) -> Result<Picked, String> {
    call(
        &files,
        "createFile",
        serde_json::json!({ "name": name, "mime": mime }),
    )
    .await
}

#[tauri::command]
async fn mobile_read_file(files: State<'_, Files>, uri: String) -> Result<FileData, String> {
    check_uri(&uri)?;
    call(&files, "readFile", serde_json::json!({ "uri": uri })).await
}

#[tauri::command]
async fn mobile_write_file(
    files: State<'_, Files>,
    uri: String,
    data: String,
) -> Result<Written, String> {
    check_uri(&uri)?;
    call(
        &files,
        "writeFile",
        serde_json::json!({ "uri": uri, "data": data }),
    )
    .await
}

/// 前端改了設定時交一份過來（Android 版的設定存在網頁的儲存空間，原生端讀不到）。
#[tauri::command]
fn save_settings(json: String) -> Result<bool, String> {
    settings::save(&json)?;
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(files_plugin())
        .manage(assistant::AssistantRuns::default())
        .setup(|app| {
            if let Ok(dir) = app.path().app_data_dir() {
                platform::set_data_dir(dir);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mobile_pick_file,
            mobile_create_file,
            mobile_read_file,
            mobile_write_file,
            save_settings,
            i18n::set_language,
            assistant::assistant_key_status,
            assistant::assistant_key_set,
            assistant::assistant_key_forget,
            assistant::assistant_usage,
            assistant::assistant_usage_history,
            assistant::assistant_send,
            assistant::assistant_count,
            assistant::assistant_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("啟動 oMarker 失敗");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_assistant_works_without_a_project_folder() {
        // Android 版沒有專案資料夾：開了助理就能送，關著不行。
        let on = serde_json::json!({ "claudeApiEnabled": true });
        assert!(assistant::check(&on, None, None).is_ok());
        assert!(assistant::check(&serde_json::json!({}), None, None).is_err());
    }

    #[test]
    fn only_content_uris_are_accepted() {
        assert!(
            check_uri("content://com.android.providers.downloads.documents/document/42").is_ok()
        );
        assert!(check_uri("file:///sdcard/a.md").is_err());
        assert!(check_uri("/sdcard/a.md").is_err());
        assert!(check_uri("").is_err());
    }

    #[test]
    fn a_cancelled_pick_has_no_uri() {
        let p: Picked = serde_json::from_str(r#"{"uri":null}"#).unwrap();
        assert!(p.uri.is_none());
        let p: Picked =
            serde_json::from_str(r#"{"uri":"content://x/1","name":"筆記.md"}"#).unwrap();
        assert_eq!(p.name, "筆記.md");
    }
}
