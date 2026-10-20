//! 最近開啟的資料夾與檔案。
//!
//! 這份清單同時是「信任清單」：重新開啟 app 時還原分頁、從「最近開啟」開檔，
//! 都只允許清單裡的路徑（或位於清單中資料夾內的檔案），
//! 所以前端無法藉由傳入任意路徑讀取使用者沒有選過的檔案。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const MAX_FOLDERS: usize = 10;
const MAX_FILES: usize = 30;

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct Recent {
    pub folders: Vec<PathBuf>,
    pub files: Vec<PathBuf>,
}

#[derive(Default)]
pub struct Trust(Mutex<Recent>);

fn recent_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("recent.json"))
}

/// 把 `item` 移到清單最前面，並限制長度。
fn push_front(list: &mut Vec<PathBuf>, item: &Path, max: usize) {
    list.retain(|p| p != item);
    list.insert(0, item.to_path_buf());
    list.truncate(max);
}

impl Trust {
    pub fn load(app: &AppHandle) -> Self {
        let recent = recent_path(app)
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Trust(Mutex::new(recent))
    }

    fn save(&self, app: &AppHandle) {
        let Some(path) = recent_path(app) else { return };
        let json = serde_json::to_string_pretty(&*self.0.lock().unwrap()).unwrap_or_default();
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = crate::files::write_atomic(&path, json.as_bytes());
    }

    pub fn add_folder(&self, app: &AppHandle, path: &Path) {
        push_front(&mut self.0.lock().unwrap().folders, path, MAX_FOLDERS);
        self.save(app);
    }

    pub fn add_file(&self, app: &AppHandle, path: &Path) {
        push_front(&mut self.0.lock().unwrap().files, path, MAX_FILES);
        self.save(app);
    }

    /// 檔案或資料夾改名後，更新清單中的路徑。
    pub fn rename(&self, app: &AppHandle, from: &Path, to: &Path) {
        {
            let mut guard = self.0.lock().unwrap();
            let r = &mut *guard;
            for p in r.files.iter_mut().chain(r.folders.iter_mut()) {
                if let Ok(rest) = p.strip_prefix(from) {
                    *p = to.join(rest);
                }
            }
        }
        self.save(app);
    }

    pub fn remove(&self, app: &AppHandle, path: &Path) {
        {
            let mut r = self.0.lock().unwrap();
            r.files.retain(|p| !p.starts_with(path));
            r.folders.retain(|p| p != path);
        }
        self.save(app);
    }

    pub fn snapshot(&self) -> Recent {
        self.0.lock().unwrap().clone()
    }

    pub fn allows_folder(&self, path: &Path) -> bool {
        self.0.lock().unwrap().folders.iter().any(|p| p == path)
    }

    /// 檔案在最近開啟清單中，或位於最近開啟的資料夾內。
    pub fn allows(&self, path: &Path) -> bool {
        let r = self.0.lock().unwrap();
        allowed(&r, path)
    }
}

fn allowed(r: &Recent, path: &Path) -> bool {
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return false;
    }
    r.files.iter().any(|p| p == path) || r.folders.iter().any(|f| path.starts_with(f))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_list_moves_to_front_and_caps() {
        let mut list = vec![];
        for i in 0..5 {
            push_front(&mut list, Path::new(&format!("/a/{i}")), 3);
        }
        push_front(&mut list, Path::new("/a/3"), 3);
        assert_eq!(list, [PathBuf::from("/a/3"), "/a/4".into(), "/a/2".into()]);
    }

    #[test]
    fn allows_files_inside_recent_folders_only() {
        let r = Recent {
            folders: vec!["/筆記".into()],
            files: vec!["/其他/單一.md".into()],
        };
        assert!(allowed(&r, Path::new("/筆記/子/a.md")));
        assert!(allowed(&r, Path::new("/其他/單一.md")));
        assert!(!allowed(&r, Path::new("/其他/別的.md")));
        assert!(!allowed(&r, Path::new("/筆記/../etc/passwd")));
    }
}
