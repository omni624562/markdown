//! 儲存庫裡的文字檔與工作項目的附件。

use super::*;
use std::path::Path;

/// 文字檔最多讀幾個位元組。
pub(super) const TEXT_LIMIT: u64 = 5 * 1024 * 1024;

/// 用權杖讀取伺服器上的文字檔（不跟隨轉址），回傳內容；不是文字（含 NUL）時回錯誤。
pub(super) fn fetch_text(url: &str, pat: &str) -> Result<String, String> {
    let what = tr!("讀取檔案");
    let mut res = crate::update::agent()
        .get(url)
        .config()
        .max_redirects(0)
        .build()
        .header("Authorization", &basic(pat))
        .call()
        .map_err(|e| match e {
            ureq::Error::StatusCode(404) => {
                tr!("{what}失敗：找不到（404），請確認網址", what = what)
            }
            ureq::Error::StatusCode(401 | 403) => tr!("{what}失敗：沒有權限", what = what),
            e => tr!("{what}失敗：{e}", what = what, e = e),
        })?;
    let mime = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    // 權杖不對時，雲端版會回傳登入網頁。
    if mime.starts_with("text/html") {
        return Err(tr!(
            "{what}失敗：伺服器的回應不是預期的格式，請確認網址與個人存取權杖",
            what = what
        ));
    }
    let bytes = res
        .body_mut()
        .with_config()
        .limit(TEXT_LIMIT)
        .read_to_vec()
        .map_err(|e| tr!("{what}失敗：{e}", what = what, e = e))?;
    text_of(bytes)
}

/// 檔案內容轉成文字：有 NUL 就不是文字檔；不是 UTF-8 的字元換成替代字元。
pub(super) fn text_of(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.contains(&0) {
        return Err(tr!("這個檔案不是文字檔，請用瀏覽器開啟"));
    }
    let text = String::from_utf8(bytes)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    Ok(text
        .strip_prefix('\u{feff}')
        .map(str::to_string)
        .unwrap_or(text))
}

/// Git 儲存庫裡的文字檔（例如文件連到 `/_git/repo?path=/docs/a.md`）。
/// `version_type` 是 branch、tag 或 commit。
#[tauri::command]
pub async fn ado_repo_text(
    app: AppHandle,
    project: String,
    repo: String,
    path: String,
    version: Option<String>,
    version_type: Option<String>,
) -> Result<String, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let mut url = format!(
            "{}/{}/_apis/git/repositories/{}/items?path={}&download=true&api-version={API_VERSION}",
            a.url,
            encode_segment(&project),
            encode_segment(&repo),
            encode_segment(&path)
        );
        if let Some(v) = version.filter(|v| !v.is_empty()) {
            url.push_str(&format!(
                "&versionDescriptor.version={}",
                encode_segment(&v)
            ));
            if let Some(kind) =
                version_type.filter(|k| ["branch", "tag", "commit"].contains(&k.as_str()))
            {
                url.push_str(&format!("&versionDescriptor.versionType={kind}"));
            }
        }
        fetch_text(&url, &pat)
    })
    .await
}

/// 工作項目的附件（文字檔）；只讀取連線中那台伺服器上的附件網址。
#[tauri::command]
pub async fn ado_attachment_text(app: AppHandle, url: String) -> Result<String, String> {
    let (a, pat) = require(&app)?;
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://"))
        || !same_server(&url, &a.url)
        || !lower.contains("/_apis/wit/attachments/")
    {
        return Err(tr!("只能讀取 Azure DevOps 伺服器上的附件"));
    }
    crate::io::blocking_for(TIMEOUT, move || fetch_text(&url, &pat)).await
}

/// 附件最大多大（直接開啟、另存新檔都一樣）。
const ATTACHMENT_LIMIT: u64 = 200 * 1024 * 1024;

/// 下載後可以直接用預設的程式開啟的附件（副檔名，小寫）；其他的只能另存新檔。
/// 用允許清單而不是封鎖清單：Windows 上會自己執行、或交給其他程式解讀而能執行指令的副檔名太多
/// （.rdp、.msc、.library-ms、有巨集的 Office 檔…），列不完。
/// .doc、.xls、.ppt 可以有巨集，但檔案會標上「從網際網路下載」（見 [`mark_downloaded`]），
/// Office 會先用受保護的檢視開啟。前端 `web/src/attachments.ts` 的 `OPENABLE` 要一起改。
const OPENABLE: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "gif", "bmp", "webp", "txt", "md", "csv", "log", "json", "docx",
    "xlsx", "pptx", "doc", "xls", "ppt", "zip", "msg",
];

/// 附件檔名照 Windows 的方式看到的副檔名（小寫）：結尾的點和空白會被去掉（`a.exe.` 就是 `a.exe`），
/// 副檔名是最後一個點之後（`a.pdf.exe` 是 exe）。檔名含 `:`（NTFS 的替代資料流，`a.pdf:b.exe`）、
/// 路徑分隔符號或控制字元時，存成檔案後不一定是看到的樣子，回傳 None；沒有副檔名也回傳 None。
pub(super) fn attachment_ext(name: &str) -> Option<String> {
    if name
        .chars()
        .any(|c| c.is_control() || matches!(c, ':' | '/' | '\\'))
    {
        return None;
    }
    let (_, ext) = name.trim_end_matches(['.', ' ']).rsplit_once('.')?;
    Some(ext.to_ascii_lowercase())
}

/// 附件可以下載後直接用預設的程式開啟嗎（副檔名在允許清單裡）。
pub(super) fn opens_directly(name: &str) -> bool {
    attachment_ext(name).is_some_and(|ext| OPENABLE.contains(&ext.as_str()))
}

/// `Zone.Identifier` 資料流的內容：網際網路區域（ZoneId=3）。不寫伺服器的網址。
#[cfg(windows)]
const ZONE_IDENTIFIER: &str = "[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=about:internet\r\n";

/// 把下載的附件標上「從網際網路下載」（Mark of the Web）：寫入檔案的 `Zone.Identifier` 資料流，
/// Windows 的 SmartScreen、Office 的受保護的檢視才會把它當成外來的檔案。
/// 寫不進去（例如 FAT32 隨身碟、不支援資料流的網路磁碟）時略過，不影響開啟或存檔。其他平台不做事。
fn mark_downloaded(path: &Path) {
    #[cfg(windows)]
    {
        let mut stream = path.as_os_str().to_owned();
        stream.push(":Zone.Identifier");
        if let Err(e) = fs::write(&stream, ZONE_IDENTIFIER) {
            eprintln!("Zone.Identifier: {}: {e}", path.display());
        }
    }
    #[cfg(not(windows))]
    let _ = path;
}

/// 附件存到磁碟用的檔名：拿掉路徑與 Windows 不能用的字元，太長時截短；空的時候用「附件」。
pub(super) fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || r#"<>:"/\|?*"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut cleaned = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    // Windows 的保留名稱（CON、NUL、COM1…）加個底線。
    let stem = cleaned
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        cleaned.insert(0, '_');
    }
    if cleaned.chars().count() > 150 {
        let ext = cleaned
            .rsplit_once('.')
            .map(|(_, e)| e.to_string())
            .filter(|e| e.len() <= 10);
        let head: String = cleaned.chars().take(140).collect();
        cleaned = match ext {
            Some(e) => format!("{head}.{e}"),
            None => head,
        };
    }
    if cleaned.is_empty() {
        tr!("附件")
    } else {
        cleaned
    }
}

/// 是連線中那台伺服器上的工作項目附件網址嗎。
fn attachment_url(url: &str, base: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://"))
        && same_server(url, base)
        && lower.contains("/_apis/wit/attachments/")
}

/// 用權杖下載附件（不跟隨轉址，權杖不會被送到別的地方）。
fn download_attachment(url: &str, pat: &str) -> Result<Vec<u8>, String> {
    let what = tr!("下載附件");
    let mut res = crate::update::agent()
        .get(url)
        .config()
        .max_redirects(0)
        .build()
        .header("Authorization", &basic(pat))
        .call()
        .map_err(|e| match e {
            ureq::Error::StatusCode(404) => tr!(
                "{what}失敗：伺服器上找不到這個附件（可能已經刪除）",
                what = what
            ),
            ureq::Error::StatusCode(401 | 403) => tr!("{what}失敗：沒有權限", what = what),
            e => tr!("{what}失敗：{e}", what = what, e = e),
        })?;
    res.body_mut()
        .with_config()
        .limit(ATTACHMENT_LIMIT)
        .read_to_vec()
        .map_err(|e| tr!("{what}失敗：{e}", what = what, e = e))
}

/// 附件下載到暫存資料夾（每次一個亂數命名的資料夾）並標上「從網際網路下載」，回傳檔案位置。
/// 只接受允許清單裡的檔案類型（[`OPENABLE`]）。
async fn download_to_temp(
    app: &AppHandle,
    url: String,
    name: String,
) -> Result<std::path::PathBuf, String> {
    let (a, pat) = require(app)?;
    if !attachment_url(&url, &a.url) {
        return Err(tr!("只能讀取 Azure DevOps 伺服器上的附件"));
    }
    let file = safe_file_name(&name);
    // 原本的檔名與實際存檔的檔名都要是允許的類型。
    if !opens_directly(&name) || !opens_directly(&file) {
        return Err(tr!("「{name}」為了安全不直接開啟：直接開啟的只有 PDF、圖片、文字檔、ZIP、Word、Excel、PowerPoint 文件與 Outlook 郵件。需要的話請用「另存新檔」，確認來源可信再開啟。", name = file));
    }
    crate::io::blocking_for(Duration::from_secs(300), move || {
        write_temp(&file, download_attachment(&url, &pat)?)
    })
    .await
}

/// 下載的內容寫進暫存資料夾（每次一個亂數命名的資料夾）並標上「從網際網路下載」。
fn write_temp(file: &str, bytes: Vec<u8>) -> Result<std::path::PathBuf, String> {
    let mut rand = [0u8; 8];
    getrandom::fill(&mut rand).map_err(|e| e.to_string())?;
    let dir = attachments_dir().join(format!("{:016x}", u64::from_le_bytes(rand)));
    fs::create_dir_all(&dir).map_err(|e| crate::io::describe(&e, &tr!("無法建立暫存資料夾")))?;
    let path = dir.join(file);
    fs::write(&path, bytes).map_err(|e| crate::io::describe(&e, &tr!("無法寫入檔案")))?;
    mark_downloaded(&path);
    Ok(path)
}

/// 前端手上的檔案內容（郵件裡的附件、遠端資料夾下載的檔案；`data` 是 Base64）寫進暫存資料夾給分頁檢視：
/// 只接受 PDF 與 Office 文件、郵件，一樣標上「從網際網路下載」，回傳檔案位置。
#[tauri::command]
pub async fn view_temp_file(app: AppHandle, name: String, data: String) -> Result<String, String> {
    use base64::Engine;
    let file = safe_file_name(&name);
    let viewable = |n: &str| {
        let p = Path::new(n);
        opens_directly(n) && (crate::workspace::is_pdf(p) || crate::workspace::is_office(p))
    };
    if !viewable(&name) || !viewable(&file) {
        return Err(tr!(
            "只能在分頁裡檢視 PDF 與 Word、Excel、PowerPoint 文件、Outlook 郵件"
        ));
    }
    if data.len() as u64 > ATTACHMENT_LIMIT / 3 * 4 + 4 {
        return Err(tr!("「{name}」太大了，沒辦法在分頁裡檢視", name = file));
    }
    let saved = crate::io::blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.as_bytes())
            .map_err(|_| tr!("檔案內容無效"))?;
        write_temp(&file, bytes)
    })
    .await?;
    if let Some(dir) = saved.parent() {
        app.state::<crate::image_protocol::ImageRoots>().allow(dir);
    }
    Ok(saved.to_string_lossy().into_owned())
}

/// 在 oMarker 的分頁裡檢視儲存庫裡的檔案（例如 Wiki 的附件 `/.attachments/規格書.pdf`）：只接受 PDF 與
/// Office 文件、郵件，下載到暫存資料夾後回傳檔案位置。
#[tauri::command]
pub async fn ado_repo_file_view(
    app: AppHandle,
    project_id: String,
    repository_id: String,
    path: String,
    version: Option<String>,
) -> Result<String, String> {
    let (a, pat) = require(&app)?;
    let name = path.rsplit('/').next().unwrap_or_default().to_string();
    let file = safe_file_name(&name);
    let viewable = |n: &str| {
        let p = Path::new(n);
        opens_directly(n) && (crate::workspace::is_pdf(p) || crate::workspace::is_office(p))
    };
    if !viewable(&name) || !viewable(&file) {
        return Err(tr!(
            "只能在分頁裡檢視 PDF 與 Word、Excel、PowerPoint 文件、Outlook 郵件"
        ));
    }
    let saved = crate::io::blocking_for(Duration::from_secs(300), move || {
        let mut url = format!(
            "{}/{}/_apis/git/repositories/{}/items?path={}&download=true&api-version={API_VERSION}",
            a.url,
            encode_segment(&project_id),
            encode_segment(&repository_id),
            encode_segment(&path)
        );
        if let Some(v) = version.filter(|v| !v.is_empty()) {
            url.push_str(&format!(
                "&versionDescriptor.version={}",
                encode_segment(&v)
            ));
        }
        write_temp(&file, fetch_bytes(&url, &pat)?)
    })
    .await?;
    if let Some(dir) = saved.parent() {
        app.state::<crate::image_protocol::ImageRoots>().allow(dir);
    }
    Ok(saved.to_string_lossy().into_owned())
}

/// 附件下載到的暫存資料夾。
fn attachments_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("omarker-attachments")
}

/// 是剛下載到暫存資料夾的附件嗎（`omarker-attachments\<亂數>\檔名`，實際位置也要在裡面）。
pub fn is_downloaded_attachment(path: &Path) -> bool {
    let (Ok(real), Ok(base)) = (
        dunce::canonicalize(path),
        dunce::canonicalize(attachments_dir()),
    ) else {
        return false;
    };
    real.parent().and_then(Path::parent) == Some(base.as_path())
}

/// 在 oMarker 的分頁裡檢視附件（PDF、Office 文件）：下載到暫存資料夾，允許分頁讀取那個資料夾
/// （PDF 用 `mdimg:` 協定，Office 文件用 `read_office`），回傳檔案位置。
#[tauri::command]
pub async fn ado_attachment_view(
    app: AppHandle,
    url: String,
    name: String,
) -> Result<String, String> {
    let path = download_to_temp(&app, url, name).await?;
    if let Some(dir) = path.parent() {
        app.state::<crate::image_protocol::ImageRoots>().allow(dir);
    }
    Ok(path.to_string_lossy().into_owned())
}

/// 直接開啟附件：下載到暫存資料夾（每次一個亂數命名的資料夾），標上「從網際網路下載」，
/// 再用 Windows 預設的程式開啟。只開允許清單裡的檔案類型（[`OPENABLE`]），其他的只能另存新檔。
#[tauri::command]
pub async fn ado_attachment_open(app: AppHandle, url: String, name: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = download_to_temp(&app, url, name).await?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| tr!("無法開啟附件：{e}", e = e))
}

/// 附件另存新檔：跳出存檔對話框，存到使用者選的位置並標上「從網際網路下載」；按取消時回傳 null。
#[tauri::command]
pub async fn ado_attachment_save(
    app: AppHandle,
    window: Window,
    url: String,
    name: String,
) -> Result<Option<String>, String> {
    let (a, pat) = require(&app)?;
    if !attachment_url(&url, &a.url) {
        return Err(tr!("只能讀取 Azure DevOps 伺服器上的附件"));
    }
    let picked = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title(tr!("另存附件"))
        .set_file_name(safe_file_name(&name))
        .save_file()
        .await;
    let Some(handle) = picked else {
        return Ok(None);
    };
    let path = handle.path().to_path_buf();
    let p = path.clone();
    crate::io::blocking_for(Duration::from_secs(300), move || {
        let bytes = download_attachment(&url, &pat)?;
        crate::files::write_atomic(&p, &bytes)
            .map_err(|e| crate::io::describe(&e, &tr!("無法寫入檔案")))?;
        mark_downloaded(&p);
        Ok(())
    })
    .await?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

pub(super) fn data_url(mime: &str, bytes: Vec<u8>) -> String {
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

pub(super) fn detail_of(base: &str, v: &Value) -> Option<WorkItemDetail> {
    let html = |name: &str| {
        field(v, name)
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
    };
    let text = |name: &str| Some(field_str(v, name)).filter(|s| !s.trim().is_empty());
    Some(WorkItemDetail {
        item: item_of(base, v)?,
        created_by: person(field(v, "System.CreatedBy")),
        reason: text("System.Reason"),
        iteration: text("System.IterationPath"),
        start_date: text(super::workitems::START_DATE),
        finish_date: text(super::workitems::FINISH_DATE),
        target_date: text(super::workitems::TARGET_DATE),
        tags: field_str(v, "System.Tags")
            .split(';')
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .collect(),
        comments: vec![],
        rev: v.get("rev").and_then(Value::as_u64),
        relations: vec![],
        attachments: attachments_of(v),
        description: html("System.Description"),
        details: html("Microsoft.VSTS.Common.AcceptanceCriteria")
            .or_else(|| html("Microsoft.VSTS.TCM.ReproSteps")),
        system_info: html("Microsoft.VSTS.TCM.SystemInfo"),
    })
}
