//! 監看檔案變動：工作區資料夾，以及工作區外已開啟檔案所在的資料夾。
//!
//! 只在內容真的和編輯器最後一次同步時不同才通知前端（自己存檔不會觸發）。
//! 網路磁碟（UNC 路徑、對應的網路磁碟機）不保證會發出變動通知，改用每 5 秒輪詢。

use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_full::notify::{
    self, event::ModifyKind, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode,
};
use notify_debouncer_full::{
    new_debouncer, new_debouncer_opt, DebounceEventResult, Debouncer, NoCache, RecommendedCache,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::files::{decode, hash_bytes, path_string, KnownFiles};

const DEBOUNCE: Duration = Duration::from_millis(300);
const POLL_INTERVAL: Duration = Duration::from_secs(5);

enum Active {
    Native(Debouncer<RecommendedWatcher, RecommendedCache>),
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
        new_debouncer(DEBOUNCE, None, handler).map(Active::Native)
    }
}

impl Watcher {
    /// 監看整個工作區（取代先前的工作區）。
    pub fn watch_workspace(&self, app: &AppHandle, root: &Path) {
        let mut slot = self.workspace.lock().unwrap();
        *slot = None; // 先停止舊的監看
        match create(app, crate::io::is_network_path(root)).and_then(|mut w| {
            w.watch(root, RecursiveMode::Recursive)?;
            Ok(w)
        }) {
            Ok(w) => *slot = Some(w),
            Err(e) => eprintln!("無法監看資料夾 {}：{e}", root.display()),
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
                    eprintln!("無法建立檔案監看：{e}");
                    return;
                }
            }
        }
        if let Some(w) = slot.as_mut() {
            if let Err(e) = w.watch(dir, RecursiveMode::NonRecursive) {
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
    let mut tree_dirs = BTreeSet::new();
    let mut touched = BTreeSet::new();
    for event in events.iter().filter(|e| is_relevant(&e.kind)) {
        let structural = matches!(
            event.kind,
            EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
        );
        for path in &event.paths {
            if structural {
                if let Some(parent) = path.parent() {
                    tree_dirs.insert(path_string(parent));
                }
            }
            touched.insert(path.clone());
        }
    }
    for path in touched.into_iter().filter(|p| known.contains(p)) {
        match fs::read(&path) {
            Ok(bytes) => {
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
}
