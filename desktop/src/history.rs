//! 本機版本記錄：每次存檔時，在 app 資料夾（不是使用者的筆記資料夾）保存一份內容，
//! 讓使用者找回之前的版本。
//!
//! 每個檔案依路徑的雜湊放在自己的資料夾裡，檔名是 `<時間毫秒>-<種類>.txt`：
//! - `save`：存檔的內容
//! - `disk`：存檔前磁碟上的內容（和上一個版本不同時才記，例如被其他程式改過）
//!
//! 保留規則：最多 50 版；超過 30 天的會刪掉，但每個檔案至少留最新的 10 版。
//! 超過 5 MB 的檔案不保存版本。所有版本加起來超過 300 MB 時，從最舊的開始刪（每個檔案至少留最新的一版）；
//! 已經不存在的檔案，最新的版本超過 90 天後整個刪掉。這些清理在啟動後於背景進行。
//!
//! 版本記錄在背景執行緒依序寫入，不會拖慢存檔。`meta.json` 記下最新版本的雜湊，
//! 判斷「和上一版相同」時不必讀出上一版的內容。
//!
//! 自動存檔每隔一兩秒就存一次，每次都留一版的話，50 版很快就只剩最近幾分鐘。
//! 存檔指令分不出是自動存檔還是使用者按的（前端的 API 沒有這個資訊），所以單純依時間合併：
//! 連續的 `save` 版本之間至少隔 2 分鐘，太密的中間版本會被下一次存檔取代
//! （一定保留最新的一版）。`disk` 版本（存檔前被其他程式改過的內容）永遠不會被合併掉。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::files::{decode, KnownFiles};
use crate::trust::Trust;
use crate::workspace::Workspace;

const MAX_VERSIONS: usize = 50;
const KEEP_AT_LEAST: usize = 10;
const MAX_AGE_MS: u64 = 30 * 24 * 60 * 60 * 1000;
/// 連續的存檔版本至少間隔多久（見模組說明）。
const COALESCE_MS: u64 = 2 * 60 * 1000;
/// 超過這個大小的檔案不保存版本。
const MAX_FILE_BYTES: usize = 5 * 1024 * 1024;
/// 所有版本加起來的上限。
const QUOTA_BYTES: u64 = 300 * 1024 * 1024;
/// 檔案已經不存在、最新的版本超過這麼久，整個版本資料夾就刪掉。
const ORPHAN_AGE_MS: u64 = 90 * 24 * 60 * 60 * 1000;

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
        // Windows 的路徑不分大小寫，`/` 和 `\` 也通用（改名後 join 出來的路徑常混用兩種）。
        key = key.to_lowercase().replace('/', "\\");
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

fn text_hash(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `meta.json`：原始路徑與最新版本內容的雜湊（舊版沒有雜湊）。
fn read_meta(dir: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&fs::read_to_string(dir.join("meta.json")).ok()?).ok()
}

fn write_meta(dir: &Path, path: &str, latest: Option<&str>) -> io::Result<()> {
    let mut json = serde_json::json!({ "path": path });
    if let Some(h) = latest {
        json["latest"] = serde_json::Value::from(h);
    }
    fs::write(dir.join("meta.json"), json.to_string())
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

/// 保存一個版本；和最新的版本內容相同時不重複保存。太大的檔案不保存。
pub fn record_at(root: &Path, path: &Path, text: &str, kind: Kind, now: u64) -> io::Result<()> {
    if text.len() > MAX_FILE_BYTES {
        return Ok(());
    }
    let dir = file_dir(root, path);
    fs::create_dir_all(&dir)?;
    let path_str = path.to_string_lossy();
    let hash = text_hash(text);
    let meta = read_meta(&dir);
    let latest_hash = meta
        .as_ref()
        .and_then(|m| m["latest"].as_str().map(str::to_string));
    let existing = versions(&dir);
    if let Some((latest, file)) = existing.first() {
        // 有記雜湊就比對雜湊；舊版的資料沒有，才讀出上一版比對。
        let same = match &latest_hash {
            Some(h) => *h == hash,
            None => fs::read_to_string(file).ok().as_deref() == Some(text),
        };
        if same {
            return Ok(());
        }
        // 同一毫秒內存兩次（例如先記磁碟版本再記存檔內容）時，編號往後推。
        let id = now.max(latest.id + 1);
        crate::files::write_atomic(
            &dir.join(format!("{id}-{}.txt", kind.tag())),
            text.as_bytes(),
        )?;
        // 新版本寫好之後，才拿掉被它取代的中間版本（寫入失敗時不會少掉任何一版）。
        if kind == Kind::Save && superseded(&existing) {
            let _ = fs::remove_file(file);
        }
    } else {
        crate::files::write_atomic(
            &dir.join(format!("{now}-{}.txt", kind.tag())),
            text.as_bytes(),
        )?;
    }
    write_meta(&dir, &path_str, Some(&hash))?;
    prune(&dir, now);
    Ok(())
}

/// 再存一個 `save` 版本時，目前最新的版本是否可以拿掉：它和前一版都是 `save`，
/// 而且兩者相隔不到 [`COALESCE_MS`]。這樣連續存檔時保留的是每段的第一版與最新的一版，
/// 版本之間至少隔 2 分鐘。
fn superseded(existing: &[(Version, PathBuf)]) -> bool {
    match existing {
        [(latest, _), (previous, _), ..] => {
            latest.kind == Kind::Save
                && previous.kind == Kind::Save
                && latest.id.saturating_sub(previous.id) < COALESCE_MS
        }
        _ => false,
    }
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
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, tr!("找不到這個版本")))?;
    Ok(decode(&fs::read(file)?).0)
}

/// 檔案或資料夾改名後，版本記錄跟著搬過去。
pub fn rename_at(root: &Path, from: &Path, to: &Path) {
    // 改名的是一個檔案（大多數的情況）：版本記錄的資料夾名稱由路徑算出來，直接搬那一個，
    // 不必讀遍所有檔案的 meta.json。
    if to.is_file() {
        move_dir(root, &file_dir(root, from), to);
        return;
    }
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
        move_dir(root, &entry.path(), &new_path);
    }
}

/// 把一個檔案的版本記錄（`dir`）搬到 `new_path` 對應的位置，並更新 meta.json 裡的路徑。
fn move_dir(root: &Path, dir: &Path, new_path: &Path) {
    let target = file_dir(root, new_path);
    if !dir.is_dir() || target.exists() {
        return;
    }
    if fs::rename(dir, &target).is_ok() {
        let latest = read_meta(&target).and_then(|m| m["latest"].as_str().map(str::to_string));
        let _ = write_meta(&target, &new_path.to_string_lossy(), latest.as_deref());
    }
}

fn root(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join("history"))
}

/// 依總量上限與檔案是否還在，清理版本記錄（見模組說明）。`gone` 判斷原始檔案是否確定不在了
/// （網路磁碟、遠端的檔案可能只是暫時連不上，一律當作還在）。回傳刪掉的位元組數。
pub fn maintain_at(root: &Path, now: u64, quota: u64, gone: &dyn Fn(&Path) -> bool) -> u64 {
    let mut freed = 0;
    // (版本編號, 大小, 檔案路徑)：每個檔案最新的一版不列入，總量超過時從最舊的刪起。
    let mut deletable: Vec<(u64, u64, PathBuf)> = vec![];
    let mut total = 0;
    for entry in fs::read_dir(root).into_iter().flatten().flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let list = versions(&dir);
        let original = read_meta(&dir).and_then(|m| m["path"].as_str().map(PathBuf::from));
        let newest = list.first().map(|(v, _)| v.id).unwrap_or(0);
        let orphan = match &original {
            Some(p) => gone(p) && now.saturating_sub(newest) > ORPHAN_AGE_MS,
            None => list.is_empty(),
        };
        if orphan {
            freed += list.iter().map(|(v, _)| v.size).sum::<u64>();
            let _ = fs::remove_dir_all(&dir);
            continue;
        }
        for (i, (v, file)) in list.into_iter().enumerate() {
            total += v.size;
            if i > 0 {
                deletable.push((v.id, v.size, file));
            }
        }
    }
    deletable.sort_by_key(|(id, _, _)| *id);
    for (_, size, file) in deletable {
        if total <= quota {
            break;
        }
        if fs::remove_file(&file).is_ok() {
            total -= size;
            freed += size;
        }
    }
    freed
}

/// 啟動一陣子後在背景清理版本記錄（不影響開啟速度）。
pub fn maintain(app: &AppHandle) {
    let Some(root) = root(app) else {
        return;
    };
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(60));
        let gone = |p: &Path| {
            let s = p.to_string_lossy();
            !crate::dav::is_remote_path(&s) && !crate::io::is_network_path(p) && !p.exists()
        };
        maintain_at(&root, now_ms(), QUOTA_BYTES, &gone);
    });
}

struct Job {
    root: PathBuf,
    path: PathBuf,
    before: Option<String>,
    text: String,
    now: u64,
}

/// 版本記錄的寫入佇列：一個背景執行緒依序處理，存檔不必等版本記錄寫完。
static QUEUE: LazyLock<Mutex<Sender<Job>>> = LazyLock::new(|| {
    let (tx, rx) = channel::<Job>();
    std::thread::spawn(move || {
        for job in rx {
            if let Some(before) = &job.before {
                if let Err(e) = record_at(&job.root, &job.path, before, Kind::Disk, job.now) {
                    // i18n-ignore：記錄檔
                    eprintln!("無法保存版本記錄：{e}");
                }
            }
            if let Err(e) = record_at(&job.root, &job.path, &job.text, Kind::Save, job.now) {
                // i18n-ignore：記錄檔
                eprintln!("無法保存版本記錄：{e}");
            }
        }
    });
    Mutex::new(tx)
});

/// 存檔時呼叫：先記下存檔前磁碟上的內容（若和上一版不同），再記下新內容。
/// 在背景寫入；版本記錄失敗不影響存檔。
pub fn on_save(app: &AppHandle, path: &Path, disk_before: Option<&[u8]>, text: &str) {
    let Some(root) = root(app) else {
        return;
    };
    if text.len() > MAX_FILE_BYTES {
        return;
    }
    let before = disk_before
        .filter(|b| b.len() <= MAX_FILE_BYTES)
        .map(|b| decode(b).0)
        .filter(|before| before != text);
    let job = Job {
        root,
        path: path.to_path_buf(),
        before,
        text: text.to_string(),
        now: now_ms(),
    };
    let _ = QUEUE.lock().unwrap().send(job);
}

pub fn on_rename(app: &AppHandle, from: &Path, to: &Path) {
    if let Some(root) = root(app) {
        rename_at(&root, from, to);
    }
}

/// 只能查看可以開啟的檔案的版本記錄（和重新開啟檔案的規則相同）。
fn allowed(
    app: &AppHandle,
    path: &Path,
    known: &KnownFiles,
    trust: &Trust,
    workspace: &Workspace,
) -> Result<(), String> {
    let remote = path
        .to_str()
        .is_some_and(|p| crate::dav::is_remote_path(p) && app.state::<crate::dav::Dav>().allows(p));
    if remote || known.contains(path) || trust.allows(path) || workspace.contains(path) {
        Ok(())
    } else {
        Err(tr!("無法查看這個檔案的版本記錄"))
    }
}

/// 版本記錄的讀取與權限判斷都要讀磁碟（權限判斷可能要解析網路磁碟上的路徑），在背景執行。
#[tauri::command]
pub async fn history_list(app: AppHandle, path: String) -> Result<Vec<Version>, String> {
    crate::io::blocking(move || {
        let path = PathBuf::from(path);
        allowed(
            &app,
            &path,
            &app.state::<KnownFiles>(),
            &app.state::<Trust>(),
            &app.state::<Workspace>(),
        )?;
        Ok(root(&app).map(|r| list_at(&r, &path)).unwrap_or_default())
    })
    .await
}

#[tauri::command]
pub async fn history_read(app: AppHandle, path: String, id: u64) -> Result<String, String> {
    crate::io::blocking(move || {
        let path = PathBuf::from(path);
        allowed(
            &app,
            &path,
            &app.state::<KnownFiles>(),
            &app.state::<Trust>(),
            &app.state::<Workspace>(),
        )?;
        let root = root(&app).ok_or_else(|| tr!("找不到版本記錄資料夾"))?;
        read_at(&root, &path, id).map_err(|e| tr!("無法讀取版本：{e}", e = e))
    })
    .await
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
    fn coalesces_frequent_saves() {
        let root = temp("coalesce");
        let file = Path::new("/筆記/自動存檔.md");
        let s = 1000;
        // 每 1.5 秒自動存檔一次，持續 3 分鐘。
        for i in 0..=120u64 {
            record_at(&root, file, &format!("v{i}"), Kind::Save, i * 1500).unwrap();
        }
        let ids: Vec<u64> = list_at(&root, file).iter().map(|v| v.id).collect();
        // 保留第一版、2 分鐘後的第一版，以及最新的一版。
        assert_eq!(ids, [180 * s, 120 * s, 0]);
        assert_eq!(read_at(&root, file, 180 * s).unwrap(), "v120");
        // 外部修改（disk）一定保留，之後的存檔也不會把它合併掉。
        record_at(&root, file, "別的程式改的", Kind::Disk, 181 * s).unwrap();
        record_at(&root, file, "v121", Kind::Save, 181 * s).unwrap();
        record_at(&root, file, "v122", Kind::Save, 182 * s).unwrap();
        let list = list_at(&root, file);
        let kinds: Vec<(u64, Kind)> = list.iter().map(|v| (v.id, v.kind)).collect();
        assert_eq!(
            kinds,
            [
                (182 * s, Kind::Save),
                (181 * s + 1, Kind::Save),
                (181 * s, Kind::Disk),
                (180 * s, Kind::Save),
                (120 * s, Kind::Save),
                (0, Kind::Save),
            ]
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn prunes_by_count_and_age() {
        let root = temp("prune");
        let file = Path::new("/筆記/a.md");
        let day = 24 * 60 * 60 * 1000;
        // 60 版（間隔夠久，不會被合併），前 45 版在 40 天前。
        let gap = COALESCE_MS;
        for i in 0..60u64 {
            let t = if i < 45 { i * gap } else { 40 * day + i * gap };
            record_at(&root, file, &format!("v{i}"), Kind::Save, t).unwrap();
        }
        let list = list_at(&root, file);
        // 最後一次存檔時「現在」是 40 天後：舊的 45 版只留到湊滿 10 版為止。
        assert_eq!(list.len(), 15);
        assert_eq!(list[0].id, 40 * day + 59 * gap);
        // 版本數上限。
        let root2 = temp("cap");
        for i in 0..60u64 {
            record_at(&root2, file, &format!("v{i}"), Kind::Save, 1000 + i * gap).unwrap();
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
    fn renaming_one_file_moves_only_its_history() {
        let root = temp("rename-file");
        let work = temp("rename-work");
        fs::create_dir_all(&work).unwrap();
        let (from, to) = (work.join("a.md"), work.join("b.md"));
        record_at(&root, &from, "A", Kind::Save, 1).unwrap();
        record_at(&root, &work.join("其他.md"), "X", Kind::Save, 1).unwrap();
        fs::write(&to, "A").unwrap();
        rename_at(&root, &from, &to);
        assert_eq!(read_at(&root, &to, 1).unwrap(), "A");
        assert!(list_at(&root, &from).is_empty());
        assert_eq!(list_at(&root, &work.join("其他.md")).len(), 1);
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&work).unwrap();
    }

    #[test]
    fn skips_big_files_and_compares_by_hash() {
        let root = temp("big");
        let file = Path::new("/筆記/大.md");
        record_at(&root, file, &"字".repeat(MAX_FILE_BYTES), Kind::Save, 1).unwrap();
        assert!(list_at(&root, file).is_empty());
        // 有記雜湊時，即使上一版的檔案內容被動過，也以雜湊判斷相同。
        let small = Path::new("/筆記/小.md");
        record_at(&root, small, "內容", Kind::Save, 1).unwrap();
        let dir = file_dir(&root, small);
        assert!(read_meta(&dir).unwrap()["latest"].is_string());
        record_at(&root, small, "內容", Kind::Save, 2).unwrap();
        assert_eq!(list_at(&root, small).len(), 1);
        // 舊版沒有雜湊：讀出上一版比對。
        write_meta(&dir, "/筆記/小.md", None).unwrap();
        record_at(&root, small, "內容", Kind::Save, 3).unwrap();
        assert_eq!(list_at(&root, small).len(), 1);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn maintains_quota_and_removes_orphans() {
        let root = temp("maintain");
        let day = 24 * 60 * 60 * 1000;
        let now = 200 * day;
        let gap = COALESCE_MS;
        // a.md：5 版，每版 100 位元組；b.md：已經刪掉的檔案，最新一版在 100 天前；c.md：刪掉但最近才改過。
        for i in 0..5u64 {
            record_at(
                &root,
                Path::new("/w/a.md"),
                &format!("{i}{}", "a".repeat(99)),
                Kind::Save,
                now - 10 * gap + i * gap,
            )
            .unwrap();
        }
        record_at(
            &root,
            Path::new("/w/b.md"),
            "B",
            Kind::Save,
            now - 100 * day,
        )
        .unwrap();
        record_at(&root, Path::new("/w/c.md"), "C", Kind::Save, now - day).unwrap();
        let gone = |p: &Path| p != Path::new("/w/a.md");
        // 上限 250 位元組：a.md 刪到剩 2 版（含最新一版）；b.md 整個刪掉；c.md 留著。
        let freed = maintain_at(&root, now, 250, &gone);
        assert_eq!(freed, 301);
        let a = list_at(&root, Path::new("/w/a.md"));
        assert_eq!(a.len(), 2);
        assert_eq!(a[0].id, now - 10 * gap + 4 * gap);
        assert!(list_at(&root, Path::new("/w/b.md")).is_empty());
        assert!(!file_dir(&root, Path::new("/w/b.md")).exists());
        assert_eq!(list_at(&root, Path::new("/w/c.md")).len(), 1);
        // 最新的一版永遠保留，就算超過上限。
        maintain_at(&root, now, 0, &|_| false);
        assert_eq!(list_at(&root, Path::new("/w/a.md")).len(), 1);
        assert_eq!(list_at(&root, Path::new("/w/c.md")).len(), 1);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ignores_unknown_files() {
        assert_eq!(parse_name("123-save.txt"), Some((123, Kind::Save)));
        assert_eq!(parse_name("meta.json"), None);
        assert_eq!(parse_name("x-save.txt"), None);
    }
}
