//! 監看檔案變動：工作區資料夾，以及工作區外已開啟檔案所在的資料夾。
//!
//! 只在內容真的和編輯器最後一次同步時不同才通知前端（自己存檔不會觸發）。
//! 網路磁碟（UNC 路徑、對應的網路磁碟機）不保證會發出變動通知，改用每 10 秒輪詢。
//! 輪詢每次都要列出監看的資料夾，所以只監看檔案樹會顯示的資料夾（依 .gitignore，
//! 略過 `.git`、`node_modules` 等），而且有數量上限。
//!
//! 資料夾結構的變動（`tree-changed`）會讓前端重新列出檔案、重新搜尋、重新查 git 狀態，
//! 所以這些不算：自己存檔用的暫存檔、`.git`、`node_modules` 等檔案樹本來就不顯示的資料夾，
//! 以及已開啟的檔案被存檔取代（暫存檔改名成原檔）。

use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_full::notify::{
    self, event::ModifyKind, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode,
};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::files::{decode, hash_bytes, is_temp_name, path_string, KnownFiles, MAX_OPEN_BYTES};

const DEBOUNCE: Duration = Duration::from_millis(300);
const POLL_INTERVAL: Duration = Duration::from_secs(10);
/// 輪詢最多監看幾個資料夾（淺的優先）。每個資料夾每次輪詢都要列出內容。
const MAX_POLL_DIRS: usize = 2000;
/// 找要輪詢的資料夾時最多看幾個（避免在很深、很大的資料夾裡走訪太久）。
const MAX_POLL_SCAN: usize = 20_000;

// 不用 notify 建議的 FileIdMap 快取：它在 Windows、macOS 上開始監看時會走訪整個資料夾
// （包括 node_modules），每次重新掃描也一樣。快取只用來把改名的前後兩個事件接起來，
// 這裡每個路徑都分開處理，用不到。
enum Active {
    Native(Debouncer<RecommendedWatcher, NoCache>),
    Poll(Debouncer<PollWatcher, NoCache>),
}

impl Active {
    fn watch(&mut self, path: &Path, mode: RecursiveMode) -> notify::Result<()> {
        match self {
            Active::Native(d) => d.watch(path, mode),
            Active::Poll(d) => d.watch(path, mode),
        }
    }
}

#[derive(Default)]
pub struct Watcher {
    workspace: Mutex<Option<Active>>,
    /// 用輪詢監看的工作區（網路磁碟）與監看中的資料夾數，見 `watch_workspace`。
    poll_root: Mutex<Option<PathBuf>>,
    poll_count: Mutex<usize>,
    /// 工作區外檔案所在資料夾的監看（不遞迴）。網路資料夾另外用輪詢的方式監看。
    outside: Mutex<Option<Active>>,
    outside_poll: Mutex<Option<Active>>,
    outside_dirs: Mutex<HashSet<PathBuf>>,
}

fn create(app: &AppHandle, poll: bool) -> notify::Result<Active> {
    let app = app.clone();
    let handler = move |result: DebounceEventResult| {
        if let Ok(events) = result {
            handle_events(&app, events);
        }
    };
    if poll {
        new_debouncer_opt::<_, PollWatcher, NoCache>(
            DEBOUNCE,
            None,
            handler,
            NoCache,
            notify::Config::default().with_poll_interval(POLL_INTERVAL),
        )
        .map(Active::Poll)
    } else {
        new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
            DEBOUNCE,
            None,
            handler,
            NoCache,
            notify::Config::default(),
        )
        .map(Active::Native)
    }
}

/// 檔案樹不顯示、也不需要監看的資料夾：隱藏資料夾（含 `.git`）、`node_modules`，
/// 以及 Rust 的建置資料夾（有 `CACHEDIR.TAG` 的 `target`）。`exists` 用來檢查檔案是否存在。
fn is_ignored_dir(parent: &Path, name: &std::ffi::OsStr, exists: &dyn Fn(&Path) -> bool) -> bool {
    let name = name.to_string_lossy();
    name.starts_with('.')
        || name == "node_modules"
        || (name == "target" && exists(&parent.join("target").join("CACHEDIR.TAG")))
}

/// 這個路徑的變動不影響檔案樹：暫存檔，或位於忽略的資料夾內（相對於工作區判斷；
/// 工作區外的檔案只看檔名）。`.gitignore` 本身例外：它改了，檔案樹顯示的內容也會跟著變。
fn is_noise(path: &Path, root: Option<&Path>, exists: &dyn Fn(&Path) -> bool) -> bool {
    let Some(name) = path.file_name() else {
        return false;
    };
    if is_temp_name(&name.to_string_lossy()) {
        return true;
    }
    let (base, rel) = match root.and_then(|r| path.strip_prefix(r).ok().map(|rel| (r, rel))) {
        Some(pair) => pair,
        None => (path.parent().unwrap_or(Path::new("")), Path::new(name)),
    };
    let mut dir = base.to_path_buf();
    let count = rel.components().count();
    for (i, part) in rel.components().enumerate() {
        let part = part.as_os_str();
        let last = i + 1 == count;
        if !(last && part == ".gitignore") && is_ignored_dir(&dir, part, exists) {
            return true;
        }
        dir.push(part);
    }
    false
}

/// 把一批事件分成「結構變動的資料夾」與「內容可能變了的檔案」。
/// `known` 判斷是不是已開啟的檔案；`exists` 判斷檔案是否存在。
fn classify<'a>(
    events: impl IntoIterator<Item = &'a notify::Event>,
    root: Option<&Path>,
    known: &dyn Fn(&Path) -> bool,
    exists: &dyn Fn(&Path) -> bool,
) -> (BTreeSet<String>, BTreeSet<PathBuf>) {
    let mut tree_dirs = BTreeSet::new();
    let mut touched = BTreeSet::new();
    for event in events.into_iter().filter(|e| is_relevant(&e.kind)) {
        let structural = matches!(
            event.kind,
            EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
        );
        for path in &event.paths {
            if path
                .file_name()
                .is_some_and(|n| is_temp_name(&n.to_string_lossy()))
            {
                continue;
            }
            touched.insert(path.clone());
            // 已開啟的檔案被存檔取代（暫存檔改名成原檔）後還在：檔案樹沒有變。
            if !structural || is_noise(path, root, exists) || (known(path) && exists(path)) {
                continue;
            }
            if let Some(parent) = path.parent() {
                tree_dirs.insert(path_string(parent));
            }
        }
    }
    (tree_dirs, touched)
}

/// 輪詢要監看的資料夾（含 `root` 本身）：依 .gitignore 走訪，略過隱藏資料夾、`node_modules`
/// 與建置資料夾；淺的優先，最多 `max` 個。
fn poll_dirs(root: &Path, max: usize) -> Vec<PathBuf> {
    let mut walk = crate::workspace::walker(root);
    // 會取代 walker 原本只略過 node_modules 的條件，所以這裡一併略過。
    walk.filter_entry(|e| {
        e.depth() == 0
            || !e.file_type().is_some_and(|t| t.is_dir())
            || !is_ignored_dir(
                e.path().parent().unwrap_or(Path::new("")),
                e.file_name(),
                &|p| p.exists(),
            )
    });
    let mut dirs: Vec<(usize, PathBuf)> = walk
        .build()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_some_and(|t| t.is_dir()))
        .take(MAX_POLL_SCAN)
        .map(|e| (e.depth(), e.into_path()))
        .collect();
    dirs.sort_by_key(|(depth, _)| *depth);
    dirs.truncate(max);
    dirs.into_iter().map(|(_, p)| p).collect()
}

impl Watcher {
    /// 監看整個工作區（取代先前的工作區）。
    pub fn watch_workspace(&self, app: &AppHandle, root: &Path) {
        let poll = crate::io::is_network_path(root);
        // 網路磁碟：先列出要輪詢的資料夾（可能要一陣子），不佔著鎖。
        let dirs = if poll {
            poll_dirs(root, MAX_POLL_DIRS)
        } else {
            vec![]
        };
        let mut slot = self.workspace.lock().unwrap();
        // 這段期間又開了別的資料夾（各自在背景執行）：不要用舊資料夾蓋掉新的監看。
        if app.state::<crate::workspace::Workspace>().root().as_deref() != Some(root) {
            return;
        }
        *slot = None; // 先停止舊的監看
        *self.poll_root.lock().unwrap() = poll.then(|| root.to_path_buf());
        *self.poll_count.lock().unwrap() = dirs.len();
        match create(app, poll).and_then(|mut w| {
            if poll {
                // 每個資料夾各自不遞迴地監看，略過的資料夾（.git、node_modules…）就不會被輪詢。
                // 之後新增的資料夾在 `handle_events` 補上。
                w.watch(root, RecursiveMode::NonRecursive)?;
                for dir in dirs.iter().filter(|d| d.as_path() != root) {
                    let _ = w.watch(dir, RecursiveMode::NonRecursive);
                }
            } else {
                w.watch(root, RecursiveMode::Recursive)?;
            }
            Ok(w)
        }) {
            Ok(w) => *slot = Some(w),
            // i18n-ignore：記錄檔
            Err(e) => eprintln!("無法監看資料夾 {}：{e}", root.display()),
        }
    }

    /// 停止監看工作區（改開遠端的 WebDAV 工作區時）。
    pub fn stop_workspace(&self) {
        *self.workspace.lock().unwrap() = None;
        *self.poll_root.lock().unwrap() = None;
        *self.poll_count.lock().unwrap() = 0;
    }

    /// 輪詢監看的工作區新增了資料夾（任何一層）：開始監看它。
    fn watch_new_dirs(&self, paths: &BTreeSet<PathBuf>) {
        let Some(root) = self.poll_root.lock().unwrap().clone() else {
            return;
        };
        let new_dirs: Vec<&PathBuf> = paths
            .iter()
            .filter(|p| p.starts_with(&root) && p.as_path() != root)
            .filter(|p| !is_noise(p, Some(&root), &|p| p.exists()))
            .filter(|p| p.is_dir())
            .collect();
        if new_dirs.is_empty() {
            return;
        }
        // 上鎖順序和 `watch_workspace`、`stop_workspace` 一樣：先 workspace 再 poll_count，才不會互等卡住。
        let mut slot = self.workspace.lock().unwrap();
        let mut count = self.poll_count.lock().unwrap();
        if let Some(Active::Poll(w)) = slot.as_mut() {
            for dir in new_dirs {
                if *count >= MAX_POLL_DIRS {
                    break;
                }
                if w.watch(dir, RecursiveMode::NonRecursive).is_ok() {
                    *count += 1;
                }
            }
        }
    }

    /// 監看工作區外檔案所在的資料夾（同一個資料夾只監看一次）。
    pub fn watch_file(&self, app: &AppHandle, path: &Path) {
        let in_workspace = app.state::<crate::workspace::Workspace>().contains(path);
        let Some(dir) = path.parent().filter(|_| !in_workspace) else {
            return;
        };
        if !self.outside_dirs.lock().unwrap().insert(dir.to_path_buf()) {
            return;
        }
        let poll = crate::io::is_network_path(dir);
        let mut slot = if poll {
            self.outside_poll.lock().unwrap()
        } else {
            self.outside.lock().unwrap()
        };
        if slot.is_none() {
            match create(app, poll) {
                Ok(w) => *slot = Some(w),
                Err(e) => {
                    // i18n-ignore：記錄檔
                    eprintln!("無法建立檔案監看：{e}");
                    return;
                }
            }
        }
        if let Some(w) = slot.as_mut() {
            if let Err(e) = w.watch(dir, RecursiveMode::NonRecursive) {
                // i18n-ignore：記錄檔
                eprintln!("無法監看 {}：{e}", dir.display());
            }
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileChanged {
    path: String,
    text: String,
}

#[derive(Serialize, Clone)]
struct PathPayload {
    path: String,
}

#[derive(Serialize, Clone)]
struct TreeChanged {
    dirs: Vec<String>,
}

/// 讀取檔案（包括這裡為了比對內容而讀）在 Linux 會產生 Access 事件，只改屬性時則是 Metadata；
/// 兩者都不會改變內容，忽略掉才不會「讀檔 → 事件 → 再讀檔」無限循環。
fn is_relevant(kind: &EventKind) -> bool {
    !matches!(
        kind,
        EventKind::Access(_) | EventKind::Modify(ModifyKind::Metadata(_))
    )
}

fn handle_events(app: &AppHandle, events: Vec<notify_debouncer_full::DebouncedEvent>) {
    let known = app.state::<KnownFiles>();
    let root = app.state::<crate::workspace::Workspace>().root();
    let (tree_dirs, touched) = classify(
        events.iter().map(|e| &e.event),
        root.as_deref(),
        &|p| known.contains(p),
        &|p| p.exists(),
    );
    // 輪詢的工作區新增了資料夾時要補上監看（只看新增事件的路徑）。
    let created: BTreeSet<PathBuf> = events
        .iter()
        .filter(|e| matches!(e.kind, EventKind::Create(_)))
        .flat_map(|e| e.paths.iter().cloned())
        .collect();
    if !created.is_empty() {
        app.state::<Watcher>().watch_new_dirs(&created);
    }
    for path in touched.into_iter().filter(|p| known.contains(p)) {
        // 太大的檔案不比對（編輯器本來就開不了）。
        if fs::metadata(&path).is_ok_and(|m| m.len() > MAX_OPEN_BYTES) {
            continue;
        }
        match crate::files::read_capped(&path, MAX_OPEN_BYTES) {
            Ok(Some(bytes)) => {
                if known.stored_hash(&path) != Some(hash_bytes(&bytes)) {
                    let (text, _, _) = decode(&bytes);
                    let _ = app.emit(
                        "file-changed",
                        FileChanged {
                            path: path_string(&path),
                            text,
                        },
                    );
                }
            }
            Ok(None) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let _ = app.emit(
                    "file-removed",
                    PathPayload {
                        path: path_string(&path),
                    },
                );
            }
            Err(_) => {}
        }
    }
    if !tree_dirs.is_empty() {
        let _ = app.emit(
            "tree-changed",
            TreeChanged {
                dirs: tree_dirs.into_iter().collect(),
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polls_only_visible_folders_shallow_first() {
        let root = std::env::temp_dir().join(format!("md-poll-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for d in [
            "筆記/2026/十月",
            "node_modules/pkg/lib",
            ".git/objects",
            "app/node_modules/x",
            "app/.git/refs",
            "proj/target/debug",
            "build/out",
            "src",
        ] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        fs::write(root.join("proj/target/CACHEDIR.TAG"), "").unwrap();
        fs::write(root.join(".gitignore"), "build/\n").unwrap();
        let rel = |dirs: Vec<PathBuf>| -> Vec<String> {
            dirs.iter()
                .map(|d| {
                    d.strip_prefix(&root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/")
                })
                .collect()
        };
        let all = rel(poll_dirs(&root, 100));
        let mut sorted = all.clone();
        sorted.sort();
        assert_eq!(
            sorted,
            [
                "",
                "app",
                "proj",
                "src",
                "筆記",
                "筆記/2026",
                "筆記/2026/十月"
            ]
        );
        // 淺的優先：數量有上限時保留上層的資料夾。
        assert_eq!(all[0], "");
        let few = rel(poll_dirs(&root, 3));
        assert_eq!(few.len(), 3);
        assert!(few.iter().all(|d| !d.contains('/')), "{few:?}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ignores_reads_and_metadata() {
        use notify::event::{AccessKind, AccessMode, CreateKind, DataChange, MetadataKind};
        assert!(!is_relevant(&EventKind::Access(AccessKind::Close(
            AccessMode::Read
        ))));
        assert!(!is_relevant(&EventKind::Modify(ModifyKind::Metadata(
            MetadataKind::WriteTime
        ))));
        assert!(is_relevant(&EventKind::Modify(ModifyKind::Data(
            DataChange::Any
        ))));
        assert!(is_relevant(&EventKind::Create(CreateKind::File)));
    }

    fn event(kind: EventKind, paths: &[&str]) -> notify::Event {
        paths.iter().fold(notify::Event::new(kind), |e, p| {
            e.add_path(PathBuf::from(p))
        })
    }

    #[test]
    fn own_saves_and_ignored_folders_do_not_change_the_tree() {
        use notify::event::{CreateKind, DataChange, ModifyKind, RemoveKind, RenameMode};
        let root = Path::new("/w");
        let known = |p: &Path| p == Path::new("/w/筆記.md");
        let on_disk = |p: &Path| {
            p == Path::new("/w/筆記.md")
                || p == Path::new("/w/新.md")
                || p == Path::new("/w/proj/target/CACHEDIR.TAG")
        };
        let tmp = "/w/.筆記.md.0123456789abcdef.tmp";
        let events = [
            // 存檔：建立暫存檔、寫入、改名成原檔。
            event(EventKind::Create(CreateKind::File), &[tmp]),
            event(EventKind::Modify(ModifyKind::Data(DataChange::Any)), &[tmp]),
            event(
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                &[tmp, "/w/筆記.md"],
            ),
            event(
                EventKind::Modify(ModifyKind::Name(RenameMode::To)),
                &["/w/筆記.md"],
            ),
            // git status 改寫 .git/index、npm 安裝套件、cargo 建置。
            event(EventKind::Create(CreateKind::File), &["/w/.git/index.lock"]),
            event(
                EventKind::Create(CreateKind::File),
                &["/w/node_modules/x/a.md"],
            ),
            event(
                EventKind::Create(CreateKind::File),
                &["/w/proj/target/debug/x"],
            ),
        ];
        let (dirs, touched) = classify(&events, Some(root), &known, &on_disk);
        assert!(dirs.is_empty(), "{dirs:?}");
        assert!(touched.contains(Path::new("/w/筆記.md")));
        assert!(!touched
            .iter()
            .any(|p| p.to_string_lossy().ends_with(".tmp")));

        // 真正的結構變動：新增檔案、刪除已開啟的檔案、名為 target 但不是建置資料夾、.gitignore。
        let events = [
            event(EventKind::Create(CreateKind::File), &["/w/新.md"]),
            event(EventKind::Remove(RemoveKind::File), &["/w/舊.md"]),
            event(EventKind::Create(CreateKind::File), &["/w/target/目標.md"]),
            event(EventKind::Create(CreateKind::File), &["/w/.gitignore"]),
        ];
        let (dirs, _) = classify(&events, Some(root), &|_| false, &on_disk);
        assert_eq!(dirs.into_iter().collect::<Vec<_>>(), ["/w", "/w/target"]);

        // 已開啟的檔案被別的程式刪掉：要更新檔案樹。
        let events = [event(EventKind::Remove(RemoveKind::File), &["/w/筆記.md"])];
        let (dirs, _) = classify(&events, Some(root), &known, &|_| false);
        assert_eq!(dirs.into_iter().collect::<Vec<_>>(), ["/w"]);

        // 工作區本身在隱藏資料夾裡也照常運作（只看工作區內的相對路徑）。
        let events = [event(
            EventKind::Create(CreateKind::File),
            &["/home/me/.notes/a.md"],
        )];
        let (dirs, _) = classify(
            &events,
            Some(Path::new("/home/me/.notes")),
            &|_| false,
            &|_| false,
        );
        assert_eq!(dirs.into_iter().collect::<Vec<_>>(), ["/home/me/.notes"]);
    }
}
