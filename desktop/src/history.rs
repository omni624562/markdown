//! 本機版本記錄：每次存檔時，在 app 資料夾（不是使用者的筆記資料夾）保存一份內容，
//! 讓使用者找回之前的版本。
//!
//! 每個檔案依路徑的雜湊放在自己的資料夾裡，檔名是 `<時間毫秒>-<種類>.txt`：
//! - `save`：存檔的內容
//! - `disk`：存檔前磁碟上的內容（和上一個版本不同時才記，例如被其他程式改過）
//!
//! 保留規則：最多 50 版；超過 30 天的會刪掉，但每個檔案至少留最新的 10 版。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::files::{decode, KnownFiles};
use crate::trust::Trust;
use crate::workspace::Workspace;

const MAX_VERSIONS: usize = 50;
const KEEP_AT_LEAST: usize = 10;
const MAX_AGE_MS: u64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Save,
    Disk,
}

impl Kind {
    fn tag(self) -> &'static str {
        match self {
            Kind::Save => "save",
            Kind::Disk => "disk",
        }
    }
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Version {
    /// 保存時間（Unix 毫秒），也是版本的編號。
    id: u64,
    kind: Kind,
    size: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 每個檔案的版本資料夾。Windows 的路徑不分大小寫，先轉成小寫再算雜湊。
fn file_dir(root: &Path, path: &Path) -> PathBuf {
    let mut key = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        key = key.to_lowercase();
    }
    let digest = Sha256::digest(key.as_bytes());
    let name: String = digest[..10].iter().map(|b| format!("{b:02x}")).collect();
    root.join(name)
}

fn parse_name(name: &str) -> Option<(u64, Kind)> {
    let stem = name.strip_suffix(".txt")?;
    let (id, kind) = stem.split_once('-')?;
    let kind = match kind {
        "save" => Kind::Save,
        "disk" => Kind::Disk,
        _ => return None,
    };
    Some((id.parse().ok()?, kind))
}

/// 版本清單（由新到舊）與各自的檔案路徑。
fn versions(dir: &Path) -> Vec<(Version, PathBuf)> {
    let mut out: Vec<(Version, PathBuf)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let (id, kind) = parse_name(&e.file_name().to_string_lossy())?;
            let size = e.metadata().ok()?.len();
            Some((Version { id, kind, size }, e.path()))
        })
        .collect();
    out.sort_by_key(|(v, _)| std::cmp::Reverse(v.id));
    out
}

/// 依保留規則刪除舊版本。
fn prune(dir: &Path, now: u64) {
    for (i, (v, path)) in versions(dir).into_iter().enumerate() {
        let too_many = i >= MAX_VERSIONS;
        let too_old = i >= KEEP_AT_LEAST && now.saturating_sub(v.id) > MAX_AGE_MS;
        if too_many || too_old {
            let _ = fs::remove_file(path);
        }
    }
}

/// 保存一個版本；和最新的版本內容相同時不重複保存。
pub fn record_at(root: &Path, path: &Path, text: &str, kind: Kind, now: u64) -> io::Result<()> {
    let dir = file_dir(root, path);
    fs::create_dir_all(&dir)?;
    let meta = dir.join("meta.json");
    let meta_json = serde_json::json!({ "path": path.to_string_lossy() }).to_string();
    if fs::read_to_string(&meta).ok().as_deref() != Some(meta_json.as_str()) {
        fs::write(&meta, meta_json)?;
    }
    let existing = versions(&dir);
    if let Some((latest, file)) = existing.first() {
        if fs::read_to_string(file).ok().as_deref() == Some(text) {
            return Ok(());
        }
        // 同一毫秒內存兩次（例如先記磁碟版本再記存檔內容）時，編號往後推。
        let id = now.max(latest.id + 1);
        crate::files::write_atomic(
            &dir.join(format!("{id}-{}.txt", kind.tag())),
            text.as_bytes(),
        )?;
    } else {
        crate::files::write_atomic(
            &dir.join(format!("{now}-{}.txt", kind.tag())),
            text.as_bytes(),
        )?;
    }
    prune(&dir, now);
    Ok(())
}

pub fn list_at(root: &Path, path: &Path) -> Vec<Version> {
    versions(&file_dir(root, path))
        .into_iter()
        .map(|(v, _)| v)
        .collect()
}

pub fn read_at(root: &Path, path: &Path, id: u64) -> io::Result<String> {
    let (_, file) = versions(&file_dir(root, path))
        .into_iter()
        .find(|(v, _)| v.id == id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "找不到這個版本"))?;
    Ok(decode(&fs::read(file)?).0)
}

/// 檔案或資料夾改名後，版本記錄跟著搬過去。
pub fn rename_at(root: &Path, from: &Path, to: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = fs::read_to_string(entry.path().join("meta.json")) else {
            continue;
        };
        let Some(old) = serde_json::from_str::<serde_json::Value>(&meta)
            .ok()
            .and_then(|v| v["path"].as_str().map(PathBuf::from))
        else {
            continue;
        };
        let Ok(rest) = old.strip_prefix(from) else {
            continue;
        };
        let new_path = if rest.as_os_str().is_empty() {
            to.to_path_buf()
        } else {
            to.join(rest)
        };
        let target = file_dir(root, &new_path);
        if target.exists() {
            continue;
        }
        if fs::rename(entry.path(), &target).is_ok() {
            let json = serde_json::json!({ "path": new_path.to_string_lossy() }).to_string();
            let _ = fs::write(target.join("meta.json"), json);
        }
    }
}

fn root(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join("history"))
}

/// 存檔時呼叫：先記下存檔前磁碟上的內容（若和上一版不同），再記下新內容。
/// 版本記錄失敗不影響存檔。
pub fn on_save(app: &AppHandle, path: &Path, disk_before: Option<&[u8]>, text: &str) {
    let Some(root) = root(app) else {
        return;
    };
    let now = now_ms();
    if let Some(bytes) = disk_before {
        let (before, _, _) = decode(bytes);
        if before != text {
            if let Err(e) = record_at(&root, path, &before, Kind::Disk, now) {
                eprintln!("無法保存版本記錄：{e}");
            }
        }
    }
    if let Err(e) = record_at(&root, path, text, Kind::Save, now) {
        eprintln!("無法保存版本記錄：{e}");
    }
}

pub fn on_rename(app: &AppHandle, from: &Path, to: &Path) {
    if let Some(root) = root(app) {
        rename_at(&root, from, to);
    }
}

/// 只能查看可以開啟的檔案的版本記錄（和重新開啟檔案的規則相同）。
fn allowed(
    path: &Path,
    known: &KnownFiles,
    trust: &Trust,
    workspace: &Workspace,
) -> Result<(), String> {
    if known.contains(path) || trust.allows(path) || workspace.contains(path) {
        Ok(())
    } else {
        Err("無法查看這個檔案的版本記錄".into())
    }
}

#[tauri::command]
pub fn history_list(
    app: AppHandle,
    path: String,
    known: State<'_, KnownFiles>,
    trust: State<'_, Trust>,
    workspace: State<'_, Workspace>,
) -> Result<Vec<Version>, String> {
    let path = PathBuf::from(path);
    allowed(&path, &known, &trust, &workspace)?;
    Ok(root(&app).map(|r| list_at(&r, &path)).unwrap_or_default())
}

#[tauri::command]
pub fn history_read(
    app: AppHandle,
    path: String,
    id: u64,
    known: State<'_, KnownFiles>,
    trust: State<'_, Trust>,
    workspace: State<'_, Workspace>,
) -> Result<String, String> {
    let path = PathBuf::from(path);
    allowed(&path, &known, &trust, &workspace)?;
    let root = root(&app).ok_or("找不到版本記錄資料夾")?;
    read_at(&root, &path, id).map_err(|e| format!("無法讀取版本：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("md-history-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn records_and_skips_duplicates() {
        let root = temp("dup");
        let file = Path::new("/筆記/週報.md");
        record_at(&root, file, "第一版", Kind::Save, 1000).unwrap();
        record_at(&root, file, "第一版", Kind::Save, 2000).unwrap();
        record_at(&root, file, "第二版", Kind::Save, 3000).unwrap();
        let list = list_at(&root, file);
        assert_eq!(list.iter().map(|v| v.id).collect::<Vec<_>>(), [3000, 1000]);
        assert_eq!(read_at(&root, file, 1000).unwrap(), "第一版");
        // 同一毫秒記兩版：編號往後推，不會覆蓋。
        record_at(&root, file, "外部修改", Kind::Disk, 3000).unwrap();
        assert_eq!(
            list_at(&root, file)[0],
            Version {
                id: 3001,
                kind: Kind::Disk,
                size: 12
            }
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn prunes_by_count_and_age() {
        let root = temp("prune");
        let file = Path::new("/筆記/a.md");
        let day = 24 * 60 * 60 * 1000;
        // 60 版，前 45 版在 40 天前。
        for i in 0..60u64 {
            let t = if i < 45 { i } else { 40 * day + i };
            record_at(&root, file, &format!("v{i}"), Kind::Save, t).unwrap();
        }
        let list = list_at(&root, file);
        // 最後一次存檔時「現在」是 40 天後：舊的 45 版只留到湊滿 10 版為止。
        assert_eq!(list.len(), 15);
        assert_eq!(list[0].id, 40 * day + 59);
        // 版本數上限。
        let root2 = temp("cap");
        for i in 0..60u64 {
            record_at(&root2, file, &format!("v{i}"), Kind::Save, 1000 + i).unwrap();
        }
        assert_eq!(list_at(&root2, file).len(), MAX_VERSIONS);
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&root2).unwrap();
    }

    #[test]
    fn follows_renames_of_files_and_folders() {
        let root = temp("rename");
        record_at(&root, Path::new("/w/舊/a.md"), "A", Kind::Save, 1).unwrap();
        record_at(&root, Path::new("/w/b.md"), "B", Kind::Save, 1).unwrap();
        rename_at(&root, Path::new("/w/舊"), Path::new("/w/新"));
        rename_at(&root, Path::new("/w/b.md"), Path::new("/w/c.md"));
        assert_eq!(read_at(&root, Path::new("/w/新/a.md"), 1).unwrap(), "A");
        assert_eq!(read_at(&root, Path::new("/w/c.md"), 1).unwrap(), "B");
        assert!(list_at(&root, Path::new("/w/舊/a.md")).is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ignores_unknown_files() {
        assert_eq!(parse_name("123-save.txt"), Some((123, Kind::Save)));
        assert_eq!(parse_name("meta.json"), None);
        assert_eq!(parse_name("x-save.txt"), None);
    }
}
