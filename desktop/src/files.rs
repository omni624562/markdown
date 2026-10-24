//! 單一檔案的讀寫：編碼判斷、保留換行格式、安全存檔與衝突偵測。

use std::collections::HashMap;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::trust::Trust;

/// 開啟檔案時記下的格式，存檔時照原樣寫回，避免 Windows 的 CRLF 或 BOM 被悄悄改掉。
#[derive(Clone, Copy, Default)]
pub struct FileFormat {
    crlf: bool,
    bom: bool,
}

/// 已知檔案的狀態：原本的格式，以及最後一次和編輯器同步時內容的雜湊。
#[derive(Clone, Copy, Default)]
pub struct FileState {
    pub format: FileFormat,
    /// 用來判斷檔案是否被別的程式改過。
    pub hash: Option<u64>,
}

/// 前端可以寫入的檔案（使用者選過、從命令列帶入或在工作區中開啟的）及其狀態。
#[derive(Default)]
pub struct KnownFiles(pub Mutex<HashMap<PathBuf, FileState>>);

impl KnownFiles {
    pub fn contains(&self, path: &Path) -> bool {
        self.0.lock().unwrap().contains_key(path)
    }

    pub fn stored_hash(&self, path: &Path) -> Option<u64> {
        self.0.lock().unwrap().get(path).and_then(|s| s.hash)
    }

    /// 檔案被改名或搬移時，沿用原本的狀態。
    pub fn rename(&self, from: &Path, to: &Path) {
        let mut map = self.0.lock().unwrap();
        let moved: Vec<(PathBuf, FileState)> = map
            .iter()
            .filter(|(p, _)| p.starts_with(from))
            .map(|(p, s)| (p.clone(), *s))
            .collect();
        for (old, state) in moved {
            map.remove(&old);
            let suffix = old.strip_prefix(from).unwrap_or(Path::new(""));
            map.insert(to.join(suffix), state);
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub path: String,
    pub name: String,
    pub text: String,
    /// 檔案不是 UTF-8、改用 Big5 解讀時為 `"big5"`；Big5 也解讀不了（會有亂碼）時為 `"unknown"`。
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

/// 解讀檔案內容：優先當 UTF-8（可含 BOM），失敗時改用台灣常見的 Big5。
pub fn decode(bytes: &[u8]) -> (String, FileFormat, &'static str) {
    let (body, bom) = match bytes.strip_prefix(b"\xEF\xBB\xBF") {
        Some(rest) => (rest, true),
        None => (bytes, false),
    };
    let (text, encoding) = match std::str::from_utf8(body) {
        Ok(s) => (s.to_owned(), "utf-8"),
        Err(_) => {
            // Big5 也解不乾淨（例如 Shift-JIS、GBK 或混了壞位元組）：標成 `unknown`，
            // 前端不自動存檔，存檔前先問使用者，免得把原檔換成亂碼。
            let (s, _, had_errors) = encoding_rs::BIG5.decode(body);
            (s.into_owned(), if had_errors { "unknown" } else { "big5" })
        }
    };
    let crlf = text.contains("\r\n");
    // 編輯器內部一律使用 \n，存檔時再依原格式轉回。
    let text = if crlf {
        text.replace("\r\n", "\n")
    } else {
        text
    };
    (text, FileFormat { crlf, bom }, encoding)
}

/// 內容看起來不是能編輯的文字時回傳原因（接在檔名後面顯示）；是文字時回傳 `None`。
pub fn not_text_reason(bytes: &[u8]) -> Option<String> {
    if bytes.starts_with(b"\xFF\xFE") || bytes.starts_with(b"\xFE\xFF") {
        return Some(
            tr!("是 UTF-16 編碼，目前只能開啟 UTF-8 或 Big5 的文字檔。可以用記事本「另存新檔」，編碼選 UTF-8 後再開啟"),
        );
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

pub fn encode(text: &str, format: FileFormat) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + 3);
    if format.bom {
        out.extend_from_slice(b"\xEF\xBB\xBF");
    }
    if format.crlf {
        out.extend_from_slice(text.replace("\r\n", "\n").replace('\n', "\r\n").as_bytes());
    } else {
        out.extend_from_slice(text.as_bytes());
    }
    out
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
    known.0.lock().unwrap().insert(
        path.clone(),
        FileState {
            format,
            hash: Some(hash_bytes(&bytes)),
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
fn write_file(path: &Path, text: &str, format: FileFormat) -> Result<u64, String> {
    let bytes = encode(text, format);
    write_atomic(path, &bytes).map_err(|e| {
        crate::io::describe(&e, &tr!("無法寫入「{name}」", name = display_name(path)))
    })?;
    Ok(hash_bytes(&bytes))
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
    window: WebviewWindow,
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

/// 重新開啟先前開過的檔案（還原分頁、最近開啟）。只允許信任清單裡的路徑。
#[tauri::command]
pub async fn reopen_file(
    app: AppHandle,
    path: String,
    known: State<'_, KnownFiles>,
    trust: State<'_, Trust>,
) -> Result<OpenedFile, String> {
    let path = PathBuf::from(path);
    let known_file = known.contains(&path);
    let app2 = app.clone();
    let p = path.clone();
    let opened = crate::io::blocking(move || {
        // 信任清單與工作區的判斷需要讀取磁碟（解析符號連結後的實際路徑），也放在背景執行。
        let allowed = known_file
            || app2.state::<Trust>().allows(&p)
            || app2.state::<crate::workspace::Workspace>().contains(&p);
        if !allowed {
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

/// 在背景執行緒讀取檔案（網路磁碟斷線時不會卡住介面）。
pub async fn read_in_background(app: &AppHandle, path: PathBuf) -> Result<OpenedFile, String> {
    let app = app.clone();
    crate::io::blocking(move || read_file(&app, path, &app.state::<KnownFiles>())).await
}

/// 匯出二進位檔（例如 Word .docx）：讓使用者選位置後寫入。取消時回傳 None。
#[tauri::command]
pub async fn export_binary(
    window: WebviewWindow,
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
    window: WebviewWindow,
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
    let bytes = crate::io::blocking(move || {
        let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        if size > MAX_DOCX_BYTES {
            return Err(tr!(
                "「{name}」超過 100 MB，無法匯入",
                name = display_name(&p)
            ));
        }
        fs::read(&p).map_err(|e| {
            crate::io::describe(&e, &tr!("無法讀取「{name}」", name = display_name(&p)))
        })
    })
    .await?;
    let md = unique_md_path(&path);
    known
        .0
        .lock()
        .unwrap()
        .insert(md.clone(), FileState::default());
    trust.add_file(&app, &md);
    Ok(Some(DocxImport {
        name: display_name(&path),
        md_path: path_string(&md),
    }))
    .inspect(|_| *DOCX_DATA.lock().unwrap() = Some(bytes))
}

/// 取走 `import_docx` 剛讀到的 Word 檔內容（原始位元組）。
#[tauri::command]
pub fn import_docx_data() -> Result<tauri::ipc::Response, String> {
    let bytes = DOCX_DATA
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| tr!("沒有要匯入的 Word 檔"))?;
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
    window: WebviewWindow,
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
        .unwrap()
        .get(&path)
        .map(|s| s.format)
        .unwrap_or_default();
    let app2 = app.clone();
    let p = path.clone();
    crate::io::blocking(move || {
        let disk = fs::read(&p).ok();
        let hash = write_file(&p, &text, format)?;
        crate::history::on_save(&app2, &p, disk.as_deref(), &text);
        app2.state::<KnownFiles>().0.lock().unwrap().insert(
            p.clone(),
            FileState {
                format,
                hash: Some(hash),
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
    let mut locks = LOCKS.lock().unwrap();
    // 沒有人在用的鎖順便清掉。
    locks.retain(|_, l| std::sync::Arc::strong_count(l) > 1);
    locks.entry(path.to_path_buf()).or_default().clone()
}

/// 覆寫已開啟過的檔案。磁碟上的內容在開啟後被改過時回傳 `Conflict`（除非 `force`）。
fn overwrite(app: &AppHandle, path: &Path, text: &str, force: bool) -> Result<SaveOutcome, String> {
    let lock = save_lock(path);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let known = app.state::<KnownFiles>();
    let state = known
        .0
        .lock()
        .unwrap()
        .get(path)
        .copied()
        .unwrap_or_default();
    let disk = fs::read(path).ok();
    if !force && changed_on_disk(state.hash, disk.as_deref()) {
        let (disk_text, _, _) = decode(disk.as_deref().unwrap_or_default());
        return Ok(SaveOutcome::Conflict {
            name: display_name(path),
            path: path_string(path),
            disk_text,
        });
    }
    let hash = write_file(path, text, state.format)?;
    crate::history::on_save(app, path, disk.as_deref(), text);
    known.0.lock().unwrap().insert(
        path.to_path_buf(),
        FileState {
            hash: Some(hash),
            ..state
        },
    );
    Ok(saved(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_crlf_and_bom_round_trip() {
        let original = b"\xEF\xBB\xBF# \xE6\xA8\x99\xE9\xA1\x8C\r\n\r\nabc\r\n";
        let (text, format, enc) = decode(original);
        assert_eq!(text, "# 標題\n\nabc\n");
        assert_eq!(enc, "utf-8");
        assert_eq!(encode(&text, format), original);
    }

    #[test]
    fn lf_files_stay_lf() {
        let (text, format, _) = decode(b"a\nb\n");
        assert_eq!(encode(&text, format), b"a\nb\n");
    }

    #[test]
    fn rejects_binary_and_utf16() {
        assert!(not_text_reason(b"# \xE6\xA8\x99\xE9\xA1\x8C\nabc").is_none());
        assert!(not_text_reason(b"\xA4\xA4\xA4\xE5").is_none());
        assert!(not_text_reason(b"").is_none());
        assert!(not_text_reason(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR").is_some());
        assert!(not_text_reason(b"%PDF-1.7\n").is_some());
        assert!(not_text_reason(b"\xFF\xFEa\0b\0").is_some_and(|why| why.contains("UTF-16")));
    }

    #[test]
    fn falls_back_to_big5() {
        // 「中文」的 Big5 編碼
        let (text, _, enc) = decode(b"\xA4\xA4\xA4\xE5");
        assert_eq!(text, "中文");
        assert_eq!(enc, "big5");
        // Big5 也解不乾淨：標成 unknown，前端不會自動存檔蓋掉原檔。
        let (_, _, enc) = decode(b"abc\xA4");
        assert_eq!(enc, "unknown");
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

    #[test]
    fn rename_moves_known_state_including_children() {
        let known = KnownFiles::default();
        known.0.lock().unwrap().insert(
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
