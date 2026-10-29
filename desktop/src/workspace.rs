//! 資料夾工作區：開啟資料夾、列出檔案、新增／改名／刪除、全文搜尋。
//!
//! 所有路徑都必須位於目前開啟的工作區內；前端傳來的路徑一律先檢查。

use std::cmp::Ordering;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::Mutex;
use std::time::Duration;

use grep_regex::RegexMatcherBuilder;
use grep_searcher::{sinks::UTF8, BinaryDetection, SearcherBuilder};
use ignore::WalkBuilder;
use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::files::{display_name, path_string, KnownFiles};
use crate::trust::Trust;
use crate::watch::Watcher;

/// 編輯器能開啟的副檔名（檔案樹、Ctrl+P、搜尋只列出這些）。
#[rustfmt::skip]
pub const DOC_EXTENSIONS: &[&str] = &[
    // 文件
    "md", "markdown", "mdown", "mkd", "txt", "text", "log",
    // 資料與設定
    "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "env", "csv", "tsv", "xml",
    // 網頁
    "html", "htm", "css", "scss", "sass", "less", "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue",
    "svelte",
    // 程式碼
    "py", "rb", "php", "java", "kt", "kts", "scala", "groovy", "gradle", "go", "rs", "c", "h", "cpp", "cc",
    "cxx", "hpp", "hh", "cs", "fs", "vb", "swift", "m", "mm", "dart", "lua", "pl", "r", "jl", "sql",
    "graphql", "proto", "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd", "tex", "bib",
];
/// 沒有副檔名、但也是文字檔的常見檔名（比對時不分大小寫）。
const DOC_FILE_NAMES: &[&str] = &["dockerfile", "makefile", "license", "readme", "changelog"];
/// Ctrl+P 與搜尋最多處理的檔案數，避免誤開整個磁碟時卡住。
const MAX_FILES: usize = 20_000;
const MAX_MATCHES: usize = 2_000;
const MAX_LINE_CHARS: usize = 240;

#[derive(Default)]
pub struct Workspace(Mutex<Option<PathBuf>>);

impl Workspace {
    pub fn root(&self) -> Option<PathBuf> {
        self.0.lock().unwrap().clone()
    }

    /// 改開遠端（WebDAV）工作區時關閉本機工作區。
    pub fn clear(&self) {
        *self.0.lock().unwrap() = None;
    }

    pub fn contains(&self, path: &Path) -> bool {
        self.root()
            .is_some_and(|root| resolve_inside(&root, path).is_ok())
    }

    pub(crate) fn require_root(&self) -> Result<PathBuf, String> {
        self.root().ok_or_else(|| tr!("還沒有開啟資料夾"))
    }
}

pub fn is_doc(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(e) => DOC_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()),
        None => path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| DOC_FILE_NAMES.contains(&n.to_ascii_lowercase().as_str())),
    }
}

/// 解析符號連結後的實際位置（檔案可以還不存在：往上找到第一個存在的資料夾解析，再接上其餘部分）。
pub fn real_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(tr!("路徑無效"));
    }
    let mut existing = path;
    let mut rest = Vec::new();
    while !existing.exists() {
        rest.push(existing.file_name().ok_or_else(|| tr!("路徑無效"))?);
        existing = existing.parent().ok_or_else(|| tr!("路徑無效"))?;
    }
    let mut real = dunce::canonicalize(existing)
        .map_err(|e| crate::io::describe(&e, &tr!("無法存取這個位置")))?;
    for part in rest.into_iter().rev() {
        real.push(part);
    }
    Ok(real)
}

/// 項目本身的實際位置：上層資料夾解析符號連結，最後一段保持原樣
/// （項目本身是符號連結時，指的是連結，不是它指向的地方）。
fn entry_location(path: &Path) -> Option<PathBuf> {
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => dunce::canonicalize(parent).ok().map(|p| p.join(name)),
        _ => dunce::canonicalize(path).ok(),
    }
}

/// 檢查要改名或刪除的項目：項目本身的位置（上層資料夾解析符號連結，最後一段保持原樣）
/// 必須在工作區內，而且不是工作區資料夾本身（大小寫不同、結尾多了 `\.` 也認得出來）。
fn check_entry(root: &Path, path: &Path, root_message: &str) -> Result<(), String> {
    let real_root =
        dunce::canonicalize(root).map_err(|e| crate::io::describe(&e, &tr!("無法存取資料夾")))?;
    let entry = entry_location(path).ok_or_else(|| tr!("路徑無效"))?;
    if path == root || entry == real_root {
        Err(root_message.into())
    } else if !entry.starts_with(&real_root) {
        Err(tr!("只能存取目前開啟的資料夾內的檔案"))
    } else {
        Ok(())
    }
}

/// 確認 `path` 位於 `root` 之內（檔案可以還不存在，例如新增時）。
pub fn resolve_inside(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let real = real_path(path)?;
    let root =
        dunce::canonicalize(root).map_err(|e| crate::io::describe(&e, &tr!("無法存取資料夾")))?;
    if real.starts_with(&root) {
        Ok(path.to_path_buf())
    } else {
        Err(tr!("只能存取目前開啟的資料夾內的檔案"))
    }
}

/// 檢查使用者輸入的檔名（不可含路徑或 Windows 不允許的字元）。
pub fn validate_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return Err(tr!("請輸入名稱"));
    }
    if let Some(c) = name.chars().find(|c| {
        matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control()
    }) {
        return Err(tr!("名稱不能包含「{c}」", c = c));
    }
    if name.ends_with('.') {
        return Err(tr!("名稱不能以「.」結尾"));
    }
    Ok(name)
}

/// 自然排序：資料夾在前；「第2章」排在「第10章」前面；不分大小寫。
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut ai, mut bi) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ai.peek(), bi.peek()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut s = String::new();
                    while let Some(c) = it.peek().filter(|c| c.is_ascii_digit()) {
                        s.push(*c);
                        it.next();
                    }
                    s
                };
                let (na, nb) = (take(&mut ai), take(&mut bi));
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                let ord = x.to_lowercase().cmp(y.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                ai.next();
                bi.next();
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    /// 滑鼠停留時顯示的資訊（遠端檔案的大小、權限、修改時間）。
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

impl Entry {
    pub fn new(name: String, path: String, is_dir: bool) -> Self {
        Entry {
            name,
            path,
            is_dir,
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: Option<String>) -> Self {
        self.detail = detail;
        self
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn is_dir(&self) -> bool {
        self.is_dir
    }
}

/// 依 .gitignore 規則、略過隱藏檔的走訪器。
pub(crate) fn walker(dir: &Path) -> WalkBuilder {
    let mut b = WalkBuilder::new(dir);
    b.hidden(true)
        .git_ignore(true)
        .git_global(false)
        .require_git(false)
        .follow_links(false);
    b.filter_entry(|e| e.file_name() != "node_modules");
    b
}

fn list_children(dir: &Path) -> Vec<Entry> {
    let mut entries: Vec<Entry> = walker(dir)
        .max_depth(Some(1))
        .build()
        .filter_map(Result::ok)
        .filter(|e| e.depth() == 1)
        .filter_map(|e| {
            let is_dir = e.file_type()?.is_dir();
            (is_dir || is_doc(e.path())).then(|| Entry {
                name: e.file_name().to_string_lossy().into_owned(),
                path: path_string(e.path()),
                is_dir,
                detail: None,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| natural_cmp(&a.name, &b.name))
    });
    entries
}

#[derive(Serialize, Clone)]
pub struct FolderInfo {
    path: String,
    name: String,
}

impl FolderInfo {
    pub fn new(path: String, name: String) -> Self {
        FolderInfo { path, name }
    }
}

fn activate(app: &AppHandle, root: PathBuf, workspace: &Workspace, trust: &Trust) -> FolderInfo {
    *workspace.0.lock().unwrap() = Some(root.clone());
    app.state::<crate::dav::Dav>().disconnect();
    trust.add_folder(app, &root);
    // 網路磁碟的監看要先掃描整個資料夾，可能很久，放在背景進行。
    let app2 = app.clone();
    let root2 = root.clone();
    std::thread::spawn(move || {
        app2.state::<Watcher>().watch_workspace(&app2, &root2);
    });
    FolderInfo {
        name: display_name(&root),
        path: path_string(&root),
    }
}

/// 跳出選擇資料夾的對話框並設為工作區。
#[tauri::command]
pub async fn open_folder(
    app: AppHandle,
    window: WebviewWindow,
    workspace: State<'_, Workspace>,
    trust: State<'_, Trust>,
) -> Result<Option<FolderInfo>, String> {
    let picked = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title(tr!("開啟資料夾"))
        .pick_folder()
        .await;
    Ok(picked.map(|h| activate(&app, h.path().to_path_buf(), &workspace, &trust)))
}

/// 重新開啟最近使用過的資料夾（只允許信任清單中的資料夾）。
#[tauri::command]
pub async fn reopen_folder(
    app: AppHandle,
    path: String,
    workspace: State<'_, Workspace>,
    trust: State<'_, Trust>,
) -> Result<FolderInfo, String> {
    let path = PathBuf::from(path);
    if !trust.allows_folder(&path) {
        return Err(tr!("這個資料夾不在最近開啟的清單中"));
    }
    let p = path.clone();
    let exists = crate::io::blocking(move || match fs::metadata(&p) {
        Ok(m) => Ok(m.is_dir()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(crate::io::describe(&e, &tr!("無法開啟資料夾"))),
    })
    .await?;
    if !exists {
        // 釘選或有群組的專案留在清單上，讓使用者重新指定位置（例如網路磁碟還沒接上）。
        if trust.project(&path).is_some_and(|m| m.kept()) {
            return Err(tr!(
                "找不到資料夾「{path}」。如果搬到別的地方了，可以在專案總覽重新指定位置",
                path = path.display()
            ));
        }
        trust.remove(&app, &path);
        return Err(tr!(
            "找不到資料夾「{path}」，可能已被移動或刪除",
            path = path.display()
        ));
    }
    Ok(activate(&app, path, &workspace, &trust))
}

/// 關閉目前的專案（本機資料夾或遠端資料夾）：停止監看，之後的檔案操作都要先開啟資料夾。
#[tauri::command]
pub fn close_folder(app: AppHandle, workspace: State<'_, Workspace>) {
    workspace.clear();
    app.state::<Watcher>().stop_workspace();
    app.state::<crate::dav::Dav>().disconnect();
}

/// 以命令列帶入的資料夾開啟工作區（例如把資料夾拖到 exe 上）。
pub fn open_folder_from_cli(app: &AppHandle, path: PathBuf) -> FolderInfo {
    activate(app, path, &app.state::<Workspace>(), &app.state::<Trust>())
}

#[tauri::command]
pub fn current_folder(workspace: State<'_, Workspace>) -> Option<FolderInfo> {
    workspace.root().map(|root| FolderInfo {
        name: display_name(&root),
        path: path_string(&root),
    })
}

#[tauri::command]
pub fn recent(trust: State<'_, Trust>) -> crate::trust::Recent {
    trust.snapshot()
}

/// 自動完成連結時讀取另一份文件的標題用：只能讀工作區內的文件，不記錄任何狀態
/// （不會影響該檔案的存檔衝突判斷）。
pub const PEEK_LIMIT: u64 = 5 * 1024 * 1024;

#[tauri::command]
pub async fn peek_text(app: AppHandle, path: String) -> Result<String, String> {
    crate::io::blocking(move || {
        let root = app.state::<Workspace>().require_root()?;
        let real = resolve_inside(&root, Path::new(&path))?;
        if !is_doc(&real) {
            return Err(tr!("只能讀取文件"));
        }
        let size = fs::metadata(&real)
            .map_err(|e| crate::io::describe(&e, &tr!("無法讀取")))?
            .len();
        if size > PEEK_LIMIT {
            return Err(tr!("檔案太大"));
        }
        let bytes = fs::read(&real).map_err(|e| crate::io::describe(&e, &tr!("無法讀取")))?;
        if crate::files::not_text_reason(&bytes).is_some() {
            return Err(tr!("不是文字檔"));
        }
        Ok(crate::files::decode(&bytes).0)
    })
    .await
}

/// 列出資料夾的直接子項目（資料夾在前，只列出可開啟的文件）。
#[tauri::command]
pub async fn list_dir(app: AppHandle, path: String) -> Result<Vec<Entry>, String> {
    crate::io::blocking(move || {
        let root = app.state::<Workspace>().require_root()?;
        let dir = resolve_inside(&root, Path::new(&path))?;
        // 先確認讀得到（列出內容時會略過個別項目的錯誤，斷線時要明確回報）。
        fs::read_dir(&dir).map_err(|e| crate::io::describe(&e, &tr!("無法讀取資料夾")))?;
        Ok(list_children(&dir))
    })
    .await
}

#[derive(Serialize)]
pub struct FileItem {
    path: String,
    /// 相對於工作區的路徑，以 `/` 分隔，給 Ctrl+P 顯示與比對。
    rel: String,
}

impl FileItem {
    pub fn new(path: String, rel: String) -> Self {
        FileItem { path, rel }
    }
}

pub(crate) fn rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// 工作區中所有可開啟的文件（給 Ctrl+P 快速開啟）。
#[tauri::command]
pub async fn list_files(workspace: State<'_, Workspace>) -> Result<Vec<FileItem>, String> {
    let root = workspace.require_root()?;
    // 網路磁碟斷線時不要永遠等下去。
    crate::io::blocking_for(Duration::from_secs(60), move || {
        Ok(walker(&root)
            .build()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_some_and(|t| t.is_file()) && is_doc(e.path()))
            .take(MAX_FILES)
            .map(|e| FileItem {
                rel: rel_path(&root, e.path()),
                path: path_string(e.path()),
            })
            .collect())
    })
    .await
}

/// 新增檔案或資料夾；檔案會建立成空白檔。回傳新路徑。
#[tauri::command]
pub async fn create_entry(
    app: AppHandle,
    parent: String,
    name: String,
    is_dir: bool,
) -> Result<String, String> {
    crate::io::blocking(move || create_entry_now(&app, &parent, &name, is_dir)).await
}

fn create_entry_now(
    app: &AppHandle,
    parent: &str,
    name: &str,
    is_dir: bool,
) -> Result<String, String> {
    let root = app.state::<Workspace>().require_root()?;
    let parent = resolve_inside(&root, Path::new(parent))?;
    let target = parent.join(validate_name(name)?);
    if target.exists() {
        return Err(tr!("「{name}」已經存在", name = display_name(&target)));
    }
    if is_dir {
        fs::create_dir(&target)
    } else {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map(|_| ())
    }
    .map_err(|e| {
        crate::io::describe(&e, &tr!("無法建立「{name}」", name = display_name(&target)))
    })?;
    Ok(path_string(&target))
}

/// 在工作區的 `.github/workflows/` 建立一個 GitHub Actions 工作流程檔。已經存在時不覆蓋。
#[tauri::command]
pub async fn create_workflow(app: AppHandle, name: String, text: String) -> Result<String, String> {
    crate::io::blocking(move || {
        let root = app.state::<Workspace>().require_root()?;
        let name = validate_name(&name)?;
        if !name.ends_with(".yml") {
            return Err(tr!("工作流程檔名必須是 .yml"));
        }
        let dir = root.join(".github").join("workflows");
        let target = dir.join(name);
        // `.github` 或 `workflows` 可能是指向工作區外的符號連結：建立前後都確認實際位置。
        resolve_inside(&root, &target)?;
        if target.exists() {
            return Err(tr!(
                "「.github/workflows/{name}」已經存在，沒有覆蓋",
                name = name
            ));
        }
        fs::create_dir_all(&dir)
            .map_err(|e| crate::io::describe(&e, &tr!("無法建立 .github/workflows 資料夾")))?;
        resolve_inside(&root, &target)?;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    tr!(
                        "「.github/workflows/{name}」已經存在，沒有覆蓋",
                        name = name
                    )
                } else {
                    crate::io::describe(&e, &tr!("無法寫入工作流程檔"))
                }
            })?;
        std::io::Write::write_all(&mut f, text.as_bytes())
            .map_err(|e| crate::io::describe(&e, &tr!("無法寫入工作流程檔")))?;
        Ok(path_string(&target))
    })
    .await
}

/// 重新命名（同一個資料夾內）。已開啟的檔案會沿用原本的狀態。
#[tauri::command]
pub async fn rename_entry(
    app: AppHandle,
    path: String,
    new_name: String,
) -> Result<String, String> {
    crate::io::blocking(move || rename_entry_now(&app, &path, &new_name)).await
}

fn rename_entry_now(app: &AppHandle, path: &str, new_name: &str) -> Result<String, String> {
    let root = app.state::<Workspace>().require_root()?;
    let from = resolve_inside(&root, Path::new(path))?;
    check_entry(&root, &from, &tr!("不能重新命名工作區資料夾本身"))?;
    let to = from
        .parent()
        .ok_or_else(|| tr!("路徑無效"))?
        .join(validate_name(new_name)?);
    // 只改大小寫時（Windows 不分大小寫），目標「存在」其實就是自己。
    let same_file = from.to_string_lossy().to_lowercase() == to.to_string_lossy().to_lowercase();
    if to.exists() && !same_file {
        return Err(tr!("「{name}」已經存在", name = display_name(&to)));
    }
    fs::rename(&from, &to).map_err(|e| crate::io::describe(&e, &tr!("無法重新命名")))?;
    app.state::<KnownFiles>().rename(&from, &to);
    crate::history::on_rename(app, &from, &to);
    app.state::<Trust>().rename(app, &from, &to);
    Ok(path_string(&to))
}

/// 移到資源回收筒（可以從回收筒還原）。
#[tauri::command]
pub async fn trash_entry(app: AppHandle, path: String) -> Result<(), String> {
    crate::io::blocking(move || {
        let root = app.state::<Workspace>().require_root()?;
        let path = resolve_inside(&root, Path::new(&path))?;
        check_entry(&root, &path, &tr!("不能刪除工作區資料夾本身"))?;
        // 網路磁碟上的檔案通常沒有資源回收筒，系統會回報錯誤。
        trash::delete(&path).map_err(|e| tr!("無法移到資源回收筒：{e}", e = e))?;
        app.state::<Trust>().remove(&app, &path);
        Ok(())
    })
    .await
}

/// 在檔案總管中顯示。
#[tauri::command]
pub async fn reveal_entry(app: AppHandle, path: String) -> Result<(), String> {
    crate::io::blocking(move || reveal_now(&app, &path)).await
}

fn reveal_now(app: &AppHandle, path: &str) -> Result<(), String> {
    let root = app.state::<Workspace>().require_root()?;
    let path = resolve_inside(&root, Path::new(path))?;
    reveal_path(&path)
}

/// 在檔案總管中選取 `path`（呼叫端要先確認可以讓使用者看這個位置）。
pub(crate) fn reveal_path(path: &Path) -> Result<(), String> {
    // explorer 不接受整個被引號包住的 `"/select,路徑"`（Rust 遇到空白會自動加引號），
    // 所以自己組參數，只把路徑放進引號。用完整路徑啟動，免得執行到放在本程式旁邊的同名程式。
    #[cfg(target_os = "windows")]
    let result = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new(crate::io::system_root().join("explorer.exe"))
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn()
    };
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let result = std::process::Command::new("xdg-open")
        .arg(path.parent().unwrap_or(path))
        .spawn();
    result
        .map(|_| ())
        .map_err(|e| tr!("無法開啟檔案總管：{e}", e = e))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    line: u64,
    text: String,
    /// 符合位置（以 UTF-16 計算，和 JavaScript 字串一致），相對於 `text`。
    ranges: Vec<(usize, usize)>,
    /// 第一個符合位置在原始行中的欄位（從 1 開始，UTF-16），給跳行使用。
    column: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    path: String,
    rel: String,
    matches: Vec<LineMatch>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    files: Vec<FileMatches>,
    total: usize,
    /// 結果太多而被截斷。
    truncated: bool,
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// 把一行文字縮短到第一個符合處附近，並換算符合範圍。
fn excerpt(line: &str, byte_ranges: &[(usize, usize)]) -> (String, Vec<(usize, usize)>, usize) {
    let line = line.trim_end_matches(['\r', '\n']);
    let first = byte_ranges.first().map_or(0, |r| r.0);
    let column = utf16_len(&line[..first]) + 1;
    // 從第一個符合處往前保留一些文字。
    let mut start = 0;
    let before = line[..first].chars().count();
    if before > 40 {
        start = line[..first]
            .char_indices()
            .nth(before - 30)
            .map_or(0, |(i, _)| i);
    }
    let mut text: String = line[start..].chars().take(MAX_LINE_CHARS).collect();
    let end = start + text.len();
    let ranges = byte_ranges
        .iter()
        .filter(|(s, e)| *s >= start && *e <= end)
        .map(|(s, e)| (utf16_len(&line[start..*s]), utf16_len(&line[start..*e])))
        .collect();
    if start > 0 {
        text.insert(0, '…');
    }
    let shift = usize::from(start > 0);
    let ranges = shift_ranges(ranges, shift);
    (text, ranges, column)
}

fn shift_ranges(ranges: Vec<(usize, usize)>, by: usize) -> Vec<(usize, usize)> {
    ranges.into_iter().map(|(s, e)| (s + by, e + by)).collect()
}

/// 在指定資料夾中搜尋文字（遵守 .gitignore，只搜尋文件檔）。
/// `cancelled()` 回傳 true 時停下來，回傳空的結果（已經有新的搜尋了）。
/// 用多個執行緒同時走訪、搜尋（大資料夾快很多），結果依相對路徑排序。
pub fn search_dir(
    root: &Path,
    query: &str,
    case_sensitive: bool,
    regex: bool,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<SearchResult, String> {
    let empty = || SearchResult {
        files: vec![],
        total: 0,
        truncated: false,
    };
    if query.is_empty() {
        return Ok(empty());
    }
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!case_sensitive)
        .fixed_strings(!regex)
        .build(query)
        .map_err(|e| tr!("搜尋條件無效：{e}", e = e))?;
    let files = Mutex::new(Vec::new());
    let total = std::sync::atomic::AtomicUsize::new(0);
    let truncated = std::sync::atomic::AtomicBool::new(false);
    walker(root).build_parallel().run(|| {
        // 副檔名對但內容是二進位的檔案（例如損壞或改錯副檔名）直接略過。
        let mut searcher = SearcherBuilder::new()
            .line_number(true)
            .binary_detection(BinaryDetection::quit(0))
            .build();
        let matcher = matcher.clone();
        let (files, total, truncated) = (&files, &total, &truncated);
        Box::new(move |entry| {
            use ignore::WalkState;
            if cancelled() || truncated.load(AtomicOrdering::Relaxed) {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            if !entry.file_type().is_some_and(|t| t.is_file()) || !is_doc(entry.path()) {
                return WalkState::Continue;
            }
            let mut matches = Vec::new();
            let _ = searcher.search_path(
                &matcher,
                entry.path(),
                UTF8(|line_number, line| {
                    use grep_matcher::Matcher;
                    let mut ranges = Vec::new();
                    matcher.find_iter(line.as_bytes(), |m| {
                        ranges.push((m.start(), m.end()));
                        true
                    })?;
                    let (text, ranges, column) = excerpt(line, &ranges);
                    matches.push(LineMatch {
                        line: line_number,
                        text,
                        ranges,
                        column,
                    });
                    let so_far = total.load(AtomicOrdering::Relaxed) + matches.len();
                    Ok(so_far < MAX_MATCHES && !cancelled())
                }),
            );
            if matches.is_empty() {
                return WalkState::Continue;
            }
            let n = total.fetch_add(matches.len(), AtomicOrdering::Relaxed) + matches.len();
            files.lock().unwrap().push(FileMatches {
                rel: rel_path(root, entry.path()),
                path: path_string(entry.path()),
                matches,
            });
            if n >= MAX_MATCHES {
                truncated.store(true, AtomicOrdering::Relaxed);
                return WalkState::Quit;
            }
            WalkState::Continue
        })
    });
    if cancelled() {
        return Ok(empty());
    }
    let mut files = files.into_inner().unwrap();
    files.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(SearchResult {
        files,
        total: total.into_inner(),
        truncated: truncated.into_inner(),
    })
}

#[tauri::command]
pub async fn search(
    query: String,
    case_sensitive: bool,
    regex: bool,
    workspace: State<'_, Workspace>,
) -> Result<SearchResult, String> {
    let root = workspace.require_root()?;
    // 邊打字邊搜尋時，舊的搜尋還沒做完就有新的：舊的停下來，不要在背景越積越多。
    let id = SEARCH_GEN.fetch_add(1, AtomicOrdering::SeqCst) + 1;
    let cancelled = move || SEARCH_GEN.load(AtomicOrdering::SeqCst) != id;
    crate::io::blocking_for(SEARCH_TIMEOUT, move || {
        search_dir(&root, &query, case_sensitive, regex, &cancelled)
    })
    .await
}

/// 每次搜尋的編號（見 `search`）。
static SEARCH_GEN: AtomicU64 = AtomicU64::new(0);
/// 大資料夾、網路磁碟上的搜尋可能要一陣子，但斷線時不要永遠等下去。
const SEARCH_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    /// 改了幾個檔案、幾處。
    files: usize,
    replacements: usize,
    /// 有未存檔變更而略過的檔案。
    skipped: Vec<String>,
    /// 無法處理的檔案（不是 UTF-8、寫入失敗等）與原因。
    failed: Vec<String>,
}

/// 在工作區的所有文件中取代文字。和搜尋用同樣的檔案範圍與條件；正規表示式模式下可以用 `$1` 引用群組。
/// `skip` 是編輯器中有未存檔變更的檔案，不碰它們。`on_write` 在每個檔案寫入前呼叫（記錄版本用）。
pub fn replace_dir(
    root: &Path,
    query: &str,
    replacement: &str,
    case_sensitive: bool,
    regex: bool,
    skip: &[PathBuf],
    mut on_write: impl FnMut(&Path, &[u8], &str),
) -> Result<ReplaceResult, String> {
    if query.is_empty() {
        return Err(tr!("請輸入要取代的文字"));
    }
    let pattern = if regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let re = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .multi_line(true)
        .build()
        .map_err(|e| tr!("搜尋條件無效：{e}", e = e))?;
    let mut result = ReplaceResult::default();
    for entry in walker(root).build().filter_map(Result::ok) {
        let path = entry.path();
        if !entry.file_type().is_some_and(|t| t.is_file()) || !is_doc(path) {
            continue;
        }
        let bytes = match crate::files::read_capped(path, crate::files::MAX_OPEN_BYTES) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => {
                result
                    .failed
                    .push(tr!("{name}：檔案太大，已略過", name = display_name(path)));
                continue;
            }
            Err(_) => {
                result
                    .failed
                    .push(tr!("{name}：無法讀取", name = display_name(path)));
                continue;
            }
        };
        // 內容不是文字（例如副檔名改錯的二進位檔）時不動它，避免取代後把檔案弄壞。
        if crate::files::not_text_reason(&bytes).is_some() {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else {
            if re.is_match(&String::from_utf8_lossy(&bytes)) {
                result.failed.push(tr!(
                    "{name}：不是 UTF-8 編碼，請先開啟並存檔",
                    name = display_name(path)
                ));
            }
            continue;
        };
        let count = re.find_iter(text).count();
        if count == 0 {
            continue;
        }
        if skip.iter().any(|s| s == path) {
            result.skipped.push(path_string(path));
            continue;
        }
        let next = if regex {
            re.replace_all(text, replacement)
        } else {
            re.replace_all(text, regex::NoExpand(replacement))
        };
        on_write(path, &bytes, &next);
        match crate::files::write_atomic(path, next.as_bytes()) {
            Ok(()) => {
                result.files += 1;
                result.replacements += count;
            }
            Err(e) => result.failed.push(tr!(
                "{name}：{e}",
                name = display_name(path),
                e = crate::io::describe(&e, &tr!("無法寫入"))
            )),
        }
    }
    Ok(result)
}

/// 資料夾全文取代。寫入前把原本的內容記到版本記錄，可以從「版本記錄」還原。
#[tauri::command]
pub async fn replace_in_folder(
    app: AppHandle,
    query: String,
    replacement: String,
    case_sensitive: bool,
    regex: bool,
    skip: Vec<String>,
) -> Result<ReplaceResult, String> {
    let root = app.state::<Workspace>().require_root()?;
    let skip: Vec<PathBuf> = skip.into_iter().map(PathBuf::from).collect();
    tauri::async_runtime::spawn_blocking(move || {
        replace_dir(
            &root,
            &query,
            &replacement,
            case_sensitive,
            regex,
            &skip,
            |path, before, after| {
                crate::history::on_save(&app, path, Some(before), after);
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_ws(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("md-ws-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("第2章")).unwrap();
        fs::create_dir_all(dir.join("第10章")).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(dir.join("README.md"), "# 標題\n\n季度報告的內容\n").unwrap();
        fs::write(dir.join("第2章/筆記.md"), "第一行\n這份季度報告很重要\n").unwrap();
        fs::write(dir.join("圖片.png"), b"\x89PNG").unwrap();
        fs::write(dir.join("node_modules/x.md"), "季度報告").unwrap();
        fs::write(dir.join("略過.md"), "季度報告").unwrap();
        fs::write(dir.join(".gitignore"), "略過.md\n").unwrap();
        dir
    }

    #[test]
    fn recognizes_text_files_by_extension_or_name() {
        for name in [
            "a.md",
            "設定.YAML",
            "資料.csv",
            "index.html",
            "main.rs",
            "app.tsx",
            "Dockerfile",
        ] {
            assert!(is_doc(Path::new(name)), "{name}");
        }
        for name in [
            "圖片.png",
            "封裝.zip",
            "程式.exe",
            "報告.docx",
            "沒有副檔名",
        ] {
            assert!(!is_doc(Path::new(name)), "{name}");
        }
    }

    #[test]
    fn search_skips_binary_files_with_text_extensions() {
        let dir = std::env::temp_dir().join(format!("md-ws-binary-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("壞掉.txt"), "\0\0\0季度報告").unwrap();
        fs::write(dir.join("正常.txt"), "季度報告").unwrap();
        let found = search_dir(&dir, "季度報告", false, false, &|| false).unwrap();
        let names: Vec<_> = found.files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(names, ["正常.txt"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn lists_docs_and_folders_in_natural_order() {
        let dir = temp_ws("list");
        let names: Vec<String> = list_children(&dir).into_iter().map(|e| e.name).collect();
        assert_eq!(names, ["第2章", "第10章", "README.md"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_paths_outside_the_workspace() {
        let dir = temp_ws("scope");
        assert!(resolve_inside(&dir, &dir.join("第2章/筆記.md")).is_ok());
        assert!(
            resolve_inside(&dir, &dir.join("新檔案.md")).is_ok(),
            "尚未存在的檔案也可以"
        );
        assert!(resolve_inside(&dir, &dir.join("../別處.md")).is_err());
        assert!(resolve_inside(&dir, Path::new("相對路徑.md")).is_err());
        assert!(resolve_inside(&dir, &std::env::temp_dir()).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rename_and_trash_targets_stay_inside() {
        let dir = temp_ws("entry");
        let root_msg = "工作區本身";
        assert_eq!(check_entry(&dir, &dir, root_msg), Err(root_msg.into()));
        assert_eq!(
            check_entry(&dir, &dir.join("."), root_msg),
            Err(root_msg.into())
        );
        assert!(check_entry(&dir, &dir.join("README.md"), root_msg).is_ok());
        #[cfg(unix)]
        {
            // 工作區內指向工作區的符號連結：改名、刪除的是連結本身，可以。
            std::os::unix::fs::symlink(&dir, dir.join("捷徑")).unwrap();
            assert!(check_entry(&dir, &dir.join("捷徑"), root_msg).is_ok());
            // 工作區外指向工作區的符號連結：不是工作區內的項目。
            let alias = std::env::temp_dir().join(format!("md-ws-alias-{}", std::process::id()));
            let _ = fs::remove_file(&alias);
            std::os::unix::fs::symlink(&dir, &alias).unwrap();
            assert!(resolve_inside(&dir, &alias).is_ok());
            assert!(check_entry(&dir, &alias, root_msg).is_err());
            assert!(check_entry(&dir, &alias.join("."), root_msg).is_err());
            fs::remove_file(&alias).unwrap();
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_folders_cannot_escape() {
        let dir = temp_ws("escape");
        let outside = std::env::temp_dir().join(format!("md-ws-outside-{}", std::process::id()));
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join(".github")).unwrap();
        assert!(resolve_inside(&dir, &dir.join(".github/workflows/ci.yml")).is_err());
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn validates_names() {
        assert!(validate_name("新筆記.md").is_ok());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("問題?.md").is_err());
        assert!(validate_name("  ").is_err());
        assert!(validate_name("結尾.").is_err());
    }

    #[test]
    fn searches_docs_respecting_gitignore() {
        let dir = temp_ws("search");
        let result = search_dir(&dir, "季度報告", false, false, &|| false).unwrap();
        // 已經有新的搜尋：停下來，回傳空的結果。
        let stale = search_dir(&dir, "季度報告", false, false, &|| true).unwrap();
        assert_eq!(stale.total, 0);
        let mut rels: Vec<&str> = result.files.iter().map(|f| f.rel.as_str()).collect();
        rels.sort();
        assert_eq!(rels, ["README.md", "第2章/筆記.md"]);
        let m = &result
            .files
            .iter()
            .find(|f| f.rel == "第2章/筆記.md")
            .unwrap()
            .matches[0];
        assert_eq!(m.line, 2);
        assert_eq!(m.column, 3, "以 UTF-16 計算的欄位");
        assert_eq!(
            &m.text.encode_utf16().collect::<Vec<_>>()[m.ranges[0].0..m.ranges[0].1],
            &"季度報告".encode_utf16().collect::<Vec<_>>()[..]
        );
        assert!(
            search_dir(&dir, "(", false, true, &|| false).is_err(),
            "無效的正規表示式"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn natural_sort_handles_numbers() {
        let mut v = vec!["第10章", "第2章", "a10", "A2", "第1章"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, ["A2", "a10", "第1章", "第2章", "第10章"]);
    }

    #[test]
    fn replaces_across_the_folder() {
        let dir = temp_ws("replace");
        let skipped = dir.join("第2章").join("筆記.md");
        let r = replace_dir(
            &dir,
            "季度報告",
            "季報",
            true,
            false,
            std::slice::from_ref(&skipped),
            |_, _, _| {},
        )
        .unwrap();
        assert_eq!((r.files, r.replacements), (1, 1));
        assert_eq!(r.skipped, [path_string(&skipped)]);
        assert_eq!(
            fs::read_to_string(dir.join("README.md")).unwrap(),
            "# 標題\n\n季報的內容\n"
        );
        // 略過 .gitignore 與 node_modules 的檔案
        assert_eq!(fs::read_to_string(dir.join("略過.md")).unwrap(), "季度報告");
        assert_eq!(
            fs::read_to_string(dir.join("node_modules/x.md")).unwrap(),
            "季度報告"
        );
        // 正規表示式與群組；非正規表示式時 $1 照字面
        let r = replace_dir(&dir, r"(季)報", "$1度報告", true, true, &[], |_, _, _| {}).unwrap();
        assert_eq!(r.replacements, 1);
        replace_dir(&dir, "標題", "$1", true, false, &[], |_, _, _| {}).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("README.md")).unwrap(),
            "# $1\n\n季度報告的內容\n"
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
