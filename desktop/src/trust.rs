//! 最近開啟的資料夾與檔案，以及專案（開過的資料夾）的名稱、顏色、群組與釘選。
//!
//! 這份清單同時是「信任清單」：重新開啟 app 時還原分頁、從「最近開啟」開檔，
//! 都只允許清單裡的路徑（或位於清單中資料夾內的檔案），
//! 所以前端無法藉由傳入任意路徑讀取使用者沒有選過的檔案。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 沒有釘選、也沒有群組的專案最多保留幾個（釘選或有群組的不限）。
const MAX_FOLDERS: usize = 30;
const MAX_FILES: usize = 30;

/// 專案（開過的資料夾）的設定。`folders` 裡沒有對應項目的資料夾就是全部用預設值。
#[derive(Default, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub path: PathBuf,
    /// 自訂的顯示名稱；沒有就用資料夾名稱。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    /// 上次開啟的時間（Unix 毫秒）；0 代表不知道（舊版留下的資料夾）。
    #[serde(default)]
    pub last_opened: u64,
}

impl ProjectMeta {
    fn new(path: &Path) -> Self {
        ProjectMeta {
            path: path.to_path_buf(),
            ..Default::default()
        }
    }

    /// 釘選或放進群組的專案不會因為太久沒開而從清單消失。
    pub fn kept(&self) -> bool {
        self.pinned || self.group.is_some()
    }
}

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct Recent {
    pub folders: Vec<PathBuf>,
    pub files: Vec<PathBuf>,
    #[serde(default)]
    pub projects: Vec<ProjectMeta>,
}

impl Recent {
    /// 依最近開啟的順序列出所有專案。
    pub fn project_list(&self) -> Vec<ProjectMeta> {
        self.folders
            .iter()
            .map(|f| {
                self.projects
                    .iter()
                    .find(|m| &m.path == f)
                    .cloned()
                    .unwrap_or_else(|| ProjectMeta::new(f))
            })
            .collect()
    }

    fn open_folder(&mut self, path: &Path, now: u64) {
        self.folders.retain(|p| p != path);
        self.folders.insert(0, path.to_path_buf());
        self.meta_mut(path).last_opened = now;
        self.prune();
    }

    fn meta_mut(&mut self, path: &Path) -> &mut ProjectMeta {
        let i = match self.projects.iter().position(|m| m.path == path) {
            Some(i) => i,
            None => {
                self.projects.push(ProjectMeta::new(path));
                self.projects.len() - 1
            }
        };
        &mut self.projects[i]
    }

    /// 釘選或有群組的專案全部保留，其他的只留最近的 `MAX_FOLDERS` 個。
    fn prune(&mut self) {
        let kept: Vec<PathBuf> = self
            .projects
            .iter()
            .filter(|m| m.kept())
            .map(|m| m.path.clone())
            .collect();
        let mut others = 0;
        self.folders.retain(|p| {
            if kept.contains(p) {
                return true;
            }
            others += 1;
            others <= MAX_FOLDERS
        });
        let folders = &self.folders;
        self.projects.retain(|m| folders.contains(&m.path));
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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
        self.0.lock().unwrap().open_folder(path, now_millis());
        self.save(app);
    }

    /// 修改專案的設定；專案必須在清單中。
    pub fn update_project(
        &self,
        app: &AppHandle,
        path: &Path,
        change: impl FnOnce(&mut ProjectMeta),
    ) -> Result<ProjectMeta, String> {
        let meta = {
            let mut r = self.0.lock().unwrap();
            if !r.folders.iter().any(|p| p == path) {
                return Err(tr!("這個資料夾不在專案清單中"));
            }
            change(r.meta_mut(path));
            let meta = r.meta_mut(path).clone();
            r.prune();
            meta
        };
        self.save(app);
        Ok(meta)
    }

    /// 從專案清單移除（只移除資料夾本身，不動最近開啟的檔案）。
    pub fn forget_folder(&self, app: &AppHandle, path: &Path) {
        {
            let mut r = self.0.lock().unwrap();
            r.folders.retain(|p| p != path);
            r.projects.retain(|m| m.path != path);
        }
        self.save(app);
    }

    /// 專案還沒有群組時放進 `group`（例如從 GitHub 下載的儲存庫）。
    pub fn set_default_group(&self, app: &AppHandle, path: &Path, group: &str) {
        let _ = self.update_project(app, path, |m| {
            m.group.get_or_insert_with(|| group.to_string());
        });
    }

    /// 專案的設定（不在清單中時回傳 None）。
    pub fn project(&self, path: &Path) -> Option<ProjectMeta> {
        let r = self.0.lock().unwrap();
        r.folders.iter().any(|p| p == path).then(|| {
            r.projects
                .iter()
                .find(|m| m.path == path)
                .cloned()
                .unwrap_or_else(|| ProjectMeta::new(path))
        })
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
            let projects = r.projects.iter_mut().map(|m| &mut m.path);
            for p in r
                .files
                .iter_mut()
                .chain(r.folders.iter_mut())
                .chain(projects)
            {
                if let Ok(rest) = p.strip_prefix(from) {
                    *p = to.join(rest);
                }
            }
            // 改到和另一個專案同一個位置時，只留第一個。
            let mut seen = Vec::new();
            r.folders.retain(|p| {
                let new = !seen.contains(p);
                seen.push(p.clone());
                new
            });
            let mut seen = Vec::new();
            r.projects.retain(|m| {
                let new = !seen.contains(&m.path);
                seen.push(m.path.clone());
                new
            });
        }
        self.save(app);
    }

    pub fn remove(&self, app: &AppHandle, path: &Path) {
        {
            let mut r = self.0.lock().unwrap();
            r.files.retain(|p| !p.starts_with(path));
            r.folders.retain(|p| p != path);
            r.projects.retain(|m| m.path != path);
        }
        self.save(app);
    }

    pub fn snapshot(&self) -> Recent {
        self.0.lock().unwrap().clone()
    }

    pub fn allows_folder(&self, path: &Path) -> bool {
        self.0.lock().unwrap().folders.iter().any(|p| p == path)
    }

    /// 檔案在最近開啟清單中，或實際位於最近開啟的資料夾內。
    ///
    /// 資料夾用解析符號連結後的實際路徑判斷（和工作區的 `resolve_inside` 一致）：
    /// 資料夾裡名叫 `notes.md`、實際指向 `~/.ssh/id_rsa` 的符號連結不算在資料夾內。
    /// 需要讀取磁碟，請在背景執行緒呼叫。
    pub fn allows(&self, path: &Path) -> bool {
        let r = self.snapshot();
        allowed(&r, path, |p| crate::workspace::real_path(p).ok())
    }
}

fn allowed(r: &Recent, path: &Path, real: impl Fn(&Path) -> Option<PathBuf>) -> bool {
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return false;
    }
    // 使用者在對話框選過的檔案本身。
    if r.files.iter().any(|p| p == path) {
        return true;
    }
    // 資料夾裡的檔案只限文件（不含 `.git` 裡的設定）。
    if !crate::workspace::is_editable_doc(path) {
        return false;
    }
    let mut candidates = r.folders.iter().filter(|f| path.starts_with(f)).peekable();
    if candidates.peek().is_none() {
        return false;
    }
    let Some(target) = real(path) else {
        return false;
    };
    candidates.any(|f| real(f).is_some_and(|f| target.starts_with(f)))
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
    fn keeps_pinned_and_grouped_projects_beyond_the_cap() {
        let mut r = Recent::default();
        r.open_folder(Path::new("/釘選"), 1);
        r.meta_mut(Path::new("/釘選")).pinned = true;
        r.open_folder(Path::new("/群組"), 2);
        r.meta_mut(Path::new("/群組")).group = Some("公司".into());
        for i in 0..MAX_FOLDERS + 5 {
            r.open_folder(Path::new(&format!("/p/{i}")), 10 + i as u64);
        }
        assert_eq!(r.folders.len(), MAX_FOLDERS + 2);
        assert!(r.folders.contains(&PathBuf::from("/釘選")));
        assert!(r.folders.contains(&PathBuf::from("/群組")));
        assert!(!r.folders.contains(&PathBuf::from("/p/0")));
        // 設定只留給還在清單中的資料夾。
        assert_eq!(r.projects.len(), r.folders.len());
        let list = r.project_list();
        assert_eq!(
            list[0].path,
            PathBuf::from(format!("/p/{}", MAX_FOLDERS + 4))
        );
        assert_eq!(list[0].last_opened, 10 + MAX_FOLDERS as u64 + 4);
        let pinned = list.iter().find(|m| m.path == Path::new("/釘選")).unwrap();
        assert!(pinned.pinned);
        assert_eq!(pinned.last_opened, 1);
    }

    #[test]
    fn old_recent_files_become_projects() {
        let r: Recent = serde_json::from_str(r#"{"folders":["/a","/b"],"files":[]}"#).unwrap();
        let list = r.project_list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1], ProjectMeta::new(Path::new("/b")));
    }

    #[test]
    fn allows_files_inside_recent_folders_only() {
        let r = Recent {
            folders: vec!["/筆記".into()],
            files: vec!["/其他/單一.md".into()],
            ..Default::default()
        };
        let same = |p: &Path| Some(p.to_path_buf());
        assert!(allowed(&r, Path::new("/筆記/子/a.md"), same));
        assert!(allowed(&r, Path::new("/其他/單一.md"), same));
        assert!(!allowed(&r, Path::new("/其他/別的.md"), same));
        assert!(!allowed(&r, Path::new("/筆記/../etc/passwd"), same));
        // 資料夾裡不是文件的檔案、`.git` 裡的設定：不允許。
        assert!(!allowed(&r, Path::new("/筆記/.git/config"), same));
        assert!(!allowed(&r, Path::new("/筆記/.GIT/info/a.md"), same));
        assert!(!allowed(&r, Path::new("/筆記/工具.exe"), same));
        // 資料夾內的符號連結實際指向資料夾外：不允許。
        let link = |p: &Path| {
            Some(if p == Path::new("/筆記/notes.md") {
                PathBuf::from("/home/me/.ssh/id_rsa")
            } else {
                p.to_path_buf()
            })
        };
        assert!(!allowed(&r, Path::new("/筆記/notes.md"), link));
        assert!(allowed(&r, Path::new("/筆記/a.md"), link));
        // 讀不到實際位置（例如網路斷線）時不允許。
        assert!(!allowed(&r, Path::new("/筆記/a.md"), |_| None));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_inside_trusted_folders_are_checked() {
        let dir = std::env::temp_dir().join(format!("md-trust-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("筆記")).unwrap();
        fs::write(dir.join("祕密"), "x").unwrap();
        fs::write(dir.join("筆記/a.md"), "a").unwrap();
        std::os::unix::fs::symlink(dir.join("祕密"), dir.join("筆記/notes.md")).unwrap();
        let t = Trust(Mutex::new(Recent {
            folders: vec![dir.join("筆記")],
            ..Default::default()
        }));
        assert!(t.allows(&dir.join("筆記/a.md")));
        assert!(!t.allows(&dir.join("筆記/notes.md")));
        fs::remove_dir_all(&dir).unwrap();
    }
}
