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

/// COMET CLI 在哪裡。
#[derive(Debug, PartialEq)]
enum Comet {
    /// `comet` 指令在 PATH 裡。
    OnPath,
    /// 不在 PATH 裡，但在安裝位置找得到（`%COMET_HOME%\bin` 或 `%USERPROFILE%\Comet\bin`）。
    /// 第一次執行 `comet setup` 才會把 bin 資料夾加進 PATH，所以新電腦上要用完整路徑執行。
    Installed(PathBuf),
}

/// COMET 安裝資料夾（`COMET_HOME`）裡的執行檔。
fn comet_exe_in(comet_home: &Path) -> PathBuf {
    let exe = if cfg!(windows) { "comet.exe" } else { "comet" };
    comet_home.join("bin").join(exe)
}

/// 找 COMET CLI：先找 PATH，再找 `COMET_HOME`（安裝時設定的環境變數）裡的 bin，最後找預設的安裝位置
/// `%USERPROFILE%\Comet`。搜尋 PATH 可能很慢（例如 PATH 裡有斷線的網路磁碟），要在背景執行緒呼叫。
fn locate_comet(comet_home: Option<PathBuf>, home: Option<PathBuf>) -> Option<Comet> {
    if which::which("comet").is_ok() {
        return Some(Comet::OnPath);
    }
    comet_home
        .filter(|h| !h.as_os_str().is_empty())
        .into_iter()
        .chain(home.map(|h| h.join("Comet")))
        .map(|dir| comet_exe_in(&dir))
        .find(|exe| exe.is_file())
        .map(Comet::Installed)
}

/// COMET CLI 的執行檔：PATH 裡的 `comet`，或安裝位置的完整路徑。搜尋 PATH 可能很慢，要在背景執行緒呼叫。
pub(crate) fn comet_program(comet_home: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    match locate_comet(comet_home, home)? {
        Comet::OnPath => which::which("comet").ok(),
        Comet::Installed(exe) => Some(exe),
    }
}

/// 目前的 `COMET_HOME` 與使用者資料夾（給 [`locate_comet`]）。
pub(crate) fn comet_roots(app: &AppHandle) -> (Option<PathBuf>, Option<PathBuf>) {
    (
        std::env::var_os("COMET_HOME").map(PathBuf::from),
        app.path().home_dir().ok(),
    )
}

/// 用完整路徑執行程式的一行指令：Windows 的終端機是 PowerShell（`& '路徑' 參數`），
/// 其他系統是 POSIX 殼層（`'路徑' 參數`）。路徑用單引號包起來，路徑裡的單引號照各自的規則跳脫。
fn call_line(exe: &Path, args: &str) -> String {
    let path = exe.to_string_lossy();
    if cfg!(windows) {
        format!("& '{}' {args}", path.replace('\'', "''"))
    } else {
        format!("'{}' {args}", path.replace('\'', "'\\''"))
    }
}

/// 這台電腦有沒有安裝 COMET CLI（PATH 裡有 `comet` 指令，或在安裝位置找得到）。
/// 新 COMET 專案建立後要在終端機執行 `comet setup`。
#[tauri::command]
pub async fn comet_installed(app: AppHandle) -> bool {
    let (comet_home, home) = comet_roots(&app);
    tauri::async_runtime::spawn_blocking(move || locate_comet(comet_home, home).is_some())
        .await
        .unwrap_or(false)
}

/// 終端機要輸入的 `comet setup` 指令（只有終端機面板可以呼叫）：`comet` 在 PATH 裡就直接執行，
/// 不在時用安裝位置的完整路徑執行。都找不到時照樣送 `comet setup`，讓殼層說找不到指令。
///
/// 不把安裝位置加進終端機的 PATH：`comet setup` 會檢查 PATH 裡有沒有它，加了就不會幫使用者設定，
/// 離開 oMarker 後還是找不到 `comet`。
#[tauri::command]
pub async fn comet_setup_line(app: AppHandle, webview: tauri::Webview) -> Result<String, String> {
    crate::ai::view::require_terminal(&webview)?;
    let (comet_home, home) = comet_roots(&app);
    tauri::async_runtime::spawn_blocking(move || match locate_comet(comet_home, home) {
        Some(Comet::Installed(exe)) => call_line(&exe, "setup"),
        _ => "comet setup".to_string(),
    })
    .await
    .map_err(|e| e.to_string())
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
    fn comet_is_found_in_its_install_folders() {
        let root = std::env::temp_dir().join(format!("omarker-comet-{}", std::process::id()));
        let home = root.join("home");
        let custom = root.join("tools").join("Comet");
        let in_home = comet_exe_in(&home.join("Comet"));
        assert!(in_home.ends_with(if cfg!(windows) {
            r"Comet\bin\comet.exe"
        } else {
            "Comet/bin/comet"
        }));
        // 測試機的 PATH 裡沒有 comet 時，才看得出有沒有去安裝位置找。
        if which::which("comet").is_err() {
            let found = |comet_home: Option<&Path>, home: Option<&Path>| {
                locate_comet(
                    comet_home.map(Path::to_path_buf),
                    home.map(Path::to_path_buf),
                )
            };
            assert_eq!(found(Some(&custom), Some(&home)), None);
            // 預設位置：%USERPROFILE%\Comet\bin。
            fs::create_dir_all(in_home.parent().unwrap()).unwrap();
            fs::write(&in_home, "").unwrap();
            assert_eq!(
                found(None, Some(&home)),
                Some(Comet::Installed(in_home.clone()))
            );
            // COMET_HOME 設到別的地方時先找那裡；那裡沒有才找預設位置。
            assert_eq!(
                found(Some(&custom), Some(&home)),
                Some(Comet::Installed(in_home.clone()))
            );
            let in_custom = comet_exe_in(&custom);
            fs::create_dir_all(in_custom.parent().unwrap()).unwrap();
            fs::write(&in_custom, "").unwrap();
            assert_eq!(
                found(Some(&custom), Some(&home)),
                Some(Comet::Installed(in_custom.clone()))
            );
            assert_eq!(
                found(Some(&custom), None),
                Some(Comet::Installed(in_custom))
            );
            // 空的 COMET_HOME 不算。
            assert_eq!(
                found(Some(Path::new("")), Some(&home)),
                Some(Comet::Installed(in_home))
            );
            assert_eq!(found(None, None), None);
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn full_path_calls_are_quoted() {
        if cfg!(windows) {
            assert_eq!(
                call_line(Path::new(r"C:\Users\me\Comet\bin\comet.exe"), "setup"),
                r"& 'C:\Users\me\Comet\bin\comet.exe' setup"
            );
            assert_eq!(
                call_line(Path::new(r"C:\Users\o'brien\comet.exe"), "setup"),
                r"& 'C:\Users\o''brien\comet.exe' setup"
            );
        } else {
            assert_eq!(
                call_line(Path::new("/home/me/Comet/bin/comet"), "setup"),
                "'/home/me/Comet/bin/comet' setup"
            );
            assert_eq!(
                call_line(Path::new("/home/o'brien/comet"), "setup"),
                r"'/home/o'\''brien/comet' setup"
            );
        }
    }

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
