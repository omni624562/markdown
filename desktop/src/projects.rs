//! 專案：開過的資料夾，加上自訂名稱、顏色、群組與釘選。
//!
//! 專案清單就是信任清單裡的資料夾（`trust.rs`），這裡只提供讀取與修改的指令；
//! 開啟專案沿用 `workspace::reopen_folder`。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State, WebviewWindow};

use crate::files::{display_name, path_string};
use crate::trust::{ProjectMeta, Trust};

/// 可以選的顏色（前端對應到主題的色票）。
pub const COLORS: &[&str] = &[
    "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "gray",
];

const MAX_NAME: usize = 80;
const MAX_GROUP: usize = 40;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    path: String,
    /// 顯示用的名稱：自訂名稱，沒有就是資料夾名稱。
    label: String,
    name: Option<String>,
    color: Option<String>,
    group: Option<String>,
    pinned: bool,
    last_opened: u64,
}

impl From<ProjectMeta> for ProjectInfo {
    fn from(m: ProjectMeta) -> Self {
        ProjectInfo {
            label: m.name.clone().unwrap_or_else(|| display_name(&m.path)),
            path: path_string(&m.path),
            name: m.name,
            color: m.color,
            group: m.group,
            pinned: m.pinned,
            last_opened: m.last_opened,
        }
    }
}

/// 去掉前後空白與控制字元；空字串代表「不設定」。
fn clean(text: Option<String>, max: usize, what: &str) -> Result<Option<String>, String> {
    let Some(text) = text else { return Ok(None) };
    let text: String = text.chars().filter(|c| !c.is_control()).collect();
    let text = text.trim();
    if text.is_empty() {
        return Ok(None);
    }
    if text.chars().count() > max {
        return Err(format!("{what}最多 {max} 個字"));
    }
    Ok(Some(text.to_string()))
}

#[derive(serde::Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChange {
    name: Option<String>,
    color: Option<String>,
    group: Option<String>,
    pinned: bool,
}

/// 檢查後套用到專案設定（整組取代可以修改的欄位）。
fn apply(meta: &mut ProjectMeta, change: ProjectChange) -> Result<(), String> {
    let name = clean(change.name, MAX_NAME, "名稱")?;
    let group = clean(change.group, MAX_GROUP, "群組名稱")?;
    let color = match change.color.as_deref() {
        None | Some("") => None,
        Some(c) if COLORS.contains(&c) => Some(c.to_string()),
        Some(_) => return Err("不支援這個顏色".into()),
    };
    // 跟資料夾名稱一樣就不必另外記。
    meta.name = name.filter(|n| *n != display_name(&meta.path));
    meta.color = color;
    meta.group = group;
    meta.pinned = change.pinned;
    Ok(())
}

#[tauri::command]
pub fn projects_list(trust: State<'_, Trust>) -> Vec<ProjectInfo> {
    trust
        .snapshot()
        .project_list()
        .into_iter()
        .map(ProjectInfo::from)
        .collect()
}

#[tauri::command]
pub fn project_update(
    app: AppHandle,
    trust: State<'_, Trust>,
    path: String,
    change: ProjectChange,
) -> Result<ProjectInfo, String> {
    let path = PathBuf::from(path);
    // 先檢查，避免寫到一半才發現有錯。
    let mut check = ProjectMeta {
        path: path.clone(),
        ..Default::default()
    };
    apply(&mut check, change)?;
    trust
        .update_project(&app, &path, |m| {
            m.name = check.name;
            m.color = check.color;
            m.group = check.group;
            m.pinned = check.pinned;
        })
        .map(ProjectInfo::from)
}

/// 從專案清單移除；資料夾和裡面的檔案都不會動。
#[tauri::command]
pub fn project_forget(app: AppHandle, trust: State<'_, Trust>, path: String) {
    trust.forget_folder(&app, Path::new(&path));
}

/// 資料夾搬走後重新指定位置：保留名稱、顏色、群組。使用者取消時回傳 None。
#[tauri::command]
pub async fn project_relocate(
    app: AppHandle,
    window: WebviewWindow,
    trust: State<'_, Trust>,
    path: String,
) -> Result<Option<ProjectInfo>, String> {
    let from = PathBuf::from(&path);
    let Some(meta) = trust.project(&from) else {
        return Err("這個資料夾不在專案清單中".into());
    };
    let label = ProjectInfo::from(meta).label;
    let Some(picked) = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title(format!("重新指定「{label}」的位置"))
        .pick_folder()
        .await
    else {
        return Ok(None);
    };
    let to = picked.path().to_path_buf();
    trust.rename(&app, &from, &to);
    Ok(trust.project(&to).map(ProjectInfo::from))
}

/// 在檔案總管中顯示專案資料夾（只限專案清單裡的資料夾）。
#[tauri::command]
pub async fn project_reveal(trust: State<'_, Trust>, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !trust.allows_folder(&path) {
        return Err("這個資料夾不在專案清單中".into());
    }
    crate::io::blocking(move || {
        if !path.is_dir() {
            return Err(format!("找不到資料夾「{}」", path.display()));
        }
        crate::workspace::reveal_path(&path)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(name: &str, color: &str, group: &str, pinned: bool) -> ProjectChange {
        ProjectChange {
            name: Some(name.into()),
            color: Some(color.into()),
            group: Some(group.into()),
            pinned,
        }
    }

    #[test]
    fn cleans_and_validates_changes() {
        let mut m = ProjectMeta {
            path: PathBuf::from("/文件/筆記"),
            ..Default::default()
        };
        apply(&mut m, change("  工作筆記\n ", "blue", " 公司 ", true)).unwrap();
        assert_eq!(m.name.as_deref(), Some("工作筆記"));
        assert_eq!(m.color.as_deref(), Some("blue"));
        assert_eq!(m.group.as_deref(), Some("公司"));
        assert!(m.pinned);
        // 空白代表取消設定；名稱跟資料夾一樣就不另外記。
        apply(&mut m, change("筆記", "", "  ", false)).unwrap();
        assert_eq!(m.name, None);
        assert_eq!(m.color, None);
        assert_eq!(m.group, None);
        assert!(apply(&mut m, change("", "#ff0000", "", false)).is_err());
        assert!(apply(&mut m, change(&"長".repeat(81), "", "", false)).is_err());
    }

    #[test]
    fn label_falls_back_to_folder_name() {
        let info = ProjectInfo::from(ProjectMeta {
            path: PathBuf::from("/文件/筆記"),
            ..Default::default()
        });
        assert_eq!(info.label, "筆記");
        let info = ProjectInfo::from(ProjectMeta {
            path: PathBuf::from("/文件/筆記"),
            name: Some("工作".into()),
            ..Default::default()
        });
        assert_eq!(info.label, "工作");
    }
}
