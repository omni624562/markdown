//! 單一檔案的讀寫：編碼判斷、保留換行格式、安全存檔與衝突偵測。

use std::collections::HashMap;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::trust::Trust;

/// 開啟檔案時記下的格式，存檔時照原樣寫回，避免 Windows 的 CRLF 或 BOM 被悄悄改掉。
#[derive(Clone, Copy, Default)]
pub struct FileFormat {
    crlf: bool,
    bom: bool,
}

/// 已知檔案的狀態：原本的格式，以及最後一次和編輯器同步時內容的雜湊。
#[derive(Clone, Copy, Default)]
pub struct FileState {
    format: FileFormat,
    /// 用來判斷檔案是否被別的程式改過。
    pub hash: Option<u64>,
}

/// 前端可以寫入的檔案（使用者選過、從命令列帶入或在工作區中開啟的）及其狀態。
#[derive(Default)]
pub struct KnownFiles(pub Mutex<HashMap<PathBuf, FileState>>);

impl KnownFiles {
    pub fn contains(&self, path: &Path) -> bool {
        self.0.lock().unwrap().contains_key(path)
    }

    pub fn stored_hash(&self, path: &Path) -> Option<u64> {
        self.0.lock().unwrap().get(path).and_then(|s| s.hash)
    }

    /// 檔案被改名或搬移時，沿用原本的狀態。
    pub fn rename(&self, from: &Path, to: &Path) {
        let mut map = self.0.lock().unwrap();
        let moved: Vec<(PathBuf, FileState)> = map
            .iter()
            .filter(|(p, _)| p.starts_with(from))
            .map(|(p, s)| (p.clone(), *s))
            .collect();
        for (old, state) in moved {
            map.remove(&old);
            let suffix = old.strip_prefix(from).unwrap_or(Path::new(""));
            map.insert(to.join(suffix), state);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub path: String,
    pub name: String,
    pub text: String,
    /// 檔案不是 UTF-8、改用 Big5 解讀時為 `"big5"`。
    pub encoding: &'static str,
}

impl OpenedFile {
    pub fn new(path: String, name: String, text: String, encoding: &'static str) -> Self {
        OpenedFile {
            path,
            name,
            text,
            encoding,
        }
    }
}

impl SaveOutcome {
    pub fn saved(path: String, name: String) -> Self {
        SaveOutcome::Saved { path, name }
    }

    pub fn conflict(path: String, name: String, disk_text: String) -> Self {
        SaveOutcome::Conflict {
            path,
            name,
            disk_text,
        }
    }
}

/// 存檔結果。
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SaveOutcome {
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

pub fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

pub fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

pub fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// 解讀檔案內容：優先當 UTF-8（可含 BOM），失敗時改用台灣常見的 Big5。
pub fn decode(bytes: &[u8]) -> (String, FileFormat, &'static str) {
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

pub fn encode(text: &str, format: FileFormat) -> Vec<u8> {
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

/// 讀取檔案、登記為已知檔案，並允許預覽顯示同資料夾的圖片。
pub fn read_file(app: &AppHandle, path: PathBuf, known: &KnownFiles) -> Result<OpenedFile, String> {
    let bytes = fs::read(&path)
        .map_err(|e| crate::io::describe(&e, &format!("無法讀取「{}」", display_name(&path))))?;
    let (text, format, encoding) = decode(&bytes);
    known.0.lock().unwrap().insert(
        path.clone(),
        FileState {
            format,
            hash: Some(hash_bytes(&bytes)),
        },
    );
    crate::track_file(app, &path);
    Ok(OpenedFile {
        path: path_string(&path),
        name: display_name(&path),
        text,
        encoding,
    })
}

/// 先寫到同一個資料夾的暫存檔、確實寫入磁碟後再取代原檔，
/// 避免寫到一半斷電或磁碟滿時留下殘缺的檔案。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
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

/// 寫入檔案，回傳寫入內容的雜湊。
fn write_file(path: &Path, text: &str, format: FileFormat) -> Result<u64, String> {
    let bytes = encode(text, format);
    write_atomic(path, &bytes)
        .map_err(|e| crate::io::describe(&e, &format!("無法寫入「{}」", display_name(path))))?;
    Ok(hash_bytes(&bytes))
}

/// 磁碟上的檔案和最後一次讀寫時是否不同。檔案不存在時不算衝突（直接重新建立）。
pub fn changed_on_disk(stored: Option<u64>, disk: Option<&[u8]>) -> bool {
    matches!((stored, disk), (Some(h), Some(bytes)) if hash_bytes(bytes) != h)
}

fn saved(path: &Path) -> SaveOutcome {
    SaveOutcome::Saved {
        name: display_name(path),
        path: path_string(path),
    }
}

/// 跳出開檔對話框並讀取選到的檔案；使用者取消時回傳 `None`。
#[tauri::command]
pub async fn open_file(
    app: AppHandle,
    window: WebviewWindow,
    trust: State<'_, Trust>,
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
    let Some(handle) = picked else {
        return Ok(None);
    };
    let path = handle.path().to_path_buf();
    let opened = read_in_background(&app, path.clone()).await?;
    trust.add_file(&app, &path);
    Ok(Some(opened))
}

/// 重新開啟先前開過的檔案（還原分頁、最近開啟）。只允許信任清單裡的路徑。
#[tauri::command]
pub async fn reopen_file(
    app: AppHandle,
    path: String,
    known: State<'_, KnownFiles>,
    trust: State<'_, Trust>,
) -> Result<OpenedFile, String> {
    let path = PathBuf::from(path);
    let allowed = known.contains(&path) || trust.allows(&path);
    let app2 = app.clone();
    let p = path.clone();
    let opened = crate::io::blocking(move || {
        // 位於工作區內的判斷需要讀取磁碟（解析實際路徑），也放在背景執行。
        if !allowed && !app2.state::<crate::workspace::Workspace>().contains(&p) {
            return Err("這個檔案不在最近開啟的清單中，請重新從「開啟檔案」選取。".into());
        }
        read_file(&app2, p, &app2.state::<KnownFiles>())
    })
    .await?;
    trust.add_file(&app, &path);
    Ok(opened)
}

/// 在背景執行緒讀取檔案（網路磁碟斷線時不會卡住介面）。
pub async fn read_in_background(app: &AppHandle, path: PathBuf) -> Result<OpenedFile, String> {
    let app = app.clone();
    crate::io::blocking(move || read_file(&app, path, &app.state::<KnownFiles>())).await
}

/// 儲存文字檔。`path` 是先前開啟或存過的檔案時直接覆寫；否則跳出另存新檔對話框。
///
/// 覆寫前會檢查檔案是否在開啟後被別的程式改過，有的話回傳 `Conflict`，
/// 除非 `force` 為 true（使用者已確認要覆蓋）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn save_file(
    app: AppHandle,
    window: WebviewWindow,
    known: State<'_, KnownFiles>,
    trust: State<'_, Trust>,
    path: Option<String>,
    suggested_name: String,
    text: String,
    filter_name: String,
    extensions: Vec<String>,
    force: Option<bool>,
) -> Result<SaveOutcome, String> {
    if let Some(path) = path.map(PathBuf::from) {
        if known.contains(&path) {
            let app = app.clone();
            let force = force.unwrap_or(false);
            return crate::io::blocking(move || overwrite(&app, &path, &text, force)).await;
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
    let app2 = app.clone();
    let p = path.clone();
    crate::io::blocking(move || {
        let disk = fs::read(&p).ok();
        let hash = write_file(&p, &text, format)?;
        crate::history::on_save(&app2, &p, disk.as_deref(), &text);
        app2.state::<KnownFiles>().0.lock().unwrap().insert(
            p.clone(),
            FileState {
                format,
                hash: Some(hash),
            },
        );
        crate::track_file(&app2, &p);
        Ok(())
    })
    .await?;
    trust.add_file(&app, &path);
    Ok(saved(&path))
}

/// 覆寫已開啟過的檔案。磁碟上的內容在開啟後被改過時回傳 `Conflict`（除非 `force`）。
fn overwrite(app: &AppHandle, path: &Path, text: &str, force: bool) -> Result<SaveOutcome, String> {
    let known = app.state::<KnownFiles>();
    let state = known
        .0
        .lock()
        .unwrap()
        .get(path)
        .copied()
        .unwrap_or_default();
    let disk = fs::read(path).ok();
    if !force && changed_on_disk(state.hash, disk.as_deref()) {
        let (disk_text, _, _) = decode(disk.as_deref().unwrap_or_default());
        return Ok(SaveOutcome::Conflict {
            name: display_name(path),
            path: path_string(path),
            disk_text,
        });
    }
    let hash = write_file(path, text, state.format)?;
    crate::history::on_save(app, path, disk.as_deref(), text);
    known.0.lock().unwrap().insert(
        path.to_path_buf(),
        FileState {
            hash: Some(hash),
            ..state
        },
    );
    Ok(saved(path))
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
    fn rename_moves_known_state_including_children() {
        let known = KnownFiles::default();
        known.0.lock().unwrap().insert(
            PathBuf::from("/w/舊資料夾/a.md"),
            FileState {
                hash: Some(1),
                ..Default::default()
            },
        );
        known.rename(Path::new("/w/舊資料夾"), Path::new("/w/新資料夾"));
        assert_eq!(known.stored_hash(Path::new("/w/新資料夾/a.md")), Some(1));
        assert!(!known.contains(Path::new("/w/舊資料夾/a.md")));
    }
}
