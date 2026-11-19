//! 專案：開過的資料夾，加上自訂名稱、顏色、群組與釘選。
//!
//! 專案清單就是信任清單裡的資料夾（`trust.rs`），這裡只提供讀取與修改的指令；
//! 開啟專案沿用 `workspace::reopen_folder`。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State, Window};

use crate::confirm::Question;
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

/// 刪除專案前要問的事：對話框的內容，以及下方「同時把資料夾移到資源回收筒」的勾選框
/// （資料夾不在了、或是系統／使用者資料夾不能移時沒有勾選框，只從清單移除）。
fn delete_question(
    dir: &Path,
    label: &str,
    exists: bool,
    system: &[PathBuf],
    open: bool,
    unsaved: bool,
    terminals: usize,
) -> (Question, Option<String>) {
    let mut lines = vec![
        path_string(dir),
        tr!("會從專案清單移除；勾選下面的選項時，資料夾和裡面所有的檔案也會移到資源回收筒（可以還原），這個專案記住的分頁會一起清掉。"),
    ];
    let can_trash = exists && !protected_folder(dir, system);
    if !can_trash {
        lines[1] = tr!("會從專案清單移除，資料夾和裡面的檔案都不會動。");
        if exists {
            lines.push(tr!(
                "「{name}」是系統或使用者資料夾，不能移到資源回收筒。",
                name = display_name(dir)
            ));
        }
    }
    if open {
        lines.push(tr!("這是目前開著的專案，會先關閉。"));
    }
    if can_trash && unsaved {
        lines.push(tr!(
            "這個專案有還沒存檔的分頁，移到資源回收筒後就找不到了。"
        ));
    }
    if can_trash && terminals > 0 {
        lines.push(tr!(
            "移到資源回收筒時，在這個資料夾開著的 {n} 個終端機會一起關閉。",
            n = terminals
        ));
    }
    let question = Question::new(tr!("刪除專案「{name}」？", name = label), lines.join("\n"));
    (
        question,
        can_trash.then(|| tr!("同時把資料夾移到資源回收筒（可以從回收筒還原）")),
    )
}

/// 使用者在系統的對話框答應了把哪個資料夾移到資源回收筒（`project_delete` 用掉一次就清掉）。
/// 網頁沒辦法代按系統的對話框，所以沒有這個答應，網頁直接呼叫 `project_delete` 也移不了資料夾。
static APPROVED: parking_lot::Mutex<Option<(PathBuf, std::time::Instant)>> =
    parking_lot::Mutex::new(None);
/// 答應之後多久內有效（中間要先關閉開著的專案，可能要先處理還沒存檔的分頁）。
const APPROVAL_TTL: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// 這個資料夾剛剛答應過移到資源回收筒（用掉就清掉）。
fn take_approval(dir: &Path) -> bool {
    let mut approved = APPROVED.lock();
    match approved.take() {
        Some((d, at)) if d == dir && at.elapsed() < APPROVAL_TTL => true,
        other => {
            *approved = other;
            false
        }
    }
}

/// 系統或使用者資料夾（不能移到資源回收筒）。
fn system_folders(app: &AppHandle) -> Vec<PathBuf> {
    use tauri::Manager;
    let p = app.path();
    [
        p.home_dir(),
        p.document_dir(),
        p.desktop_dir(),
        p.download_dir(),
        p.picture_dir(),
        p.app_data_dir(),
    ]
    .into_iter()
    .filter_map(Result::ok)
    .collect()
}

/// 刪除專案的確認：用系統的對話框問一次（網頁無法代按），「同時把資料夾移到資源回收筒」的勾選框也在裡面，
/// 預設是 `trash`（網頁記住的上次選擇）。按「刪除」時回傳勾選框的狀態（是否要移到資源回收筒），取消時回傳 None。
/// 要移到資源回收筒時記下這次的答應，接著呼叫 `project_delete` 才會移。
#[tauri::command]
pub async fn project_delete_ask(
    app: AppHandle,
    window: Window,
    path: String,
    trash: bool,
    unsaved: bool,
) -> Result<Option<bool>, String> {
    use tauri::Manager;
    let dir = PathBuf::from(&path);
    let Some(meta) = app.state::<Trust>().project(&dir) else {
        return Err(tr!("這個資料夾不在專案清單中"));
    };
    let label = ProjectInfo::from(meta).label;
    let open = app
        .state::<crate::workspace::Workspace>()
        .root()
        .is_some_and(|root| root == dir);
    let terminals = app.state::<crate::ai::term::Terminals>().count_inside(&dir);
    let (question, check) = delete_question(
        &dir,
        &label,
        dir.exists(),
        &system_folders(&app),
        open,
        unsaved,
        terminals,
    );
    let can_trash = check.is_some();
    let Some(checked) =
        crate::confirm::choose(&window, question, tr!("刪除"), check.map(|c| (c, trash))).await
    else {
        return Ok(None);
    };
    let trash = can_trash && checked;
    if trash {
        *APPROVED.lock() = Some((dir, std::time::Instant::now()));
    }
    Ok(Some(trash))
}

/// 移到資源回收筒失敗後再試幾次：剛結束的終端機、防毒軟體或搜尋索引可能還短暫占用檔案。
const TRASH_ATTEMPTS: usize = 4;

/// 把資料夾移到資源回收筒。失敗時等一下再試；最後還是失敗，多半是有程式還在使用裡面的檔案
/// （Windows 回報「Some operations were aborted」之類看不懂的訊息），改成說明可以怎麼做。
fn move_to_trash(dir: &Path) -> Result<(), String> {
    let mut last = String::new();
    for attempt in 0..TRASH_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        // 上一次其實已經移走了（例如回報錯誤前已經完成）：不必再試。
        if attempt > 0 && !dir.exists() {
            return Ok(());
        }
        match trash::delete(dir) {
            Ok(()) => return Ok(()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(tr!(
        "無法把資料夾移到資源回收筒，通常是資料夾或裡面的檔案還有程式在使用（例如檔案總管、VS Code、Codex 或命令提示字元）。請關閉這些程式後再試一次；也可以取消勾選「同時把資料夾移到資源回收筒」，只從清單移除。（{e}）",
        e = last
    ))
}

/// 刪除專案：從專案清單移除；`trash_folder` 時把整個資料夾移到資源回收筒（可以從回收筒還原）。
/// 只能刪專案清單上的資料夾；目前開著的專案要先關閉。沒有資源回收筒（例如網路磁碟）時回報錯誤，
/// 不會改成直接刪除。移到資源回收筒前要先用 `project_delete_ask` 在系統的對話框答應過（網頁無法代按）。
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
    let open = app
        .state::<crate::workspace::Workspace>()
        .root()
        .is_some_and(|root| root == dir);
    if open {
        return Err(tr!("請先關閉這個專案再刪除"));
    }
    if trash_folder && dir.exists() {
        if protected_folder(&dir, &system_folders(&app)) {
            return Err(tr!(
                "「{name}」是系統或使用者資料夾，不能移到資源回收筒；可以只從清單移除",
                name = display_name(&dir)
            ));
        }
        if !take_approval(&dir) {
            return Err(tr!(
                "要先在確認的對話框按「刪除」，才能把資料夾移到資源回收筒"
            ));
        }
        // 在這個資料夾啟動的終端機先結束，否則 Windows 不讓資料夾移走。
        app.state::<crate::ai::term::Terminals>().kill_inside(&dir);
        let d = dir.clone();
        // 很大的資料夾移到回收筒要一點時間。
        crate::io::blocking_for(std::time::Duration::from_secs(300), move || {
            move_to_trash(&d)
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

/// 網址參數裡的路徑：只留英數字與 `-_.~`，其他字元（含中文、`\`、`:`、空白）都用 UTF-8 的 %XX 編碼。
/// 「傳給 ChatGPT」帶的文字也用這個（見 `chatgpt.rs`）。
pub(crate) fn encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// 在 Codex 桌面版開啟的網址：`codex://threads/new?path=<路徑>`，Codex 會開一個新對話，工作區就是這個資料夾。
fn codex_url(path: &str) -> String {
    format!("codex://threads/new?path={}", encode_path(path))
}

/// 在 Claude 桌面版的 Claude Code 開啟的網址：`claude://code/new?folder=<路徑>`
/// （Claude 說明中心的「Open Claude Desktop with a link」）。從連結帶來的資料夾，Claude 一律先跳出確認對話框才使用。
/// 說明沒有寫 Windows 路徑的格式，所以和 Codex 一樣整段編碼。
fn claude_url(path: &str) -> String {
    format!("claude://code/new?folder={}", encode_path(path))
}

/// 在 AI 桌面版（`name`）開啟專案。只接受專案清單裡的本機資料夾（遠端資料夾桌面版打不開）；
/// 交給系統開啟 `url(資料夾)`，沒有安裝桌面版時由系統提示要用哪個程式開啟。
fn open_in_app(
    app: &AppHandle,
    trust: &Trust,
    path: &str,
    name: &str,
    url: fn(&str) -> String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = PathBuf::from(path);
    if trust.project(&dir).is_none() {
        return Err(tr!("這個資料夾不在專案清單中"));
    }
    if crate::dav::is_remote_path(path) || !dir.is_absolute() {
        return Err(tr!("遠端資料夾不能在 {app} 開啟", app = name));
    }
    app.opener()
        .open_url(url(&path_string(&dir)), None::<&str>)
        .map_err(|e| {
            tr!(
                "無法開啟 {app} 桌面版（請確認已經安裝）：{e}",
                app = name,
                e = e
            )
        })
}

/// 在 Codex 桌面版開啟專案（`codex://`）。
#[tauri::command]
pub fn project_open_codex(
    app: AppHandle,
    trust: State<'_, Trust>,
    path: String,
) -> Result<(), String> {
    open_in_app(&app, &trust, &path, "Codex", codex_url)
}

/// 在 Claude 桌面版的 Claude Code 開啟專案（`claude://`）。
#[tauri::command]
pub fn project_open_claude(
    app: AppHandle,
    trust: State<'_, Trust>,
    path: String,
) -> Result<(), String> {
    open_in_app(&app, &trust, &path, "Claude", claude_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delete_question_offers_the_recycle_bin_only_when_possible() {
        let system = [PathBuf::from("/home/me")];
        let dir = Path::new("/home/me/Documents/產品筆記");
        let (q, check) = delete_question(dir, "產品", true, &system, false, false, 0);
        assert_eq!(q.title, "刪除專案「產品」？");
        assert!(q.message.contains(&path_string(dir)), "{}", q.message);
        assert!(check.is_some_and(|c| c.contains("資源回收筒")));
        assert!(!q.message.contains("終端機"), "{}", q.message);
        // 開著的專案、沒存檔的分頁、終端機：都寫在內容裡。
        let (q, _) = delete_question(dir, "產品", true, &system, true, true, 2);
        assert!(q.message.contains("會先關閉"), "{}", q.message);
        assert!(q.message.contains("還沒存檔"), "{}", q.message);
        assert!(q.message.contains("2 個終端機會一起關閉"), "{}", q.message);
        // 資料夾已經不在了：沒有東西要移，沒有勾選框。
        let (q, check) = delete_question(dir, "產品", false, &system, false, true, 2);
        assert!(check.is_none());
        assert!(!q.message.contains("還沒存檔"), "{}", q.message);
        // 系統資料夾不能移：沒有勾選框，說明原因。
        let (q, check) =
            delete_question(Path::new("/home"), "home", true, &system, false, false, 0);
        assert!(check.is_none());
        assert!(q.message.contains("不能移到資源回收筒"), "{}", q.message);
    }

    #[test]
    fn approval_is_for_one_folder_and_used_once() {
        let a = PathBuf::from("/home/me/Documents/產品");
        let b = PathBuf::from("/home/me/Documents/Contoso");
        *APPROVED.lock() = Some((a.clone(), std::time::Instant::now()));
        assert!(!take_approval(&b), "答應的是別的資料夾");
        assert!(take_approval(&a));
        assert!(!take_approval(&a), "用過一次就沒了");
    }

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
        let dir = std::env::temp_dir().join(format!("omarker-comet-badge-{}", std::process::id()));
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

    #[test]
    fn claude_url_encodes_the_folder() {
        assert_eq!(
            claude_url(r"C:\Users\me\產品 筆記"),
            "claude://code/new?folder=C%3A%5CUsers%5Cme%5C%E7%94%A2%E5%93%81%20%E7%AD%86%E8%A8%98"
        );
        // 說明中心的範例：/Users/me/repo → %2FUsers%2Fme%2Frepo
        assert_eq!(
            claude_url("/Users/me/repo"),
            "claude://code/new?folder=%2FUsers%2Fme%2Frepo"
        );
        assert_eq!(
            claude_url("/home/me/a&b?c#d+e=f"),
            "claude://code/new?folder=%2Fhome%2Fme%2Fa%26b%3Fc%23d%2Be%3Df"
        );
    }
}
