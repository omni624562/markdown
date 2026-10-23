//! 貼上或拖曳圖片：存到文件旁的 `assets` 資料夾，回傳可以插入 Markdown 的相對路徑。

use std::fs;
use std::io::Write;
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

/// 檢查圖片格式與大小，解出位元組（本機與 WebDAV 共用）。
pub fn decode_image(data_base64: &str, ext: &str) -> Result<Vec<u8>, String> {
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    if !ALLOWED.contains(&ext.as_str()) {
        return Err(tr!("不支援的圖片格式：{ext}", ext = ext));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|_| tr!("圖片資料無效"))?;
    if bytes.len() > MAX_BYTES {
        return Err(tr!("圖片超過 30 MB"));
    }
    Ok(bytes)
}

/// 把圖片存到 `doc_path` 旁的 `assets/`，回傳相對路徑（以 `/` 分隔，可直接放進 Markdown）。
#[tauri::command]
pub async fn save_image(
    doc_path: String,
    data_base64: String,
    ext: String,
    known: State<'_, KnownFiles>,
) -> Result<String, String> {
    let doc = PathBuf::from(&doc_path);
    // 只允許存在已開啟的文件旁邊。
    if !known.contains(&doc) {
        return Err(tr!("請先存檔，圖片會存在文件旁的 assets 資料夾"));
    }
    let bytes = decode_image(&data_base64, &ext)?;
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    crate::io::blocking(move || {
        let doc_dir = doc.parent().ok_or_else(|| tr!("路徑無效"))?;
        let dir = assets_dir(doc_dir)?;
        let stem = doc
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "image".into());
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let target = write_new(&dir, &stem, &stamp, &ext, &bytes)?;
        let name = target.file_name().unwrap().to_string_lossy();
        Ok(format!("assets/{name}"))
    })
    .await
}

/// 建立（或沿用）文件旁的 `assets` 資料夾，並確認它實際上就在文件的資料夾內：
/// `assets` 是指向別處的符號連結時拒絕，免得圖片被寫到其他地方。
fn assets_dir(doc_dir: &Path) -> Result<PathBuf, String> {
    let dir = doc_dir.join("assets");
    fs::create_dir_all(&dir)
        .map_err(|e| crate::io::describe(&e, &tr!("無法建立 assets 資料夾")))?;
    let real_doc =
        dunce::canonicalize(doc_dir).map_err(|e| crate::io::describe(&e, &tr!("路徑無效")))?;
    let real = dunce::canonicalize(&dir).map_err(|e| crate::io::describe(&e, &tr!("路徑無效")))?;
    // 比較上一層就好（Windows 上資料夾可能叫 `Assets`，大小寫不同）。
    if real.parent() != Some(real_doc.as_path()) {
        return Err(tr!("assets 資料夾指向文件資料夾以外的位置，無法存放圖片"));
    }
    Ok(dir)
}

/// 用不重複的檔名寫入新檔案。一律用 `create_new` 建立，不會覆蓋或跟著符號連結寫入既有的檔案。
fn write_new(
    dir: &Path,
    stem: &str,
    stamp: &str,
    ext: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    for _ in 0..20 {
        let target = unique_name(dir, stem, stamp, ext);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(mut f) => {
                return f
                    .write_all(bytes)
                    .map(|_| target)
                    .map_err(|e| crate::io::describe(&e, &tr!("無法儲存圖片")));
            }
            // 剛好有同名檔案出現（例如符號連結）：換下一個名稱。
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(crate::io::describe(&e, &tr!("無法儲存圖片"))),
        }
    }
    Err(tr!("無法儲存圖片：同名檔案太多"))
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

    #[test]
    fn saves_into_a_real_assets_folder() {
        let dir = std::env::temp_dir().join(format!("md-assets-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("文件")).unwrap();
        let assets = assets_dir(&dir.join("文件")).unwrap();
        let a = write_new(&assets, "週報", "1", "png", b"a").unwrap();
        let b = write_new(&assets, "週報", "1", "png", b"b").unwrap();
        assert_ne!(a, b);
        assert_eq!(fs::read(&a).unwrap(), b"a");
        #[cfg(unix)]
        {
            fs::create_dir_all(dir.join("別處")).unwrap();
            fs::create_dir_all(dir.join("另一份")).unwrap();
            std::os::unix::fs::symlink(dir.join("別處"), dir.join("另一份/assets")).unwrap();
            assert!(assets_dir(&dir.join("另一份")).is_err());
        }
        fs::remove_dir_all(&dir).unwrap();
    }
}
