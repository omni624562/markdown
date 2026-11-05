//! 新專案：在使用者選的位置建立一個資料夾（放進 README.md；筆記本還有每日筆記與 assets 資料夾；
//! 可以順便建立 Git 儲存庫），加進專案清單並開啟。
//!
//! 前端不能指定任意路徑：新專案只能建在「文件」資料夾，或使用者在「瀏覽…」對話框選過的資料夾裡。

use parking_lot::Mutex;
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager, State, Window};

use crate::files::{display_name, path_string};
use crate::trust::Trust;
use crate::workspace::{FolderInfo, Workspace};

/// 使用者用「瀏覽…」選過、可以放新專案的資料夾。
#[derive(Default)]
pub struct ProjectParents(Mutex<HashSet<PathBuf>>);

/// 預設的位置：「文件」資料夾。
#[tauri::command]
pub fn project_default_parent(app: AppHandle) -> Option<String> {
    app.path().document_dir().ok().map(|p| path_string(&p))
}

/// 「瀏覽…」：選新專案要放在哪個資料夾。取消時回傳 `None`。
#[tauri::command]
pub async fn pick_project_parent(
    app: AppHandle,
    window: Window,
    parents: State<'_, ProjectParents>,
) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title(tr!("選擇新專案要放在哪個資料夾"));
    if let Ok(docs) = app.path().document_dir() {
        dialog = dialog.set_directory(docs);
    }
    let Some(picked) = dialog.pick_folder().await else {
        return Ok(None);
    };
    let path = picked.path().to_path_buf();
    parents.0.lock().insert(path.clone());
    Ok(Some(path_string(&path)))
}

/// Windows 不能當檔名的名稱（不分大小寫，也不能加副檔名）。
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 專案名稱（也是資料夾名稱）不能用時回傳原因。
pub fn invalid_name(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() {
        return Some(tr!("請輸入專案名稱"));
    }
    if name.chars().count() > 120 {
        return Some(tr!("專案名稱太長了"));
    }
    if name
        .chars()
        .any(|c| "\\/:*?\"<>|".contains(c) || c.is_control())
    {
        return Some(tr!("專案名稱不能有這些字元：\\ / : * ? \" < > |"));
    }
    if name == "." || name == ".." || name.ends_with('.') {
        return Some(tr!("專案名稱不能用「.」結尾"));
    }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return Some(tr!(
            "「{name}」是 Windows 保留的名稱，請換一個",
            name = name
        ));
    }
    None
}

/// 每日筆記的子資料夾（設定裡的「筆記/每日」）：只接受資料夾裡面的相對路徑。
fn daily_dir(folder: &str) -> Option<PathBuf> {
    let path = Path::new(folder.trim());
    let ok =
        !folder.trim().is_empty() && path.components().all(|c| matches!(c, Component::Normal(_)));
    ok.then(|| path.to_path_buf())
}

/// README.md 的內容。
fn readme(name: &str, daily: Option<&Path>) -> String {
    let mut text = format!("# {name}\n");
    if let Some(daily) = daily {
        text.push_str(&tr!(
            "\n- 每日筆記：`{daily}/`\n- 圖片：`assets/`\n",
            daily = daily.to_string_lossy().replace('\\', "/")
        ));
    }
    text
}

/// 建立新專案的資料夾並開啟（加進專案清單）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_project(
    app: AppHandle,
    parents: State<'_, ProjectParents>,
    workspace: State<'_, Workspace>,
    trust: State<'_, Trust>,
    parent: String,
    name: String,
    notebook: bool,
    git: bool,
    daily_folder: Option<String>,
) -> Result<FolderInfo, String> {
    if let Some(why) = invalid_name(&name) {
        return Err(why);
    }
    let name = name.trim().to_string();
    let parent = PathBuf::from(parent);
    let allowed =
        app.path().document_dir().is_ok_and(|d| d == parent) || parents.0.lock().contains(&parent);
    if !allowed {
        return Err(tr!("請用「瀏覽…」選擇新專案要放在哪裡"));
    }
    let daily = notebook.then(|| {
        daily_folder
            .as_deref()
            .and_then(daily_dir)
            .unwrap_or_else(|| PathBuf::from(tr!("每日筆記")))
    });
    let dir = parent.join(&name);
    let dir2 = dir.clone();
    crate::io::blocking(move || {
        if fs::symlink_metadata(&dir2).is_ok() {
            return Err(tr!(
                "「{path}」已經存在，換一個名稱或位置",
                path = path_string(&dir2)
            ));
        }
        let fail = |e: std::io::Error| {
            crate::io::describe(
                &e,
                &tr!("無法建立資料夾「{name}」", name = display_name(&dir2)),
            )
        };
        fs::create_dir(&dir2).map_err(fail)?;
        fs::write(dir2.join("README.md"), readme(&name, daily.as_deref())).map_err(fail)?;
        if let Some(daily) = &daily {
            fs::create_dir_all(dir2.join(daily)).map_err(fail)?;
            fs::create_dir(dir2.join("assets")).map_err(fail)?;
        }
        if git {
            git2::Repository::init(&dir2)
                .map_err(|e| tr!("無法建立 Git 儲存庫：{e}", e = e.message()))?;
        }
        Ok(())
    })
    .await?;
    Ok(crate::workspace::activate(&app, dir, &workspace, &trust))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_names() {
        assert!(invalid_name("產品筆記").is_none());
        assert!(invalid_name("  ").is_some());
        assert!(invalid_name("a/b").is_some());
        assert!(invalid_name("a:b").is_some());
        assert!(invalid_name("筆記.").is_some());
        assert!(invalid_name("con").is_some());
        assert!(invalid_name("Lpt1.txt").is_some());
        assert!(invalid_name("console").is_none());
    }

    #[test]
    fn daily_folder_stays_inside() {
        assert_eq!(daily_dir("筆記/每日"), Some(PathBuf::from("筆記/每日")));
        assert_eq!(daily_dir("../外面"), None);
        assert_eq!(daily_dir(""), None);
        #[cfg(windows)]
        assert_eq!(daily_dir("C:\\外面"), None);
        #[cfg(not(windows))]
        assert_eq!(daily_dir("/外面"), None);
    }

    #[test]
    fn readme_lists_folders_for_notebooks() {
        assert_eq!(readme("產品筆記", None), "# 產品筆記\n");
        assert!(readme("產品筆記", Some(Path::new("每日筆記"))).contains("`每日筆記/`"));
    }
}
