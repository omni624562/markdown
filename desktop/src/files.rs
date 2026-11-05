//! 單一檔案的讀寫：編碼判斷、保留換行格式、安全存檔與衝突偵測。

use parking_lot::Mutex;
use std::collections::HashMap;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, Window};

use crate::trust::Trust;

pub use crate::text_encoding::{decode, encode, FileFormat};
use crate::text_encoding::{decode_as, TextEncoding, Unencodable};

/// 已知檔案的狀態：原本的格式，以及最後一次和編輯器同步時內容的雜湊。
#[derive(Clone, Copy, Default)]
pub struct FileState {
    pub format: FileFormat,
    /// 用來判斷檔案是否被別的程式改過。
    pub hash: Option<u64>,
    /// 開啟（或存檔）時檔案所在資料夾的實際位置（見 [`dir_id`]）；讀不到時是 None。
    pub dir: Option<u64>,
}

/// 檔案所在資料夾解析符號連結後的位置，取雜湊（Windows 不分大小寫）。資料夾讀不到時是 None。
///
/// 已知檔案是用路徑記的；同一個路徑中途的資料夾如果被換成指向別處的連結（例如工作區裡原本就有、
/// 指向外面的連結被改名過來），之後的讀寫就會跑到別的地方。存檔前比對這個值，不一樣就不寫。
pub fn dir_id(path: &Path) -> Option<u64> {
    let dir = dunce::canonicalize(path.parent()?).ok()?;
    let s = dir.to_string_lossy();
    let s = if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.into_owned()
    };
    Some(hash_bytes(s.as_bytes()))
}

/// 前端可以寫入的檔案（使用者選過、從命令列帶入或在工作區中開啟的）及其狀態。
#[derive(Default)]
pub struct KnownFiles(pub Mutex<HashMap<PathBuf, FileState>>);

impl KnownFiles {
    pub fn contains(&self, path: &Path) -> bool {
        self.0.lock().contains_key(path)
    }

    pub fn stored_hash(&self, path: &Path) -> Option<u64> {
        self.0.lock().get(path).and_then(|s| s.hash)
    }

    /// 開過的檔案所在的資料夾，實際位置和開啟時記下的不同（中途被換成指向別處的連結，或被搬走）。
    /// 不是開過的檔案、或現在讀不到資料夾時回傳 false（讀不到時，之後的讀寫本來就會失敗）。
    /// 會讀取磁碟，請在背景執行。
    pub fn moved(&self, path: &Path) -> bool {
        let Some(before) = self.0.lock().get(path).and_then(|s| s.dir) else {
            return false;
        };
        dir_id(path).is_some_and(|now| now != before)
    }

    /// 見 [`KnownFiles::moved`]：位置變了就不讀寫，請使用者重新選取檔案。
    pub fn check_moved(&self, path: &Path) -> Result<(), String> {
        if self.moved(path) {
            Err(tr!(
                "「{name}」所在的資料夾和開啟時不同（可能被改名、搬移，或換成了連結），為了安全沒有讀寫。請重新從「開啟檔案」選取。",
                name = display_name(path)
            ))
        } else {
            Ok(())
        }
    }

    /// 檔案被改名或搬移時，沿用原本的狀態（資料夾的位置換成新的）。會讀取磁碟，請在背景執行。
    pub fn rename(&self, from: &Path, to: &Path) {
        let moved: Vec<(PathBuf, PathBuf, FileState)> = self
            .0
            .lock()
            .iter()
            .filter(|(p, _)| p.starts_with(from))
            .map(|(p, s)| {
                let suffix = p.strip_prefix(from).unwrap_or(Path::new(""));
                (p.clone(), to.join(suffix), *s)
            })
            .collect();
        let moved: Vec<_> = moved
            .into_iter()
            .map(|(old, new, state)| {
                let dir = dir_id(&new);
                (old, new, FileState { dir, ..state })
            })
            .collect();
        let mut map = self.0.lock();
        for (old, new, state) in moved {
            map.remove(&old);
            map.insert(new, state);
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub path: String,
    pub name: String,
    pub text: String,
    /// 檔案的編碼（`"utf-8"`、`"utf-16le"`、`"big5"`…，見 `text_encoding::CHOICES`）；
    /// 解讀不乾淨（會有亂碼）時為 `"unknown"`。
    pub encoding: &'static str,
}

impl OpenedFile {
    pub fn new(path: String, name: String, text: String, encoding: &'static str) -> Self {
        OpenedFile {
            path,
            name,
            text,
            encoding,
        }
    }
}

impl SaveOutcome {
    pub fn saved(path: String, name: String) -> Self {
        SaveOutcome::Saved { path, name }
    }

    pub fn conflict(path: String, name: String, disk_text: String) -> Self {
        SaveOutcome::Conflict {
            path,
            name,
            disk_text,
        }
    }
}

/// 存檔結果。
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SaveOutcome {
    Saved {
        path: String,
        name: String,
    },
    /// 檔案在開啟後被別的程式改過；附上磁碟上的目前內容，讓使用者比較或決定覆蓋。
    #[serde(rename_all = "camelCase")]
    Conflict {
        path: String,
        name: String,
        disk_text: String,
    },
    /// 檔案的編碼（例如 Big5）寫不進某些字：沒有寫入，前端問使用者要不要改存成 UTF-8。
    Unencodable {
        path: String,
        name: String,
        encoding: &'static str,
        chars: String,
    },
    Cancelled,
}

pub fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

pub fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

pub fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// 內容看起來不是能編輯的文字時回傳原因（接在檔名後面顯示）；是文字時回傳 `None`。
pub fn not_text_reason(bytes: &[u8]) -> Option<String> {
    // 有 BOM 的 UTF-16 是文字（裡面一定有 NUL 位元組，不能用下面的判斷）。
    if bytes.starts_with(b"\xFF\xFE") || bytes.starts_with(b"\xFE\xFF") {
        return None;
    }
    // 和 Git 一樣：開頭一段裡有 NUL 字元就當成二進位檔。
    let head = &bytes[..bytes.len().min(8192)];
    if head.starts_with(b"%PDF-") || head.contains(&0) {
        return Some(tr!(
            "不是文字檔（可能是圖片、PDF、壓縮檔或執行檔），無法開啟"
        ));
    }
    None
}

/// 編輯器最多開啟多大的檔案。更大的通常不是筆記，整個讀進來只會讓介面卡住。
pub const MAX_OPEN_BYTES: u64 = 64 * 1024 * 1024;

/// 讀取檔案，但最多讀 `limit` 位元組；檔案比這個大時回傳 `None`（不會整個讀進記憶體）。
pub fn read_capped(path: &Path, limit: u64) -> std::io::Result<Option<Vec<u8>>> {
    use std::io::Read;
    let f = fs::File::open(path)?;
    let hint = f.metadata().map(|m| m.len().min(limit)).unwrap_or(0);
    let mut bytes = Vec::with_capacity(hint as usize);
    f.take(limit + 1).read_to_end(&mut bytes)?;
    Ok((bytes.len() as u64 <= limit).then_some(bytes))
}

/// 讀取檔案、登記為已知檔案，並允許預覽顯示同資料夾的圖片。
pub fn read_file(app: &AppHandle, path: PathBuf, known: &KnownFiles) -> Result<OpenedFile, String> {
    let bytes = read_capped(&path, MAX_OPEN_BYTES)
        .map_err(|e| {
            crate::io::describe(&e, &tr!("無法讀取「{name}」", name = display_name(&path)))
        })?
        .ok_or_else(|| {
            tr!(
                "「{name}」超過 {mb} MB，無法開啟",
                name = display_name(&path),
                mb = MAX_OPEN_BYTES / 1024 / 1024
            )
        })?;
    if let Some(why) = not_text_reason(&bytes) {
        return Err(tr!(
            "「{name}」{why}",
            name = display_name(&path),
            why = why
        ));
    }
    let (text, format, encoding) = decode(&bytes);
    known.0.lock().insert(
        path.clone(),
        FileState {
            format,
            hash: Some(hash_bytes(&bytes)),
            dir: dir_id(&path),
        },
    );
    crate::track_file(app, &path);
    Ok(OpenedFile {
        path: path_string(&path),
        name: display_name(&path),
        text,
        encoding,
    })
}

/// 存檔用的暫存檔名：`.<檔名>.<16 個十六進位亂數>.tmp`。
///
/// 名稱無法事先猜到，而且一律用 `create_new` 建立：別人在共用資料夾預先放好的同名檔案
/// 或符號連結，不會讓存檔寫到工作區外的檔案。
fn temp_name(name: &str) -> String {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        // 幾乎不會發生。退回用時間與行程編號；就算被猜到，create_new 也不會寫進別人的檔案。
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        bytes = (nanos ^ (u64::from(std::process::id()) << 32)).to_le_bytes();
    }
    format!(".{name}.{:016x}.tmp", u64::from_le_bytes(bytes))
}

/// 是不是 [`write_atomic`] 產生的暫存檔（檔案監看要忽略它們）。
pub fn is_temp_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix('.').and_then(|n| n.strip_suffix(".tmp")) else {
        return false;
    };
    rest.rsplit_once('.').is_some_and(|(base, hex)| {
        !base.is_empty() && hex.len() == 16 && hex.bytes().all(|b| b.is_ascii_hexdigit())
    })
}

/// 先寫到同一個資料夾的暫存檔、確實寫入磁碟後再取代原檔，
/// 避免寫到一半斷電或磁碟滿時留下殘缺的檔案。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_atomic_with(path, bytes, false)
}

/// 和 [`write_atomic`] 相同，但檔案只有自己能讀寫（Unix 上權限是 0600）。用來存權杖之類的祕密。
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_atomic_with(path, bytes, true)
}

fn open_options(private: bool) -> fs::OpenOptions {
    let mut opts = fs::OpenOptions::new();
    opts.write(true);
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    #[cfg(not(unix))]
    let _ = private;
    opts
}

fn write_atomic_with(path: &Path, bytes: &[u8], private: bool) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = display_name(path);
    let mut opts = open_options(private);
    opts.create_new(true);
    // 亂數撞名的機率極低，還是重試幾次。
    let mut created = Err(std::io::Error::other(tr!("無法建立暫存檔")));
    for _ in 0..3 {
        let tmp = dir.join(temp_name(&name));
        match opts.open(&tmp) {
            Ok(f) => {
                created = Ok((tmp, f));
                break;
            }
            Err(e) => {
                let again = e.kind() == std::io::ErrorKind::AlreadyExists;
                created = Err(e);
                if !again {
                    break;
                }
            }
        }
    }
    let (tmp, mut f) = match created {
        Ok(c) => c,
        // 資料夾不能新增檔案（只有原檔可寫）時才退回直接覆寫；磁碟已滿之類的錯誤直接回報，
        // 免得先截斷原檔再寫入失敗，把原檔弄壞。
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return overwrite_in_place(path, bytes, private).map_err(|_| e);
        }
        Err(e) => return Err(e),
    };
    if let Err(e) = f.write_all(bytes).and_then(|_| f.sync_all()) {
        // 暫存檔沒寫完整（磁碟已滿、網路磁碟斷線）：原檔還是好的，不要動它。
        drop(f);
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    drop(f);
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            // 只刪自己建立的暫存檔。
            let _ = fs::remove_file(&tmp);
            // 無法取代（例如原檔正被其他程式以不允許刪除的方式開著）：新內容確定寫得進去，才退回直接覆寫。
            overwrite_in_place(path, bytes, private).map_err(|_| e)
        }
    }
}

/// 直接覆寫原檔。原檔是符號連結時拒絕：直接覆寫會寫到連結指向的檔案，可能在工作區外。
fn overwrite_in_place(path: &Path, bytes: &[u8], private: bool) -> std::io::Result<()> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            tr!("這個檔案是符號連結，不直接覆寫"),
        ));
    }
    let mut opts = open_options(private);
    opts.create(true).truncate(true);
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

/// 寫入檔案，回傳寫入內容的雜湊。
fn write_file(path: &Path, bytes: &[u8]) -> Result<u64, String> {
    write_atomic(path, bytes).map_err(|e| {
        crate::io::describe(&e, &tr!("無法寫入「{name}」", name = display_name(path)))
    })?;
    Ok(hash_bytes(bytes))
}

/// 檔案的編碼寫不進某些字時的存檔結果（沒有寫入）。
fn unencodable(path: &Path, format: FileFormat, u: Unencodable) -> SaveOutcome {
    SaveOutcome::Unencodable {
        path: path_string(path),
        name: display_name(path),
        encoding: format.encoding.id(),
        chars: u.chars,
    }
}

/// 磁碟上的檔案和最後一次讀寫時是否不同。檔案不存在時不算衝突（直接重新建立）。
pub fn changed_on_disk(stored: Option<u64>, disk: Option<&[u8]>) -> bool {
    matches!((stored, disk), (Some(h), Some(bytes)) if hash_bytes(bytes) != h)
}

fn saved(path: &Path) -> SaveOutcome {
    SaveOutcome::Saved {
        name: display_name(path),
        path: path_string(path),
    }
}

/// 跳出開檔對話框並讀取選到的檔案；使用者取消時回傳 `None`。
#[tauri::command]
pub async fn open_file(
    app: AppHandle,
    window: Window,
    trust: State<'_, Trust>,
) -> Result<Option<OpenedFile>, String> {
    let picked = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title(tr!("開啟檔案"))
        .add_filter(tr!("文件與程式碼"), crate::workspace::DOC_EXTENSIONS)
        .add_filter(tr!("所有檔案"), &["*"])
        .pick_file()
        .await;
    let Some(handle) = picked else {
        return Ok(None);
    };
    let path = handle.path().to_path_buf();
    let opened = read_in_background(&app, path.clone()).await?;
    trust.add_file(&app, &path);
    Ok(Some(opened))
}

/// 前端可以用路徑開啟的檔案：這次開過的、信任清單（最近開啟、左側圖示列的捷徑）裡的，
/// 或目前開啟的資料夾裡的文件（解析符號連結後也是，見 `workspace::is_editable_doc_in`）。
/// 這次開過、但所在資料夾的實際位置已經和開啟時不同的（見 [`KnownFiles::moved`]），
/// 只有在資料夾裡的文件才行。要讀取磁碟，請在背景執行。
pub(crate) fn may_reopen(app: &AppHandle, path: &Path) -> bool {
    let known = app.state::<KnownFiles>();
    let opened = !known.moved(path) && (known.contains(path) || app.state::<Trust>().allows(path));
    opened
        || app
            .state::<crate::workspace::Workspace>()
            .has_editable_doc(path)
}

/// 重新開啟先前開過的檔案（還原分頁、最近開啟、左側圖示列的捷徑）。只允許信任清單裡的路徑。
#[tauri::command]
pub async fn reopen_file(
    app: AppHandle,
    path: String,
    trust: State<'_, Trust>,
) -> Result<OpenedFile, String> {
    let path = PathBuf::from(path);
    let app2 = app.clone();
    let p = path.clone();
    let opened = crate::io::blocking(move || {
        if !may_reopen(&app2, &p) {
            return Err(tr!(
                "這個檔案不在最近開啟的清單中，請重新從「開啟檔案」選取。"
            ));
        }
        read_file(&app2, p, &app2.state::<KnownFiles>())
    })
    .await?;
    trust.add_file(&app, &path);
    Ok(opened)
}

/// 狀態列顯示的檔案格式：存檔時用的編碼、換行與 BOM。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatInfo {
    encoding: &'static str,
    crlf: bool,
    bom: bool,
}

impl From<FileFormat> for FormatInfo {
    fn from(f: FileFormat) -> Self {
        FormatInfo {
            encoding: f.encoding.id(),
            crlf: f.crlf,
            bom: f.bom,
        }
    }
}

/// 檔案存檔時用的格式；不是開過的本機檔案時回傳 `None`（狀態列不顯示編碼與換行）。
#[tauri::command]
pub fn file_format(known: State<'_, KnownFiles>, path: String) -> Option<FormatInfo> {
    known
        .0
        .lock()
        .get(Path::new(&path))
        .map(|s| s.format.into())
}

/// 換存檔時用的編碼、換行或 BOM（狀態列的選單），下次存檔生效。
/// UTF-16 一律加 BOM（沒有 BOM 下次開啟時認不出來）；Big5 等編碼沒有 BOM。
/// 給了 `text`（目前的內容）時，先確認新的編碼寫得進去。
#[tauri::command]
pub fn set_file_format(
    known: State<'_, KnownFiles>,
    path: String,
    encoding: Option<String>,
    crlf: Option<bool>,
    bom: Option<bool>,
    text: Option<String>,
) -> Result<FormatInfo, String> {
    let mut map = known.0.lock();
    let state = map
        .get_mut(Path::new(&path))
        .ok_or_else(|| tr!("這份文件還沒存成檔案"))?;
    let mut next = state.format;
    let format = &mut next;
    if let Some(id) = encoding {
        format.encoding =
            TextEncoding::from_id(&id).ok_or_else(|| tr!("不支援的編碼：{id}", id = id))?;
    }
    if let Some(crlf) = crlf {
        format.crlf = crlf;
    }
    format.bom = match format.encoding {
        TextEncoding::Utf8 => bom.unwrap_or(format.bom),
        TextEncoding::Utf16Le | TextEncoding::Utf16Be => true,
        TextEncoding::Other(_) => false,
    };
    // 新的編碼寫不進目前的內容（例如換成 Big5 但有表情符號）：不換，告訴使用者是哪些字。
    if let Some(text) = text {
        if let Err(u) = encode(&text, next) {
            return Err(tr!(
                "{encoding} 存不了這幾個字：{chars}",
                encoding = next.encoding.label(),
                chars = u.chars
            ));
        }
    }
    state.format = next;
    Ok(next.into())
}

/// 用指定的編碼重新讀取開過的檔案（畫面上是亂碼時，在狀態列選另一種編碼）。
/// 之後存檔也用這個編碼。
#[tauri::command]
pub async fn reopen_with_encoding(
    app: AppHandle,
    path: String,
    encoding: String,
) -> Result<OpenedFile, String> {
    let enc =
        TextEncoding::from_id(&encoding).ok_or_else(|| tr!("不支援的編碼：{id}", id = encoding))?;
    let path = PathBuf::from(path);
    crate::io::blocking(move || {
        let known = app.state::<KnownFiles>();
        if !known.contains(&path) {
            return Err(tr!(
                "這個檔案不在最近開啟的清單中，請重新從「開啟檔案」選取。"
            ));
        }
        known.check_moved(&path)?;
        let bytes = read_capped(&path, MAX_OPEN_BYTES)
            .map_err(|e| {
                crate::io::describe(&e, &tr!("無法讀取「{name}」", name = display_name(&path)))
            })?
            .ok_or_else(|| {
                tr!(
                    "「{name}」超過 {mb} MB，無法開啟",
                    name = display_name(&path),
                    mb = MAX_OPEN_BYTES / 1024 / 1024
                )
            })?;
        let (text, format, lossy) = decode_as(&bytes, enc);
        known.0.lock().insert(
            path.clone(),
            FileState {
                format,
                hash: Some(hash_bytes(&bytes)),
                dir: dir_id(&path),
            },
        );
        Ok(OpenedFile {
            name: display_name(&path),
            path: path_string(&path),
            text,
            encoding: if lossy { "unknown" } else { enc.id() },
        })
    })
    .await
}

/// 左側圖示列上的檔案捷徑（前端的清單改變時送整份）：記在信任清單，之後就算很久沒開、
/// 被擠出「最近開啟」，按捷徑也開得了。新加的只接受目前就能開啟的檔案（`may_reopen`）。
#[tauri::command]
pub async fn set_file_shortcuts(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    let paths: Vec<PathBuf> = paths.into_iter().take(64).map(PathBuf::from).collect();
    crate::io::blocking(move || {
        app.state::<Trust>()
            .set_shortcuts(&app, paths, |p| may_reopen(&app, p));
        Ok(())
    })
    .await
}

/// 在背景執行緒讀取檔案（網路磁碟斷線時不會卡住介面）。
pub async fn read_in_background(app: &AppHandle, path: PathBuf) -> Result<OpenedFile, String> {
    let app = app.clone();
    crate::io::blocking(move || read_file(&app, path, &app.state::<KnownFiles>())).await
}

/// 匯出二進位檔（例如 Word .docx）：讓使用者選位置後寫入。取消時回傳 None。
#[tauri::command]
pub async fn export_binary(
    window: Window,
    suggested_name: String,
    data_base64: String,
    filter_name: String,
    extensions: Vec<String>,
) -> Result<Option<String>, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| tr!("匯出的資料無效：{e}", e = e))?;
    let exts: Vec<&str> = extensions
        .iter()
        .map(|e| e.trim_start_matches('.'))
        .collect();
    let picked = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title(tr!("匯出"))
        .set_file_name(&suggested_name)
        .add_filter(&filter_name, &exts)
        .save_file()
        .await;
    let Some(handle) = picked else {
        return Ok(None);
    };
    let path = handle.path().to_path_buf();
    let p = path.clone();
    crate::io::blocking(move || {
        write_atomic(&p, &bytes).map_err(|e| crate::io::describe(&e, &tr!("無法寫入檔案")))
    })
    .await?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// 匯入 Word 時選到的檔案，以及要轉存的 Markdown 檔位置。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxImport {
    pub name: String,
    pub md_path: String,
}

/// 剛選好的 Word 檔內容，等前端用 `import_docx_data` 以原始位元組取走
/// （不用 base64 包在 JSON 裡：100 MB 的檔案光是轉換就要多佔好幾倍記憶體）。
static DOCX_DATA: Mutex<Option<Vec<u8>>> = Mutex::new(None);

/// Word 檔最大多大（含圖片）。
const MAX_DOCX_BYTES: u64 = 100 * 1024 * 1024;

/// 和 `path` 同一個資料夾、還沒有人用的 `名稱.md`（已經有了就用「名稱 (2).md」）。
pub fn unique_md_path(path: &Path) -> PathBuf {
    let dir = path.parent().unwrap_or(Path::new("."));
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| tr!("匯入"));
    let mut candidate = dir.join(format!("{stem}.md"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} ({n}).md"));
        n += 1;
    }
    candidate
}

/// 匯入 Word：選擇 .docx，讀出內容，並把旁邊的 `名稱.md` 登記為可以寫入的檔案
/// （前端轉換時把圖片存到旁邊的 assets，再寫入這個檔案）。取消時回傳 None。
#[tauri::command]
pub async fn import_docx(
    app: AppHandle,
    window: Window,
    known: State<'_, KnownFiles>,
    trust: State<'_, Trust>,
) -> Result<Option<DocxImport>, String> {
    let picked = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title(tr!("匯入 Word 文件"))
        .add_filter(tr!("Word 文件"), &["docx"])
        .pick_file()
        .await;
    let Some(handle) = picked else {
        return Ok(None);
    };
    let path = handle.path().to_path_buf();
    let p = path.clone();
    let (bytes, dir) = crate::io::blocking(move || {
        let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        if size > MAX_DOCX_BYTES {
            return Err(tr!(
                "「{name}」超過 100 MB，無法匯入",
                name = display_name(&p)
            ));
        }
        let bytes = fs::read(&p).map_err(|e| {
            crate::io::describe(&e, &tr!("無法讀取「{name}」", name = display_name(&p)))
        })?;
        Ok((bytes, dir_id(&p)))
    })
    .await?;
    let md = unique_md_path(&path);
    known.0.lock().insert(
        md.clone(),
        FileState {
            dir,
            ..FileState::default()
        },
    );
    trust.add_file(&app, &md);
    Ok(Some(DocxImport {
        name: display_name(&path),
        md_path: path_string(&md),
    }))
    .inspect(|_| *DOCX_DATA.lock() = Some(bytes))
}

/// 取走 `import_docx` 剛讀到的 Word 檔內容（原始位元組）。
#[tauri::command]
pub fn import_docx_data() -> Result<tauri::ipc::Response, String> {
    let bytes = DOCX_DATA
        .lock()
        .take()
        .ok_or_else(|| tr!("沒有要匯入的 Word 檔"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 匯出 Word 用的圖片（前端讀好、需要時轉成 PNG；`data` 是 Base64）。
#[derive(Deserialize)]
pub struct DocxImageData {
    url: String,
    /// `png`、`jpg`、`gif` 或 `bmp`。
    kind: String,
    width: u32,
    height: u32,
    data: String,
}

/// 匯出 Word：把 Markdown 轉成 .docx，回傳檔案內容（原始位元組）。
/// 圖片由前端先讀好（以 Markdown 裡寫的網址為鍵），因為 WebP、SVG 這類格式要靠瀏覽器轉成 PNG。
#[tauri::command]
pub async fn export_docx(
    markdown: String,
    title: String,
    images: Vec<DocxImageData>,
) -> Result<tauri::ipc::Response, String> {
    use base64::Engine;
    use md_docx::{Image, ImageKind};
    let bytes = crate::io::blocking(move || {
        let images = images
            .into_iter()
            .filter_map(|i| {
                let kind = match i.kind.as_str() {
                    "png" => ImageKind::Png,
                    "jpg" => ImageKind::Jpeg,
                    "gif" => ImageKind::Gif,
                    "bmp" => ImageKind::Bmp,
                    _ => return None,
                };
                let data = base64::engine::general_purpose::STANDARD
                    .decode(i.data)
                    .ok()?;
                let image = Image {
                    data,
                    kind,
                    width: i.width,
                    height: i.height,
                };
                Some((i.url, image))
            })
            .collect();
        let missing = |alt: &str| tr!("［圖片：{alt}］", alt = alt);
        let opts = md_docx::Options {
            title: &title,
            images: &images,
            missing_image: &missing,
        };
        Ok(md_docx::markdown_to_docx(&markdown, &opts))
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 儲存文字檔。`path` 是先前開啟或存過的檔案時直接覆寫；否則跳出另存新檔對話框。
///
/// 覆寫前會檢查檔案是否在開啟後被別的程式改過，有的話回傳 `Conflict`，
/// 除非 `force` 為 true（使用者已確認要覆蓋）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn save_file(
    app: AppHandle,
    window: Window,
    known: State<'_, KnownFiles>,
    trust: State<'_, Trust>,
    path: Option<String>,
    suggested_name: String,
    text: String,
    filter_name: String,
    extensions: Vec<String>,
    force: Option<bool>,
) -> Result<SaveOutcome, String> {
    if let Some(path) = path.map(PathBuf::from) {
        if known.contains(&path) {
            let app = app.clone();
            let force = force.unwrap_or(false);
            return crate::io::blocking(move || overwrite(&app, &path, &text, force)).await;
        }
    }

    let exts: Vec<&str> = extensions
        .iter()
        .map(|e| e.trim_start_matches('.'))
        .collect();
    let picked = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title(tr!("另存新檔"))
        .set_file_name(&suggested_name)
        .add_filter(&filter_name, &exts)
        .save_file()
        .await;
    let Some(handle) = picked else {
        return Ok(SaveOutcome::Cancelled);
    };
    let path = handle.path().to_path_buf();
    // 覆寫既有檔案時沿用它原本的換行格式（對話框已經問過使用者要不要取代）。
    let format = known
        .0
        .lock()
        .get(&path)
        .map(|s| s.format)
        .unwrap_or_default();
    let bytes = match encode(&text, format) {
        Ok(bytes) => bytes,
        Err(u) => return Ok(unencodable(&path, format, u)),
    };
    let app2 = app.clone();
    let p = path.clone();
    crate::io::blocking(move || {
        let disk = fs::read(&p).ok();
        let hash = write_file(&p, &bytes)?;
        crate::history::on_save(&app2, &p, disk.as_deref(), &text);
        let dir = dir_id(&p);
        app2.state::<KnownFiles>().0.lock().insert(
            p.clone(),
            FileState {
                format,
                hash: Some(hash),
                dir,
            },
        );
        crate::track_file(&app2, &p);
        Ok(())
    })
    .await?;
    trust.add_file(&app, &path);
    Ok(saved(&path))
}

/// 同一個檔案的存檔一次只做一個：前一次存檔逾時（網路磁碟很慢）但背景還在寫時，
/// 下一次存檔要等它寫完再檢查衝突，較舊的內容才不會比較新的晚寫進去。
fn save_lock(path: &Path) -> std::sync::Arc<Mutex<()>> {
    static LOCKS: std::sync::LazyLock<Mutex<HashMap<PathBuf, std::sync::Arc<Mutex<()>>>>> =
        std::sync::LazyLock::new(Default::default);
    let mut locks = LOCKS.lock();
    // 沒有人在用的鎖順便清掉。
    locks.retain(|_, l| std::sync::Arc::strong_count(l) > 1);
    locks.entry(path.to_path_buf()).or_default().clone()
}

/// 覆寫已開啟過的檔案。磁碟上的內容在開啟後被改過時回傳 `Conflict`（除非 `force`）。
/// 檔案所在資料夾的實際位置和開啟時不同時（見 [`KnownFiles::moved`]）不讀也不寫。
fn overwrite(app: &AppHandle, path: &Path, text: &str, force: bool) -> Result<SaveOutcome, String> {
    let lock = save_lock(path);
    let _guard = lock.lock();
    let known = app.state::<KnownFiles>();
    known.check_moved(path)?;
    let state = known.0.lock().get(path).copied().unwrap_or_default();
    let disk = fs::read(path).ok();
    if !force && changed_on_disk(state.hash, disk.as_deref()) {
        let (disk_text, _, _) = decode(disk.as_deref().unwrap_or_default());
        return Ok(SaveOutcome::Conflict {
            name: display_name(path),
            path: path_string(path),
            disk_text,
        });
    }
    let bytes = match encode(text, state.format) {
        Ok(bytes) => bytes,
        Err(u) => return Ok(unencodable(path, state.format, u)),
    };
    let hash = write_file(path, &bytes)?;
    crate::history::on_save(app, path, disk.as_deref(), text);
    // 開啟時讀不到資料夾的位置（例如網路磁碟斷線）：存檔成功後補記。
    let dir = state.dir.or_else(|| dir_id(path));
    known.0.lock().insert(
        path.to_path_buf(),
        FileState {
            hash: Some(hash),
            dir,
            ..state
        },
    );
    Ok(saved(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_binary_but_not_utf16() {
        assert!(not_text_reason(b"# \xE6\xA8\x99\xE9\xA1\x8C\nabc").is_none());
        assert!(not_text_reason(b"\xA4\xA4\xA4\xE5").is_none());
        assert!(not_text_reason(b"").is_none());
        assert!(not_text_reason(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR").is_some());
        assert!(not_text_reason(b"%PDF-1.7\n").is_some());
        assert!(not_text_reason(b"\xFF\xFEa\0b\0").is_none());
        assert!(not_text_reason(b"a\0b\0").is_some());
    }

    #[test]
    fn imported_markdown_does_not_overwrite() {
        let dir = std::env::temp_dir().join(format!("md-import-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let docx = dir.join("週報.docx");
        assert_eq!(unique_md_path(&docx), dir.join("週報.md"));
        fs::write(dir.join("週報.md"), "已經有了").unwrap();
        assert_eq!(unique_md_path(&docx), dir.join("週報 (2).md"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn atomic_write_replaces_and_cleans_up() {
        let dir = std::env::temp_dir().join(format!("md-editor-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("筆記.md");
        fs::write(&file, "舊內容").unwrap();
        write_atomic(&file, "新內容".as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "新內容");
        let leftovers: Vec<_> = fs::read_dir(&dir).unwrap().collect();
        assert_eq!(leftovers.len(), 1, "暫存檔應該被移走");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn temp_names_are_random_and_recognizable() {
        let a = temp_name("筆記.md");
        let b = temp_name("筆記.md");
        assert_ne!(a, b, "暫存檔名不能被猜到");
        assert!(a.starts_with(".筆記.md.") && a.ends_with(".tmp"), "{a}");
        assert!(is_temp_name(&a));
        assert!(is_temp_name(".a.0123456789abcdef.tmp"));
        assert!(!is_temp_name("筆記.md"));
        assert!(!is_temp_name(".hidden.tmp"));
        assert!(!is_temp_name(".a.1234.tmp"), "舊格式（行程編號）不算");
        assert!(!is_temp_name("..0123456789abcdef.tmp"));
        assert!(!is_temp_name(".a.0123456789abcdeg.tmp"));
    }

    #[test]
    fn reads_are_capped() {
        let dir = std::env::temp_dir().join(format!("md-cap-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("大.md");
        fs::write(&file, b"0123456789").unwrap();
        assert_eq!(read_capped(&file, 10).unwrap().unwrap(), b"0123456789");
        assert_eq!(read_capped(&file, 9).unwrap(), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_never_writes_through_symlinks() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("md-symlink-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("共用")).unwrap();
        let secret = dir.join("工作區外.txt");
        fs::write(&secret, "機密").unwrap();
        let link = dir.join("共用").join("筆記.md");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        // 退回直接覆寫時：原檔是符號連結就拒絕。
        assert!(overwrite_in_place(&link, b"x", false).is_err());
        assert_eq!(fs::read_to_string(&secret).unwrap(), "機密");
        // 一般存檔：取代的是連結本身，連結指向的檔案不受影響。
        write_atomic(&link, "新內容".as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&secret).unwrap(), "機密");
        assert_eq!(fs::read_to_string(&link).unwrap(), "新內容");
        // 祕密檔案只有自己能讀寫。
        let token = dir.join("token");
        write_private(&token, b"abc").unwrap();
        let mode = fs::metadata(&token).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn detects_external_changes() {
        let h = hash_bytes(b"original");
        assert!(!changed_on_disk(Some(h), Some(b"original")));
        assert!(changed_on_disk(Some(h), Some(b"edited elsewhere")));
        // 檔案被刪除，或是第一次存檔：不算衝突。
        assert!(!changed_on_disk(Some(h), None));
        assert!(!changed_on_disk(None, Some(b"anything")));
    }

    /// 開過的檔案所在的資料夾中途被換成指向別處的連結：不能再照開啟時的許可讀寫。
    #[cfg(unix)]
    #[test]
    fn notices_folders_swapped_for_links() {
        let dir = std::env::temp_dir().join(format!("md-moved-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("產品/第1章")).unwrap();
        fs::create_dir_all(dir.join("產品/甲")).unwrap();
        fs::create_dir_all(dir.join("外面")).unwrap();
        let file = dir.join("產品/第1章/筆記.md");
        fs::write(&file, "內容").unwrap();
        fs::write(dir.join("外面/筆記.md"), "機密").unwrap();
        let known = KnownFiles::default();
        let open = |p: &Path| {
            known.0.lock().insert(
                p.to_path_buf(),
                FileState {
                    dir: dir_id(p),
                    ..Default::default()
                },
            );
        };
        open(&file);
        assert!(!known.moved(&file));
        assert!(known.check_moved(&file).is_ok());
        // 沒開過的檔案不在這裡判斷。
        assert!(!known.moved(&dir.join("外面/筆記.md")));
        // 資料夾被改名，原本的位置換成指向外面的連結。
        fs::rename(dir.join("產品/第1章"), dir.join("產品/舊")).unwrap();
        std::os::unix::fs::symlink(dir.join("外面"), dir.join("產品/第1章")).unwrap();
        assert!(known.moved(&file));
        assert!(known.check_moved(&file).is_err());
        // 資料夾不見了（例如網路磁碟斷線）：交給之後的讀寫回報錯誤。
        fs::remove_file(dir.join("產品/第1章")).unwrap();
        assert!(!known.moved(&file));
        // 在 oMarker 裡改名的資料夾：狀態跟著搬，資料夾的位置也換成新的。
        let a = dir.join("產品/甲/a.md");
        fs::write(&a, "a").unwrap();
        open(&a);
        fs::rename(dir.join("產品/甲"), dir.join("產品/乙")).unwrap();
        known.rename(&dir.join("產品/甲"), &dir.join("產品/乙"));
        let b = dir.join("產品/乙/a.md");
        assert!(known.contains(&b));
        assert!(!known.moved(&b));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rename_moves_known_state_including_children() {
        let known = KnownFiles::default();
        known.0.lock().insert(
            PathBuf::from("/w/舊資料夾/a.md"),
            FileState {
                hash: Some(1),
                ..Default::default()
            },
        );
        known.rename(Path::new("/w/舊資料夾"), Path::new("/w/新資料夾"));
        assert_eq!(known.stored_hash(Path::new("/w/新資料夾/a.md")), Some(1));
        assert!(!known.contains(Path::new("/w/舊資料夾/a.md")));
    }
}
