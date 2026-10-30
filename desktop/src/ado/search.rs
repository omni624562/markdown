//! Wiki 全文搜尋。

use super::*;

/// 搜尋服務的網址：雲端版在另一個主機（almsearch），自架的伺服器就是集合本身。
pub(super) fn search_base(base: &str) -> String {
    if let Some(rest) = base.strip_prefix("https://dev.azure.com/") {
        return format!("https://almsearch.dev.azure.com/{rest}");
    }
    if let Some((scheme, rest)) = base.split_once("://") {
        let (host, path) = rest.split_once('/').map_or((rest, ""), |(h, p)| (h, p));
        if let Some(org) = host.strip_suffix(".visualstudio.com") {
            let path = if path.is_empty() {
                String::new()
            } else {
                format!("/{path}")
            };
            return format!("{scheme}://{org}.almsearch.visualstudio.com{path}");
        }
    }
    base.to_string()
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WikiHit {
    /// 頁面在 Wiki 儲存庫裡的檔案路徑（例如 `/產品/安裝-說明.md`）。
    pub(super) path: String,
    /// 符合的片段（`<highlighthit>` 標出符合的字）。
    pub(super) snippet: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WikiSearch {
    /// 伺服器有沒有搜尋功能（沒裝 Search 擴充功能時是 false）。
    pub(super) available: bool,
    pub(super) results: Vec<WikiHit>,
}

pub(super) fn wiki_hits(v: &Value) -> Vec<WikiHit> {
    v.get("results")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|r| {
            let path = str_of(r, "path")?.to_string();
            let snippet = r
                .get("hits")
                .and_then(Value::as_array)
                .and_then(|hits| {
                    hits.iter()
                        .find(|h| str_of(h, "fieldReferenceName") == Some("content"))
                        .or_else(|| hits.first())
                })
                .and_then(|h| h.get("highlights"))
                .and_then(Value::as_array)
                .and_then(|l| l.first())
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            Some(WikiHit { path, snippet })
        })
        .collect()
}

/// 在一個 Wiki 的內容裡搜尋（需要伺服器有 Search 擴充功能；沒有時 `available` 是 false）。
#[tauri::command]
pub async fn ado_wiki_search(
    app: AppHandle,
    project: String,
    wiki: String,
    text: String,
) -> Result<WikiSearch, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let url = format!(
            "{}/{}/_apis/search/wikisearchresults?api-version=5.0-preview.1",
            search_base(&a.url),
            encode_segment(&project)
        );
        let body = serde_json::json!({
            "searchText": text,
            "$skip": 0,
            "$top": 50,
            "filters": { "Project": [project], "Wiki": [wiki] },
            "includeFacets": false,
        });
        let mut res = crate::update::agent()
            .post(&url)
            .config()
            .http_status_as_error(false)
            .build()
            .header("Authorization", &basic(&pat))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .send(&body.to_string())
            .map_err(|e| {
                tr!(
                    "{what}失敗：連不到 Azure DevOps 伺服器，請確認網路或 VPN 連線（{e}）",
                    what = tr!("搜尋 Wiki"),
                    e = e
                )
            })?;
        let code = res.status().as_u16();
        let text = res.body_mut().read_to_string().unwrap_or_default();
        match code {
            // 沒有搜尋服務（沒裝擴充功能、舊版伺服器）。
            400 | 404 | 501 => Ok(WikiSearch {
                available: false,
                results: vec![],
            }),
            401 | 403 => Err(tr!("{what}失敗：沒有權限", what = tr!("搜尋 Wiki"))),
            c if c >= 400 => Err(tr!(
                "{what}失敗：伺服器回應 {code}",
                what = tr!("搜尋 Wiki"),
                code = c
            )),
            _ => {
                let v: Value = serde_json::from_str(&text).map_err(|_| {
                    tr!(
                        "{what}失敗：伺服器的回應不是預期的格式，請確認網址與個人存取權杖",
                        what = tr!("搜尋 Wiki")
                    )
                })?;
                Ok(WikiSearch {
                    available: true,
                    results: wiki_hits(&v),
                })
            }
        }
    })
    .await
}

/// 依副檔名判斷圖片類型（不支援 SVG：可能含有指令碼）。
pub(super) fn image_mime(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

/// Wiki 裡的圖片（放在 Wiki 的 Git 儲存庫裡）：回傳 data: 網址。
#[tauri::command]
pub async fn ado_wiki_image(
    app: AppHandle,
    project_id: String,
    repository_id: String,
    path: String,
    version: Option<String>,
) -> Result<String, String> {
    let (a, pat) = require(&app)?;
    let mime = image_mime(&path).ok_or_else(|| tr!("無法讀取圖片：不是圖片"))?;
    crate::io::blocking_for(TIMEOUT, move || {
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
        let bytes = fetch_bytes(&url, &pat)?;
        Ok(data_url(mime, bytes))
    })
    .await
}

/// 上傳到 Wiki 附件的檔名：只留英數字、`-`、`_`、`.`，其餘換成 `-`，加上時間避免和既有的附件同名。
pub(super) fn attachment_name(stem: &str, ext: &str, stamp: u128) -> String {
    let clean: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let clean = clean.trim_matches('-');
    let stem = if clean.is_empty() { "image" } else { clean };
    let stem: String = stem.chars().take(40).collect();
    format!("{stem}-{stamp}.{ext}")
}

/// 把圖片上傳成 Wiki 的附件（`.attachments` 資料夾），回傳在頁面裡引用的路徑（例如 `/.attachments/image-123.png`）。
/// `data` 是 base64；Wiki 的附件 API 本身就是收 base64 文字。
#[tauri::command]
pub async fn ado_wiki_attach(
    app: AppHandle,
    project_id: String,
    wiki_id: String,
    name: String,
    ext: String,
    data: String,
) -> Result<String, String> {
    let (a, pat) = require(&app)?;
    if image_mime(&format!("x.{ext}")).is_none() {
        return Err(tr!("無法上傳圖片：不是圖片"));
    }
    crate::io::blocking_for(TIMEOUT, move || {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        let file = attachment_name(&name, &ext, stamp);
        let what = tr!("上傳圖片到 Wiki");
        let put = |version: &str| {
            crate::update::agent()
                .put(&format!(
                    "{}/{}/_apis/wiki/wikis/{}/attachments?name={}&api-version={version}",
                    a.url,
                    encode_segment(&project_id),
                    encode_segment(&wiki_id),
                    encode_segment(&file)
                ))
                .header("Authorization", &basic(&pat))
                .header("Accept", "application/json")
                .header("Content-Type", "application/octet-stream")
                .send(data.as_str())
        };
        // 舊版伺服器（Azure DevOps Server 2019）的附件 API 還是預覽版。
        let res = match put(API_VERSION) {
            Err(ureq::Error::StatusCode(400)) => put("5.0-preview.1"),
            res => res,
        };
        let v = read(res, &what)?;
        Ok(str_of(&v, "path")
            .map(str::to_string)
            .unwrap_or_else(|| format!("/.attachments/{file}")))
    })
    .await
}

/// 用權杖讀取伺服器上的檔案（不跟隨轉址，權杖不會被送到別的地方），最多 10 MB。
pub(super) fn fetch_bytes(url: &str, pat: &str) -> Result<Vec<u8>, String> {
    let mut res = crate::update::agent()
        .get(url)
        .config()
        .max_redirects(0)
        .build()
        .header("Authorization", &basic(pat))
        .call()
        .map_err(|e| tr!("無法讀取圖片：{e}", e = e))?;
    let mime = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    // 權杖不對時，雲端版會回傳登入網頁。
    if mime.starts_with("text/html") {
        return Err(tr!("無法讀取圖片：不是圖片"));
    }
    res.body_mut()
        .with_config()
        .limit(10 * 1024 * 1024)
        .read_to_vec()
        .map_err(|e| tr!("無法讀取圖片：{e}", e = e))
}
