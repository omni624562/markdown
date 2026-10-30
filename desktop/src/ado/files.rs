//! 儲存庫裡的文字檔與工作項目的附件。

use super::*;

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

/// 下載後會自己執行（或安裝、捷徑）的檔案：不直接開啟，只能另存新檔。
const RUNNABLE: &[&str] = &[
    "exe",
    "com",
    "bat",
    "cmd",
    "ps1",
    "psm1",
    "psd1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "msi",
    "msp",
    "mst",
    "scr",
    "pif",
    "lnk",
    "url",
    "hta",
    "cpl",
    "jar",
    "reg",
    "dll",
    "sys",
    "inf",
    "scf",
    "appx",
    "appxbundle",
    "msix",
    "msixbundle",
    "application",
    "appref-ms",
    "gadget",
    "iso",
    "img",
    "vhd",
    "vhdx",
    "chm",
    "settingcontent-ms",
    "sh",
    "command",
    "app",
];

/// 附件檔名的副檔名是不是會自己執行的檔案（不分大小寫；結尾的點和空白不算）。
pub(super) fn is_runnable(name: &str) -> bool {
    let name = name.trim_end_matches(['.', ' ']);
    name.rsplit_once('.')
        .is_some_and(|(_, ext)| RUNNABLE.contains(&ext.to_ascii_lowercase().as_str()))
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

/// 直接開啟附件：下載到暫存資料夾（每次一個亂數命名的資料夾），再用 Windows 預設的程式開啟。
/// 會自己執行的檔案不直接開啟。
#[tauri::command]
pub async fn ado_attachment_open(app: AppHandle, url: String, name: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let (a, pat) = require(&app)?;
    if !attachment_url(&url, &a.url) {
        return Err(tr!("只能讀取 Azure DevOps 伺服器上的附件"));
    }
    let file = safe_file_name(&name);
    if is_runnable(&file) {
        return Err(tr!("「{name}」是會自己執行的檔案，為了安全不直接開啟；需要的話請用「另存新檔」，確認來源可信再開啟。", name = file));
    }
    let path = crate::io::blocking_for(Duration::from_secs(300), move || {
        let bytes = download_attachment(&url, &pat)?;
        let mut rand = [0u8; 8];
        getrandom::fill(&mut rand).map_err(|e| e.to_string())?;
        let dir = std::env::temp_dir()
            .join("omarker-attachments")
            .join(format!("{:016x}", u64::from_le_bytes(rand)));
        fs::create_dir_all(&dir)
            .map_err(|e| crate::io::describe(&e, &tr!("無法建立暫存資料夾")))?;
        let path = dir.join(&file);
        fs::write(&path, bytes).map_err(|e| crate::io::describe(&e, &tr!("無法寫入檔案")))?;
        Ok(path)
    })
    .await?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| tr!("無法開啟附件：{e}", e = e))
}

/// 附件另存新檔：跳出存檔對話框，存到使用者選的位置；按取消時回傳 null。
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
            .map_err(|e| crate::io::describe(&e, &tr!("無法寫入檔案")))
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
        area: text("System.AreaPath"),
        iteration: text("System.IterationPath"),
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
