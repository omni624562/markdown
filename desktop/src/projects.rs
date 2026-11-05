//! 專案：開過的資料夾，加上自訂名稱、顏色、群組與釘選。
//!
//! 專案清單就是信任清單裡的資料夾（`trust.rs`），這裡只提供讀取與修改的指令；
//! 開啟專案沿用 `workspace::reopen_folder`。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State, Window};

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
    /// 資料夾裡有 `.comet.json`（做過 comet setup 的 COMET 專案）。
    comet: bool,
}

/// 專案根目錄有 `.comet.json` 就是 COMET 專案。遠端與網路磁碟不檢查（每次讀清單都會查，不能慢）。
fn is_comet(path: &Path) -> bool {
    !crate::dav::is_remote_path(&path.to_string_lossy())
        && !crate::io::is_network_path(path)
        && path.join(".comet.json").is_file()
}

impl From<ProjectMeta> for ProjectInfo {
    fn from(m: ProjectMeta) -> Self {
        ProjectInfo {
            comet: is_comet(&m.path),
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
        return Err(tr!("{what}最多 {max} 個字", what = what, max = max));
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
    let name = clean(change.name, MAX_NAME, &tr!("名稱"))?;
    let group = clean(change.group, MAX_GROUP, &tr!("群組名稱"))?;
    let color = match change.color.as_deref() {
        None | Some("") => None,
        Some(c) if COLORS.contains(&c) => Some(c.to_string()),
        Some(_) => return Err(tr!("不支援這個顏色")),
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

/// 不能移到資源回收筒的資料夾：磁碟的根目錄、使用者資料夾（或它的上層）、文件、桌面、下載等系統資料夾。
fn protected_folder(dir: &Path, system: &[PathBuf]) -> bool {
    dir.parent().is_none() || system.iter().any(|s| s == dir || s.starts_with(dir))
}

/// 刪除專案：從專案清單移除；`trash_folder` 時把整個資料夾移到資源回收筒（可以從回收筒還原）。
/// 只能刪專案清單上的資料夾；目前開著的專案要先關閉。沒有資源回收筒（例如網路磁碟）時回報錯誤，
/// 不會改成直接刪除。
#[tauri::command]
pub async fn project_delete(
    app: AppHandle,
    path: String,
    trash_folder: bool,
) -> Result<(), String> {
    use tauri::Manager;
    let dir = PathBuf::from(&path);
    if app.state::<Trust>().project(&dir).is_none() {
        return Err(tr!("這個資料夾不在專案清單中"));
    }
    if app
        .state::<crate::workspace::Workspace>()
        .root()
        .is_some_and(|root| root == dir)
    {
        return Err(tr!("請先關閉這個專案再刪除"));
    }
    if trash_folder && dir.exists() {
        let p = app.path();
        let system: Vec<PathBuf> = [
            p.home_dir(),
            p.document_dir(),
            p.desktop_dir(),
            p.download_dir(),
            p.picture_dir(),
            p.app_data_dir(),
        ]
        .into_iter()
        .filter_map(Result::ok)
        .collect();
        if protected_folder(&dir, &system) {
            return Err(tr!(
                "「{name}」是系統或使用者資料夾，不能移到資源回收筒；可以只從清單移除",
                name = display_name(&dir)
            ));
        }
        let d = dir.clone();
        // 很大的資料夾移到回收筒要一點時間。
        crate::io::blocking_for(std::time::Duration::from_secs(300), move || {
            trash::delete(&d).map_err(|e| tr!("無法把資料夾移到資源回收筒：{e}", e = e))
        })
        .await?;
    }
    app.state::<Trust>().forget_folder(&app, &dir);
    Ok(())
}

/// 資料夾搬走後重新指定位置：保留名稱、顏色、群組。使用者取消時回傳 None。
#[tauri::command]
pub async fn project_relocate(
    app: AppHandle,
    window: Window,
    trust: State<'_, Trust>,
    path: String,
) -> Result<Option<ProjectInfo>, String> {
    let from = PathBuf::from(&path);
    let Some(meta) = trust.project(&from) else {
        return Err(tr!("這個資料夾不在專案清單中"));
    };
    let label = ProjectInfo::from(meta).label;
    let Some(picked) = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title(tr!("重新指定「{label}」的位置", label = label))
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
        return Err(tr!("這個資料夾不在專案清單中"));
    }
    crate::io::blocking(move || {
        if !path.is_dir() {
            return Err(tr!("找不到資料夾「{path}」", path = path.display()));
        }
        crate::workspace::reveal_path(&path)
    })
    .await
}

/// 在 Codex 桌面版開啟的網址：`codex://threads/new?path=<路徑>`，Codex 會開一個新對話，工作區就是這個資料夾。
/// 路徑只留英數字與 `-_.~`，其他字元（含中文、`\`、`:`、空白）都用 UTF-8 的 %XX 編碼。
fn codex_url(path: &str) -> String {
    let mut out = String::from("codex://threads/new?path=");
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// 在 Codex 桌面版開啟專案。只接受專案清單裡的本機資料夾（遠端資料夾 Codex 打不開）；
/// 交給系統開啟 `codex://` 網址，沒有安裝 Codex 桌面版時由系統提示要用哪個程式開啟。
#[tauri::command]
pub fn project_open_codex(
    app: AppHandle,
    trust: State<'_, Trust>,
    path: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = PathBuf::from(&path);
    if trust.project(&dir).is_none() {
        return Err(tr!("這個資料夾不在專案清單中"));
    }
    if crate::dav::is_remote_path(&path) || !dir.is_absolute() {
        return Err(tr!("遠端資料夾不能在 Codex 開啟"));
    }
    app.opener()
        .open_url(codex_url(&path_string(&dir)), None::<&str>)
        .map_err(|e| tr!("無法開啟 Codex 桌面版（請確認已經安裝）：{e}", e = e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_folders_are_protected() {
        let home = PathBuf::from("/home/me");
        let docs = PathBuf::from("/home/me/Documents");
        let system = [home.clone(), docs.clone()];
        assert!(protected_folder(Path::new("/"), &system));
        assert!(protected_folder(&home, &system));
        assert!(protected_folder(Path::new("/home"), &system));
        assert!(protected_folder(&docs, &system));
        assert!(!protected_folder(&docs.join("產品筆記"), &system));
        assert!(!protected_folder(Path::new("/data/產品"), &system));
    }

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

    #[test]
    fn comet_projects_have_comet_json() {
        let dir = std::env::temp_dir().join(format!("omarker-comet-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let info = |dir: &Path| {
            ProjectInfo::from(ProjectMeta {
                path: dir.to_path_buf(),
                ..Default::default()
            })
        };
        assert!(!info(&dir).comet);
        std::fs::write(dir.join(".comet.json"), "{}").unwrap();
        assert!(info(&dir).comet);
        // 同名的資料夾不算。
        std::fs::remove_file(dir.join(".comet.json")).unwrap();
        std::fs::create_dir(dir.join(".comet.json")).unwrap();
        assert!(!info(&dir).comet);
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(!info(Path::new("ssh://host/專案")).comet);
    }

    #[test]
    fn codex_url_encodes_the_path() {
        // 和 PowerShell 的 [uri]::EscapeDataString 一樣。
        assert_eq!(
            codex_url(r"C:\Users\me\產品 筆記"),
            "codex://threads/new?path=C%3A%5CUsers%5Cme%5C%E7%94%A2%E5%93%81%20%E7%AD%86%E8%A8%98"
        );
        assert_eq!(
            codex_url("/home/me/a&b?c#d"),
            "codex://threads/new?path=%2Fhome%2Fme%2Fa%26b%3Fc%23d"
        );
        assert_eq!(
            codex_url("v1.2_x-y~z"),
            "codex://threads/new?path=v1.2_x-y~z"
        );
    }
}
