//! 資料夾文件索引：解析工作區中所有 Markdown 文件的待辦、標籤與連結，給待辦總覽、標籤與反向連結使用。
//!
//! 只傳解析結果給前端，不傳整份內容（大資料夾可以省下幾十 MB 的傳輸與記憶體）；
//! 前端需要內容時（勾選待辦、改名後更新連結）再用 `read_docs` 讀那幾份。
//! 只重讀修改時間變了的檔案，網路磁碟上的資料夾也不會每次都整個重讀。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use chrono::Datelike;
use md_text::{parse_doc, DocInfo};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::files::{
    decode, display_name, encode, hash_bytes, path_string, write_atomic, KnownFiles,
};
use crate::workspace::{rel_path, resolve_inside, walker, Workspace};

/// 最多讀幾個檔案、單一檔案最大多少（太大的通常不是筆記）。
const MAX_DOCS: usize = 5_000;
const MAX_DOC_BYTES: u64 = 2 * 1024 * 1024;
/// 全部加起來最多讀多少。
const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocText {
    pub path: String,
    pub rel: String,
    /// 修改時間（毫秒）。
    pub mtime: u64,
    /// 解析結果；修改時間和 `known` 裡的一樣時省略（前端沿用上次的結果）。
    pub info: Option<DocInfo>,
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "md" | "markdown"))
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 列出 `root` 中的 Markdown 文件（遵守 .gitignore），只讀取修改時間和 `known` 不同的檔案。
pub fn scan(root: &Path, known: &HashMap<String, u64>) -> Vec<DocText> {
    let year = chrono::Local::now().year();
    let mut total = 0u64;
    walker(root)
        .build()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()) && is_markdown(e.path()))
        .take(MAX_DOCS)
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            if meta.len() > MAX_DOC_BYTES || total + meta.len() > MAX_TOTAL_BYTES {
                return None;
            }
            total += meta.len();
            let path = path_string(e.path());
            let mtime = mtime_ms(&meta);
            let info = if known.get(&path) == Some(&mtime) {
                None
            } else {
                Some(parse_doc(&decode(&fs::read(e.path()).ok()?).0, year))
            };
            Some(DocText {
                rel: rel_path(root, e.path()),
                path,
                mtime,
                info,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn scan_docs(
    known: HashMap<String, u64>,
    workspace: State<'_, Workspace>,
) -> Result<Vec<DocText>, String> {
    let root = workspace.require_root()?;
    crate::io::blocking_for(std::time::Duration::from_secs(120), move || {
        Ok(scan(&root, &known))
    })
    .await
}

/// 讀取幾份文件的內容（勾選待辦、改名後更新連結、反向連結的摘要）。讀不到的是 `None`。
#[tauri::command]
pub async fn read_docs(
    paths: Vec<String>,
    workspace: State<'_, Workspace>,
) -> Result<Vec<Option<String>>, String> {
    let root = workspace.require_root()?;
    crate::io::blocking(move || {
        Ok(paths
            .iter()
            .map(|p| {
                let path = resolve_inside(&root, Path::new(p)).ok()?;
                if fs::metadata(&path).ok()?.len() > MAX_DOC_BYTES {
                    return None;
                }
                Some(decode(&fs::read(&path).ok()?).0)
            })
            .collect())
    })
    .await
}

/// 改寫一份沒有開啟的文件（例如在待辦總覽勾選、檔案改名後更新連結）。
/// 磁碟上的內容和 `expected` 不同時不寫入，避免蓋掉剛被其他程式改過的內容。
/// 保留原本的換行與 BOM；改之前的內容記到版本記錄。
pub fn update(path: &Path, expected: &str, text: &str) -> Result<Vec<u8>, String> {
    let before = fs::read(path).map_err(|e| {
        crate::io::describe(&e, &tr!("無法讀取「{name}」", name = display_name(path)))
    })?;
    let (disk, format, encoding) = decode(&before);
    if encoding != "utf-8" {
        return Err(tr!(
            "「{name}」不是 UTF-8 編碼，請先開啟並存檔",
            name = display_name(path)
        ));
    }
    if disk != expected {
        return Err(tr!(
            "「{name}」剛被修改過，請重新整理後再試",
            name = display_name(path)
        ));
    }
    write_atomic(path, &encode(text, format)).map_err(|e| {
        crate::io::describe(&e, &tr!("無法寫入「{name}」", name = display_name(path)))
    })?;
    Ok(before)
}

#[tauri::command]
pub async fn update_doc(
    app: AppHandle,
    path: String,
    expected: String,
    text: String,
) -> Result<(), String> {
    let root = app.state::<Workspace>().require_root()?;
    let path: PathBuf = resolve_inside(&root, Path::new(&path))?;
    crate::io::blocking(move || {
        let before = update(&path, &expected, &text)?;
        crate::history::on_save(&app, &path, Some(&before), &text);
        // 這個檔案也在分頁中開著（例如沒有未存檔的變更）時，更新記錄的雜湊，下次存檔才不會誤報衝突。
        let known = app.state::<KnownFiles>();
        let mut known = known.0.lock().unwrap();
        if let Some(state) = known.get_mut(&path) {
            state.hash = Some(hash_bytes(&encode(&text, state.format)));
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("md-index-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("筆記")).unwrap();
        dir
    }

    #[test]
    fn scans_markdown_and_skips_unchanged() {
        let dir = temp_dir("scan");
        fs::write(dir.join("週報.md"), "- [ ] 寫週報\n").unwrap();
        fs::write(dir.join("筆記").join("會議.markdown"), "#專案A").unwrap();
        fs::write(dir.join("清單.txt"), "- [ ] 純文字不算").unwrap();
        let mut docs = scan(&dir, &HashMap::new());
        docs.sort_by(|a, b| a.rel.cmp(&b.rel));
        let rels: Vec<&str> = docs.iter().map(|d| d.rel.as_str()).collect();
        assert_eq!(rels, ["筆記/會議.markdown", "週報.md"]);
        let info = docs[1].info.as_ref().unwrap();
        assert_eq!(info.tasks[0].text, "寫週報");
        assert_eq!(docs[0].info.as_ref().unwrap().tags, ["專案A"]);

        let known: HashMap<String, u64> = docs.iter().map(|d| (d.path.clone(), d.mtime)).collect();
        assert!(scan(&dir, &known).iter().all(|d| d.info.is_none()));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn updates_only_when_the_disk_matches() {
        let dir = temp_dir("update");
        let path = dir.join("週報.md");
        fs::write(&path, "\u{feff}- [ ] 寫週報\r\n- [ ] 開會\r\n").unwrap();
        let before = update(
            &path,
            "- [ ] 寫週報\n- [ ] 開會\n",
            "- [x] 寫週報\n- [ ] 開會\n",
        )
        .unwrap();
        assert!(before.starts_with(b"\xEF\xBB\xBF"));
        // 保留 BOM 與 CRLF
        assert_eq!(
            fs::read(&path).unwrap(),
            "\u{feff}- [x] 寫週報\r\n- [ ] 開會\r\n".as_bytes()
        );
        let err = update(&path, "舊的內容", "新的內容").unwrap_err();
        assert!(err.contains("剛被修改過"), "{err}");
        fs::remove_dir_all(&dir).unwrap();
    }
}
