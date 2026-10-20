//! Markdown 編輯器桌面版。
//!
//! 介面直接沿用 `web/` 的網頁版（編譯時打包進執行檔），這裡只補上網頁做不到的事：
//! 原生的開檔／存檔對話框、從命令列（或「開啟檔案」）帶入檔案、更新視窗標題、
//! 安全存檔（先寫暫存檔再取代，並偵測檔案是否被別的程式改過）與設定檔讀寫。
//!
//! 安全考量：前端只能讀寫「使用者在對話框選過」或「從命令列帶入」的檔案，
//! 不提供任意路徑的檔案存取。

// 正式版不要跳出命令提示字元視窗。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewWindow};

/// 開啟檔案時記下的格式，存檔時照原樣寫回，避免 Windows 的 CRLF 或 BOM 被悄悄改掉。
#[derive(Clone, Copy, Default)]
struct FileFormat {
    crlf: bool,
    bom: bool,
}

/// 已知檔案的狀態：原本的格式，以及最後一次讀取或寫入時內容的雜湊。
#[derive(Clone, Copy, Default)]
struct FileState {
    format: FileFormat,
    /// 用來判斷存檔前檔案是否被別的程式改過。
    hash: Option<u64>,
}

/// 前端可以寫入的檔案（使用者選過或從命令列帶入的）及其狀態。
#[derive(Default)]
struct KnownFiles(Mutex<HashMap<PathBuf, FileState>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedFile {
    path: String,
    name: String,
    text: String,
    /// 檔案不是 UTF-8、改用 Big5 解讀時為 `"big5"`。
    encoding: &'static str,
}

/// 存檔結果。
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum SaveOutcome {
    Saved {
        path: String,
        name: String,
    },
    /// 檔案在開啟後被別的程式改過；附上磁碟上的目前內容，讓使用者比較或決定覆蓋。
    #[serde(rename_all = "camelCase")]
    Conflict {
        path: String,
        name: String,
        disk_text: String,
    },
    Cancelled,
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// 解讀檔案內容：優先當 UTF-8（可含 BOM），失敗時改用台灣常見的 Big5。
fn decode(bytes: &[u8]) -> (String, FileFormat, &'static str) {
    let (body, bom) = match bytes.strip_prefix(b"\xEF\xBB\xBF") {
        Some(rest) => (rest, true),
        None => (bytes, false),
    };
    let (text, encoding) = match std::str::from_utf8(body) {
        Ok(s) => (s.to_owned(), "utf-8"),
        Err(_) => {
            let (s, _, _) = encoding_rs::BIG5.decode(body);
            (s.into_owned(), "big5")
        }
    };
    let crlf = text.contains("\r\n");
    // 編輯器內部一律使用 \n，存檔時再依原格式轉回。
    let text = if crlf {
        text.replace("\r\n", "\n")
    } else {
        text
    };
    (text, FileFormat { crlf, bom }, encoding)
}

fn encode(text: &str, format: FileFormat) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + 3);
    if format.bom {
        out.extend_from_slice(b"\xEF\xBB\xBF");
    }
    if format.crlf {
        out.extend_from_slice(text.replace("\r\n", "\n").replace('\n', "\r\n").as_bytes());
    } else {
        out.extend_from_slice(text.as_bytes());
    }
    out
}

fn read_file(path: PathBuf, known: &KnownFiles) -> Result<OpenedFile, String> {
    let bytes = fs::read(&path).map_err(|e| format!("無法讀取「{}」：{e}", path.display()))?;
    let (text, format, encoding) = decode(&bytes);
    let opened = OpenedFile {
        path: path.to_string_lossy().into_owned(),
        name: display_name(&path),
        text,
        encoding,
    };
    known.0.lock().unwrap().insert(
        path,
        FileState {
            format,
            hash: Some(hash_bytes(&bytes)),
        },
    );
    Ok(opened)
}

/// 先寫到同一個資料夾的暫存檔、確實寫入磁碟後再取代原檔，
/// 避免寫到一半斷電或磁碟滿時留下殘缺的檔案。
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        display_name(path),
        std::process::id()
    ));
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
        // 有些情況無法取代（例如原檔正被其他程式以不允許刪除的方式開著），退回直接覆寫。
        return fs::write(path, bytes);
    }
    result
}

/// 寫入檔案並更新已知狀態，回傳寫入內容的雜湊。
fn write_file(path: &Path, text: &str, format: FileFormat) -> Result<u64, String> {
    let bytes = encode(text, format);
    write_atomic(path, &bytes).map_err(|e| format!("無法寫入「{}」：{e}", path.display()))?;
    Ok(hash_bytes(&bytes))
}

/// 磁碟上的檔案和最後一次讀寫時是否不同。檔案不存在時不算衝突（直接重新建立）。
fn changed_on_disk(stored: Option<u64>, disk: Option<&[u8]>) -> bool {
    matches!((stored, disk), (Some(h), Some(bytes)) if hash_bytes(bytes) != h)
}

fn saved(path: &Path) -> SaveOutcome {
    SaveOutcome::Saved {
        name: display_name(path),
        path: path.to_string_lossy().into_owned(),
    }
}

/// 跳出開檔對話框並讀取選到的檔案；使用者取消時回傳 `None`。
#[tauri::command]
async fn open_file(
    window: WebviewWindow,
    known: State<'_, KnownFiles>,
) -> Result<Option<OpenedFile>, String> {
    let picked = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title("開啟檔案")
        .add_filter(
            "Markdown、純文字、JSON",
            &["md", "markdown", "txt", "text", "log", "json"],
        )
        .add_filter("所有檔案", &["*"])
        .pick_file()
        .await;
    match picked {
        Some(handle) => read_file(handle.path().to_path_buf(), &known).map(Some),
        None => Ok(None),
    }
}

/// 啟動時從命令列帶入的檔案（例如把 .md 拖到 exe 上，或設定成預設開啟程式）。
#[tauri::command]
fn initial_file(known: State<'_, KnownFiles>) -> Result<Option<OpenedFile>, String> {
    let Some(arg) = std::env::args_os()
        .skip(1)
        .find(|a| !a.to_string_lossy().starts_with('-'))
    else {
        return Ok(None);
    };
    read_file(PathBuf::from(arg), &known).map(Some)
}

/// 儲存文字檔。`path` 是先前開啟或存過的檔案時直接覆寫；否則跳出另存新檔對話框。
///
/// 覆寫前會檢查檔案是否在開啟後被別的程式改過，有的話回傳 `Conflict`，
/// 除非 `force` 為 true（使用者已確認要覆蓋）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn save_file(
    window: WebviewWindow,
    known: State<'_, KnownFiles>,
    path: Option<String>,
    suggested_name: String,
    text: String,
    filter_name: String,
    extensions: Vec<String>,
    force: Option<bool>,
) -> Result<SaveOutcome, String> {
    if let Some(path) = path.map(PathBuf::from) {
        let state = known.0.lock().unwrap().get(&path).copied();
        if let Some(state) = state {
            if !force.unwrap_or(false) {
                let disk = fs::read(&path).ok();
                if changed_on_disk(state.hash, disk.as_deref()) {
                    let (disk_text, _, _) = decode(&disk.unwrap_or_default());
                    return Ok(SaveOutcome::Conflict {
                        name: display_name(&path),
                        path: path.to_string_lossy().into_owned(),
                        disk_text,
                    });
                }
            }
            let hash = write_file(&path, &text, state.format)?;
            known.0.lock().unwrap().insert(
                path.clone(),
                FileState {
                    hash: Some(hash),
                    ..state
                },
            );
            return Ok(saved(&path));
        }
    }

    let exts: Vec<&str> = extensions
        .iter()
        .map(|e| e.trim_start_matches('.'))
        .collect();
    let picked = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title("另存新檔")
        .set_file_name(&suggested_name)
        .add_filter(&filter_name, &exts)
        .save_file()
        .await;
    let Some(handle) = picked else {
        return Ok(SaveOutcome::Cancelled);
    };
    let path = handle.path().to_path_buf();
    // 覆寫既有檔案時沿用它原本的換行格式（對話框已經問過使用者要不要取代）。
    let format = known
        .0
        .lock()
        .unwrap()
        .get(&path)
        .map(|s| s.format)
        .unwrap_or_default();
    let hash = write_file(&path, &text, format)?;
    known.0.lock().unwrap().insert(
        path.clone(),
        FileState {
            format,
            hash: Some(hash),
        },
    );
    Ok(saved(&path))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("settings.json"))
        .map_err(|e| e.to_string())
}

/// 讀取設定檔；還沒有設定檔時回傳 `None`。
#[tauri::command]
fn load_settings(app: AppHandle) -> Result<Option<String>, String> {
    match fs::read_to_string(settings_path(&app)?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("無法讀取設定：{e}")),
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, json: String) -> Result<(), String> {
    let path = settings_path(&app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("無法建立設定資料夾：{e}"))?;
    }
    write_atomic(&path, json.as_bytes()).map_err(|e| format!("無法儲存設定：{e}"))
}

#[tauri::command]
fn set_title(window: WebviewWindow, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(KnownFiles::default())
        .invoke_handler(tauri::generate_handler![
            open_file,
            initial_file,
            save_file,
            set_title,
            load_settings,
            save_settings
        ])
        .run(tauri::generate_context!())
        .expect("無法啟動應用程式");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_crlf_and_bom_round_trip() {
        let original = b"\xEF\xBB\xBF# \xE6\xA8\x99\xE9\xA1\x8C\r\n\r\nabc\r\n";
        let (text, format, enc) = decode(original);
        assert_eq!(text, "# 標題\n\nabc\n");
        assert_eq!(enc, "utf-8");
        assert_eq!(encode(&text, format), original);
    }

    #[test]
    fn lf_files_stay_lf() {
        let (text, format, _) = decode(b"a\nb\n");
        assert_eq!(encode(&text, format), b"a\nb\n");
    }

    #[test]
    fn atomic_write_replaces_and_cleans_up() {
        let dir = std::env::temp_dir().join(format!("md-editor-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("筆記.md");
        fs::write(&file, "舊內容").unwrap();
        write_atomic(&file, "新內容".as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "新內容");
        let leftovers: Vec<_> = fs::read_dir(&dir).unwrap().collect();
        assert_eq!(leftovers.len(), 1, "暫存檔應該被移走");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn detects_external_changes() {
        let h = hash_bytes(b"original");
        assert!(!changed_on_disk(Some(h), Some(b"original")));
        assert!(changed_on_disk(Some(h), Some(b"edited elsewhere")));
        // 檔案被刪除，或是第一次存檔：不算衝突。
        assert!(!changed_on_disk(Some(h), None));
        assert!(!changed_on_disk(None, Some(b"anything")));
    }

    #[test]
    fn falls_back_to_big5() {
        // 「中文」的 Big5 編碼
        let (text, _, enc) = decode(b"\xA4\xA4\xA4\xE5");
        assert_eq!(text, "中文");
        assert_eq!(enc, "big5");
    }
}
