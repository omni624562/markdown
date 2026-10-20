//! Markdown 編輯器桌面版。
//!
//! 介面直接沿用 `web/` 的網頁版（編譯時打包進執行檔），這裡只補上網頁做不到的事：
//! 原生的開檔／存檔對話框、從命令列（或「開啟檔案」）帶入檔案、更新視窗標題。
//!
//! 安全考量：前端只能讀寫「使用者在對話框選過」或「從命令列帶入」的檔案，
//! 不提供任意路徑的檔案存取。

// 正式版不要跳出命令提示字元視窗。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{State, WebviewWindow};

/// 開啟檔案時記下的格式，存檔時照原樣寫回，避免 Windows 的 CRLF 或 BOM 被悄悄改掉。
#[derive(Clone, Copy, Default)]
struct FileFormat {
    crlf: bool,
    bom: bool,
}

/// 前端可以寫入的檔案（使用者選過或從命令列帶入的）及其格式。
#[derive(Default)]
struct KnownFiles(Mutex<HashMap<PathBuf, FileFormat>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedFile {
    path: String,
    name: String,
    text: String,
    /// 檔案不是 UTF-8、改用 Big5 解讀時為 `"big5"`。
    encoding: &'static str,
}

#[derive(Serialize)]
struct SavedFile {
    path: String,
    name: String,
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
    known.0.lock().unwrap().insert(path, format);
    Ok(opened)
}

fn write_file(path: &Path, text: &str, format: FileFormat) -> Result<(), String> {
    fs::write(path, encode(text, format))
        .map_err(|e| format!("無法寫入「{}」：{e}", path.display()))
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
/// 使用者取消時回傳 `None`。
#[tauri::command]
async fn save_file(
    window: WebviewWindow,
    known: State<'_, KnownFiles>,
    path: Option<String>,
    suggested_name: String,
    text: String,
    filter_name: String,
    extensions: Vec<String>,
) -> Result<Option<SavedFile>, String> {
    if let Some(path) = path.map(PathBuf::from) {
        let format = known.0.lock().unwrap().get(&path).copied();
        if let Some(format) = format {
            write_file(&path, &text, format)?;
            return Ok(Some(SavedFile {
                name: display_name(&path),
                path: path.to_string_lossy().into_owned(),
            }));
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
        return Ok(None);
    };
    let path = handle.path().to_path_buf();
    // 覆寫既有檔案時沿用它原本的換行格式。
    let format = known
        .0
        .lock()
        .unwrap()
        .get(&path)
        .copied()
        .unwrap_or_default();
    write_file(&path, &text, format)?;
    known.0.lock().unwrap().insert(path.clone(), format);
    Ok(Some(SavedFile {
        name: display_name(&path),
        path: path.to_string_lossy().into_owned(),
    }))
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
            set_title
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
    fn falls_back_to_big5() {
        // 「中文」的 Big5 編碼
        let (text, _, enc) = decode(b"\xA4\xA4\xA4\xE5");
        assert_eq!(text, "中文");
        assert_eq!(enc, "big5");
    }
}
