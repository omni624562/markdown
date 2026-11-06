//! 新專案：在使用者選的位置建立一個資料夾（放進 README.md；筆記本還有每日筆記與 assets 資料夾；
//! 可以順便建立 Git 儲存庫），加進專案清單並開啟。
//!
//! 前端不能指定任意路徑：新專案只能建在「文件」資料夾、使用者在「瀏覽…」對話框選過的資料夾，
//! 或上次建立新專案的位置（建立成功時由原生端記下，下次打開對話框時預先帶入）。

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

/// 記住上次新專案位置的檔案。
fn last_parent_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("new-project-parent.txt"))
}

/// 記下來的上次位置還能用：本機磁碟上的絕對路徑（不連網路位置），而且資料夾還在。
fn usable_parent(saved: &str) -> Option<PathBuf> {
    let saved = saved.trim();
    (crate::lexical::is_local_absolute(saved) && Path::new(saved).is_dir())
        .then(|| PathBuf::from(saved))
}

/// 預設的位置：上次建立新專案的位置（還在的話；這次也可以用），沒有的話是「文件」資料夾。
#[tauri::command]
pub fn project_default_parent(
    app: AppHandle,
    parents: State<'_, ProjectParents>,
) -> Option<String> {
    let last = last_parent_file(&app)
        .and_then(|f| fs::read_to_string(f).ok())
        .and_then(|saved| usable_parent(&saved));
    if let Some(last) = last {
        parents.0.lock().insert(last.clone());
        return Some(path_string(&last));
    }
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
        format!("& '{}' {args}", powershell_quoted(&path))
    } else {
        format!("'{}' {args}", path.replace('\'', "'\\''"))
    }
}

/// PowerShell 單引號字串裡的內容：單引號重複一次。PowerShell 把 `‘ ’ ‚ ‛`（U+2018～U+201B）
/// 也當成單引號，一樣要重複，否則路徑裡的這些字元會提早結束字串，後面的文字變成指令。
fn powershell_quoted(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            out.push(c);
        }
        out.push(c);
    }
    out
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

/// PATH 設定（`;` 分隔）裡的資料夾：去掉前後空白與引號，略過空的。
fn path_dirs(value: &str) -> Vec<PathBuf> {
    value
        .split(';')
        .map(|d| d.trim().trim_matches('"'))
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .collect()
}

/// 這些資料夾裡有沒有 COMET 的執行檔。
fn comet_in(dirs: &[PathBuf]) -> bool {
    let exe = if cfg!(windows) { "comet.exe" } else { "comet" };
    dirs.iter().any(|d| d.join(exe).is_file())
}

/// Windows 記在登錄檔裡、現在的使用者與系統 PATH（展開 `%USERPROFILE%` 這類變數）。
/// 執行過 `comet setup` 之後，新開的程式才會拿到新的 PATH；oMarker 已經開著時自己的 PATH 還是舊的，
/// 所以另外讀登錄檔。
#[cfg(windows)]
fn registry_path() -> String {
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_EXPAND_SZ,
        RRF_RT_REG_SZ,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    fn read(root: HKEY, key: &str) -> Option<String> {
        let key = wide(key);
        let name = wide("Path");
        let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
        let mut size: u32 = 0;
        // SAFETY: 機碼與值的名稱是以 0 結尾的 UTF-16 字串；第一次只問大小（不給緩衝區），
        // 第二次給剛好那麼大的緩衝區，系統寫入的位元組數不會超過 size。REG_EXPAND_SZ 由系統展開。
        unsafe {
            if RegGetValueW(
                root,
                key.as_ptr(),
                name.as_ptr(),
                flags,
                null_mut(),
                null_mut(),
                &mut size,
            ) != ERROR_SUCCESS
                || size == 0
            {
                return None;
            }
            let mut buf = vec![0u16; (size as usize).div_ceil(2)];
            if RegGetValueW(
                root,
                key.as_ptr(),
                name.as_ptr(),
                flags,
                null_mut(),
                buf.as_mut_ptr().cast(),
                &mut size,
            ) != ERROR_SUCCESS
            {
                return None;
            }
            let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            Some(String::from_utf16_lossy(&buf[..len]))
        }
    }
    [
        read(HKEY_CURRENT_USER, "Environment"),
        read(
            HKEY_LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(";")
}

#[cfg(not(windows))]
fn registry_path() -> String {
    String::new()
}

/// `comet` 指令已經在 PATH 裡（做過 COMET 的本機設定，也就是 `comet setup` 沒加 `--skip-local-tools`）。
/// 新專案的 COMET 設定預設不再勾「設定本機 PATH」。看 oMarker 自己的 PATH，也看登錄檔裡現在的設定。
#[tauri::command]
pub async fn comet_path_ready() -> bool {
    tauri::async_runtime::spawn_blocking(|| {
        which::which("comet").is_ok() || comet_in(&path_dirs(&registry_path()))
    })
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
    // 記住這次的位置，下次打開新專案對話框時預先帶入（寫不進去也不影響建立）。
    if let Some(file) = last_parent_file(&app) {
        let _ = file
            .parent()
            .map(fs::create_dir_all)
            .transpose()
            .and_then(|_| crate::files::write_atomic(&file, path_string(&parent).as_bytes()));
    }
    // COMET 專案接著要在這個資料夾執行一次 comet setup（見 comet.rs）。
    app.state::<crate::comet::CometRun>()
        .remember_new_project(&dir);
    Ok(crate::workspace::activate(&app, dir, &workspace, &trust))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_dirs_skip_blanks_and_quotes() {
        assert_eq!(
            path_dirs(r#"C:\Tools; "C:\Users\me\Comet\bin" ;;"#),
            vec![
                PathBuf::from(r"C:\Tools"),
                PathBuf::from(r"C:\Users\me\Comet\bin")
            ]
        );
        assert!(path_dirs("").is_empty());
    }

    #[test]
    fn comet_in_finds_the_executable() {
        let dir = std::env::temp_dir().join(format!("omarker-comet-path-{}", std::process::id()));
        let bin = dir.join("bin");
        fs::create_dir_all(&bin).unwrap();
        assert!(!comet_in(std::slice::from_ref(&bin)));
        let exe = if cfg!(windows) { "comet.exe" } else { "comet" };
        fs::write(bin.join(exe), b"").unwrap();
        assert!(comet_in(&[dir.join("missing"), bin.clone()]));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn remembered_parent_must_be_an_existing_local_folder() {
        let dir = std::env::temp_dir().join(format!("omarker-np-parent-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let text = path_string(&dir);
        assert_eq!(usable_parent(&format!("{text}\n")), Some(dir.clone()));
        // 已經刪掉的資料夾、相對路徑、網路位置都不用（改回「文件」）。
        assert_eq!(
            usable_parent(&path_string(&dir.join("沒有這個資料夾"))),
            None
        );
        assert_eq!(usable_parent("專案"), None);
        assert_eq!(usable_parent(r"\\ado.test\share\專案"), None);
        assert_eq!(usable_parent("//ado.test/share"), None);
        assert_eq!(usable_parent(""), None);
        fs::remove_dir_all(&dir).unwrap();
    }

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
    fn powershell_quotes_every_single_quote() {
        assert_eq!(
            powershell_quoted(r"C:\Users\me\comet.exe"),
            r"C:\Users\me\comet.exe"
        );
        assert_eq!(powershell_quoted("o'brien"), "o''brien");
        // PowerShell 也把這四個字元當成單引號。
        for q in ['\u{2018}', '\u{2019}', '\u{201A}', '\u{201B}'] {
            assert_eq!(
                powershell_quoted(&format!(r"C:\Users\王{q}小明\comet.exe")),
                format!(r"C:\Users\王{q}{q}小明\comet.exe")
            );
        }
        // 雙引號在單引號字串裡沒有特別的意思。
        assert_eq!(powershell_quoted("a\u{201C}b\"c"), "a\u{201C}b\"c");
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
