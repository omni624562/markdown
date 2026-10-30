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
        description: html("System.Description"),
        details: html("Microsoft.VSTS.Common.AcceptanceCriteria")
            .or_else(|| html("Microsoft.VSTS.TCM.ReproSteps")),
    })
}
