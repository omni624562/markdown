//! 離線副本：看過的工作項目、Wiki 頁面與裡面的圖片存一份在本機，連不上伺服器時拿來顯示。
//!
//! 放在 App 的本機資料夾 `offline/` 底下，檔名是鍵的 SHA-256。分兩區：
//! - `cache/`：自動存的，總量超過上限時從最久沒用的刪起；
//! - `kept/`：使用者按了「保留離線」的，不會自動刪掉。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

/// 自動存的副本總量上限，超過就刪到 `CACHE_TARGET` 以下。
const CACHE_QUOTA: u64 = 200 * 1024 * 1024;
const CACHE_TARGET: u64 = 150 * 1024 * 1024;
/// 單一副本的大小上限（圖片轉成 data: 網址後最多約 14 MB）。
const ENTRY_LIMIT: usize = 16 * 1024 * 1024;

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("offline"))
        .map_err(|e| e.to_string())
}

fn file_name(key: &str) -> String {
    Sha256::digest(key.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
        + ".txt"
}

/// 存一份副本；`kept` 時放在不會自動刪掉的地方（另一區的同一份會移除）。
pub fn put_at(root: &Path, key: &str, value: &str, kept: bool) -> Result<(), String> {
    if value.len() > ENTRY_LIMIT {
        return Ok(());
    }
    let name = file_name(key);
    let (to, other) = if kept {
        ("kept", "cache")
    } else {
        ("cache", "kept")
    };
    let dir = root.join(to);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::files::write_atomic(&dir.join(&name), value.as_bytes()).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(root.join(other).join(&name));
    if !kept {
        trim(&dir, CACHE_QUOTA, CACHE_TARGET);
    }
    Ok(())
}

/// 讀副本（先找保留的，再找自動存的）；讀到自動存的會更新修改時間，避免被當成很久沒用而刪掉。
pub fn get_at(root: &Path, key: &str) -> Option<String> {
    let name = file_name(key);
    if let Ok(text) = fs::read_to_string(root.join("kept").join(&name)) {
        return Some(text);
    }
    let path = root.join("cache").join(&name);
    let text = fs::read_to_string(&path).ok()?;
    if let Ok(f) = fs::OpenOptions::new().write(true).open(&path) {
        let _ = f.set_modified(SystemTime::now());
    }
    Some(text)
}

/// 把保留的副本移回自動存的區域（取消「保留離線」）。
pub fn release_at(root: &Path, key: &str) {
    let name = file_name(key);
    let from = root.join("kept").join(&name);
    if !from.exists() {
        return;
    }
    let dir = root.join("cache");
    if fs::create_dir_all(&dir).is_ok() && fs::rename(&from, dir.join(&name)).is_ok() {
        trim(&dir, CACHE_QUOTA, CACHE_TARGET);
    }
}

/// 資料夾總量超過 `quota` 時，從修改時間最舊的刪起，刪到 `target` 以下。
fn trim(dir: &Path, quota: u64, target: u64) {
    let mut files: Vec<(SystemTime, u64, PathBuf)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            meta.is_file().then(|| {
                (
                    meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    meta.len(),
                    e.path(),
                )
            })
        })
        .collect();
    let mut total: u64 = files.iter().map(|(_, size, _)| size).sum();
    if total <= quota {
        return;
    }
    files.sort_by_key(|(time, _, _)| *time);
    for (_, size, path) in files {
        if total <= target {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total -= size;
        }
    }
}

#[tauri::command]
pub async fn offline_put(
    app: AppHandle,
    key: String,
    value: String,
    kept: bool,
) -> Result<(), String> {
    let root = root(&app)?;
    crate::io::blocking(move || put_at(&root, &key, &value, kept)).await
}

#[tauri::command]
pub async fn offline_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let root = root(&app)?;
    crate::io::blocking(move || Ok(get_at(&root, &key))).await
}

#[tauri::command]
pub async fn offline_release(app: AppHandle, key: String) -> Result<(), String> {
    let root = root(&app)?;
    crate::io::blocking(move || {
        release_at(&root, &key);
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("md-offline-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn keeps_and_releases_copies() {
        let dir = temp_dir("keep");
        let root = dir.as_path();
        put_at(root, "wiki:1:/a", "A", false).unwrap();
        assert_eq!(get_at(root, "wiki:1:/a").as_deref(), Some("A"));
        put_at(root, "wiki:1:/a", "A2", true).unwrap();
        assert_eq!(get_at(root, "wiki:1:/a").as_deref(), Some("A2"));
        assert_eq!(fs::read_dir(root.join("cache")).unwrap().count(), 0);
        release_at(root, "wiki:1:/a");
        assert_eq!(get_at(root, "wiki:1:/a").as_deref(), Some("A2"));
        assert_eq!(fs::read_dir(root.join("kept")).unwrap().count(), 0);
        assert_eq!(get_at(root, "nope"), None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn trims_oldest_first() {
        let dir = temp_dir("trim");
        let root = dir.as_path();
        let old = SystemTime::now() - std::time::Duration::from_secs(60);
        for (i, key) in ["a", "b", "c"].iter().enumerate() {
            let path = root.join(file_name(key));
            fs::write(&path, "x".repeat(10)).unwrap();
            let f = fs::OpenOptions::new().write(true).open(&path).unwrap();
            f.set_modified(old + std::time::Duration::from_secs(i as u64))
                .unwrap();
        }
        trim(root, 25, 20);
        assert!(!root.join(file_name("a")).exists());
        assert!(root.join(file_name("b")).exists());
        assert!(root.join(file_name("c")).exists());
        let _ = fs::remove_dir_all(root);
    }
}
