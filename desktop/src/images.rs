//! 貼上或拖曳圖片：存到文件旁的 `assets` 資料夾，回傳可以插入 Markdown 的相對路徑。

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use tauri::State;

use crate::files::KnownFiles;

const ALLOWED: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];
/// 單張圖片上限，避免誤貼巨大檔案。
const MAX_BYTES: usize = 30 * 1024 * 1024;

/// 產生不重複的檔名：`<文件名>-<日期時間>.<副檔名>`，同一秒內有多張時加上 `-2`、`-3`。
pub fn unique_name(dir: &Path, stem: &str, stamp: &str, ext: &str) -> PathBuf {
    let base = format!("{stem}-{stamp}");
    let mut candidate = dir.join(format!("{base}.{ext}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{base}-{n}.{ext}"));
        n += 1;
    }
    candidate
}

/// 把圖片存到 `doc_path` 旁的 `assets/`，回傳相對路徑（以 `/` 分隔，可直接放進 Markdown）。
#[tauri::command]
pub fn save_image(
    doc_path: String,
    data_base64: String,
    ext: String,
    known: State<'_, KnownFiles>,
) -> Result<String, String> {
    let doc = PathBuf::from(&doc_path);
    // 只允許存在已開啟的文件旁邊。
    if !known.contains(&doc) {
        return Err("請先存檔，圖片會存在文件旁的 assets 資料夾".into());
    }
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    if !ALLOWED.contains(&ext.as_str()) {
        return Err(format!("不支援的圖片格式：{ext}"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|_| "圖片資料無效".to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("圖片超過 30 MB".into());
    }
    let dir = doc.parent().ok_or("路徑無效")?.join("assets");
    fs::create_dir_all(&dir).map_err(|e| format!("無法建立 assets 資料夾：{e}"))?;
    let stem = doc
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "image".into());
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let target = unique_name(&dir, &stem, &stamp, &ext);
    fs::write(&target, &bytes).map_err(|e| format!("無法儲存圖片：{e}"))?;
    let name = target.file_name().unwrap().to_string_lossy();
    Ok(format!("assets/{name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_do_not_collide() {
        let dir = std::env::temp_dir().join(format!("md-img-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let a = unique_name(&dir, "週報", "20261020-101500", "png");
        assert_eq!(a.file_name().unwrap(), "週報-20261020-101500.png");
        fs::write(&a, b"x").unwrap();
        let b = unique_name(&dir, "週報", "20261020-101500", "png");
        assert_eq!(b.file_name().unwrap(), "週報-20261020-101500-2.png");
        fs::remove_dir_all(&dir).unwrap();
    }
}
