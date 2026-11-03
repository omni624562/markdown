//! 專案 Wiki：頁面清單、讀取、存檔、新增、刪除與歷史。

use super::*;
use std::collections::BTreeMap;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Wiki {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) project: String,
    pub(super) project_id: String,
    /// 從程式碼儲存庫發佈的 Wiki（不是專案 Wiki）。
    pub(super) code: bool,
    pub(super) repository_id: String,
    /// 程式碼 Wiki 在儲存庫裡的資料夾（專案 Wiki 是 `/`）。
    pub(super) mapped_path: String,
    /// 分支（程式碼 Wiki 讀頁面時要指定）。
    pub(super) version: Option<String>,
    pub(super) web_url: Option<String>,
}

pub(super) fn wikis_from(wikis: &Value, projects: &Value) -> Vec<Wiki> {
    let mut out: Vec<Wiki> = values(wikis)
        .iter()
        .filter_map(|w| {
            let project_id = str_of(w, "projectId")?;
            let project = values(projects)
                .iter()
                .find(|p| str_of(p, "id") == Some(project_id))
                .and_then(|p| str_of(p, "name"))
                .unwrap_or(project_id);
            Some(Wiki {
                id: str_of(w, "id")?.to_string(),
                name: str_of(w, "name")?.to_string(),
                project: project.to_string(),
                project_id: project_id.to_string(),
                code: str_of(w, "type") == Some("codeWiki"),
                repository_id: str_of(w, "repositoryId")?.to_string(),
                mapped_path: str_of(w, "mappedPath").unwrap_or("/").to_string(),
                version: w
                    .pointer("/versions/0/version")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                web_url: str_of(w, "remoteUrl").map(str::to_string),
            })
        })
        .collect();
    out.sort_by_key(|w| (w.project.to_lowercase(), w.code, w.name.to_lowercase()));
    out
}

/// 集合裡所有的 Wiki（專案 Wiki 與程式碼 Wiki）。
#[tauri::command]
pub async fn ado_wikis(app: AppHandle) -> Result<Vec<Wiki>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let wikis = get(&a.url, &pat, "/_apis/wiki/wikis", &tr!("讀取 Wiki"))?;
        let projects =
            get(&a.url, &pat, "/_apis/projects?$top=1000", &tr!("讀取專案")).unwrap_or(Value::Null);
        Ok(wikis_from(&wikis, &projects))
    })
    .await
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WikiPage {
    /// 頁面路徑，例如 `/產品/安裝說明`。
    pub(super) path: String,
    /// 頁面編號（瀏覽器網址列上的數字）；舊版伺服器沒有。
    pub(super) id: Option<u64>,
    pub(super) children: Vec<WikiPage>,
}

/// 頁面樹：同一層依伺服器上的順序（`order`，和網頁版的目錄一樣）排；沒有順序的排在後面。
pub(super) fn page_tree(v: &Value) -> Vec<WikiPage> {
    let mut out: Vec<(u64, WikiPage)> = v
        .get("subPages")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|p| {
            Some((
                p.get("order").and_then(Value::as_u64).unwrap_or(u64::MAX),
                WikiPage {
                    path: str_of(p, "path")?.to_string(),
                    id: p.get("id").and_then(Value::as_u64),
                    children: page_tree(p),
                },
            ))
        })
        .collect();
    // 穩定排序：順序一樣（或都沒有）時保留伺服器給的先後。
    out.sort_by_key(|(order, _)| *order);
    out.into_iter().map(|(_, page)| page).collect()
}

/// Wiki 頁面 API 的路徑（`path` 是頁面路徑；程式碼 Wiki 要指定分支）。
pub(super) fn wiki_pages_path(
    project_id: &str,
    wiki_id: &str,
    path: &str,
    version: Option<&str>,
) -> String {
    let mut out = format!(
        "/{}/_apis/wiki/wikis/{}/pages?path={}",
        encode_segment(project_id),
        encode_segment(wiki_id),
        encode_segment(path)
    );
    if let Some(v) = version.filter(|v| !v.is_empty()) {
        out.push_str(&format!("&versionDescriptor.version={}", encode_segment(v)));
    }
    out
}

/// Wiki 的頁面樹（最上層頁面的清單）。
#[tauri::command]
pub async fn ado_wiki_pages(
    app: AppHandle,
    project_id: String,
    wiki_id: String,
    version: Option<String>,
) -> Result<Vec<WikiPage>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let path = wiki_pages_path(&project_id, &wiki_id, "/", version.as_deref())
            + "&recursionLevel=full";
        Ok(page_tree(&get(
            &a.url,
            &pat,
            &path,
            &tr!("讀取 Wiki 頁面"),
        )?))
    })
    .await
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WikiContent {
    pub(super) content: String,
    pub(super) web_url: Option<String>,
    /// 頁面的版本（存回去時帶上，確認這段時間沒有被別人改過）。
    pub(super) etag: Option<String>,
}

/// 讀取 Wiki 頁面的內容、網址與版本。
pub(super) fn read_wiki_page(
    base: &str,
    pat: &str,
    project_id: &str,
    wiki_id: &str,
    path: &str,
    version: Option<&str>,
) -> Result<WikiContent, String> {
    let api = wiki_pages_path(project_id, wiki_id, path, version) + "&includeContent=true";
    let (v, etag) = read_with_etag(
        crate::update::agent()
            .get(&format!("{base}{api}&api-version={API_VERSION}"))
            .header("Authorization", &basic(pat))
            .header("Accept", "application/json")
            .call(),
        &tr!("讀取 Wiki 頁面"),
    )?;
    Ok(WikiContent {
        content: str_of(&v, "content").unwrap_or_default().to_string(),
        web_url: str_of(&v, "remoteUrl").map(str::to_string),
        etag,
    })
}

#[derive(Serialize, Debug)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WikiSaveOutcome {
    /// 已存回伺服器；`etag` 是新的版本。
    Saved { etag: Option<String> },
    /// 開始編輯之後頁面被別人改過：回傳伺服器上的內容與版本，交給使用者決定。
    Conflict {
        content: String,
        etag: Option<String>,
    },
}

/// 把編輯好的內容存回 Wiki 頁面（只限專案 Wiki）。`etag` 是開始編輯時的版本：
/// 伺服器上的版本不同（被別人改過）時不覆蓋，回傳衝突。
#[tauri::command]
pub async fn ado_wiki_save(
    app: AppHandle,
    project_id: String,
    wiki_id: String,
    path: String,
    content: String,
    etag: String,
) -> Result<WikiSaveOutcome, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let api = wiki_pages_path(&project_id, &wiki_id, &path, None);
        let res = crate::update::agent()
            .put(&format!("{}{api}&api-version={API_VERSION}", a.url))
            .header("Authorization", &basic(&pat))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .header("If-Match", &etag)
            .send(&serde_json::json!({ "content": content }).to_string());
        match res {
            Err(ureq::Error::StatusCode(409 | 412)) => {
                let page = read_wiki_page(&a.url, &pat, &project_id, &wiki_id, &path, None)?;
                Ok(WikiSaveOutcome::Conflict {
                    content: page.content,
                    etag: page.etag,
                })
            }
            res => {
                let (_, etag) = read_with_etag(res, &tr!("儲存 Wiki 頁面"))?;
                // 回應沒有帶版本時再讀一次，下次存檔才比得出有沒有被別人改過。
                let etag = match etag {
                    Some(etag) => Some(etag),
                    None => read_wiki_page(&a.url, &pat, &project_id, &wiki_id, &path, None)?.etag,
                };
                Ok(WikiSaveOutcome::Saved { etag })
            }
        }
    })
    .await
}

/// 建立新的 Wiki 頁面（只限專案 Wiki）：`path` 是完整路徑（例如 `/產品/新頁面`），上層頁面要已經存在。
/// 已經有同名的頁面時不覆蓋。回傳新頁面的版本（之後存回時用）。
#[tauri::command]
pub async fn ado_wiki_create(
    app: AppHandle,
    project_id: String,
    wiki_id: String,
    path: String,
    content: String,
) -> Result<Option<String>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let api = wiki_pages_path(&project_id, &wiki_id, &path, None);
        let res = crate::update::agent()
            .put(&format!("{}{api}&api-version={API_VERSION}", a.url))
            .header("Authorization", &basic(&pat))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .send(&serde_json::json!({ "content": content }).to_string());
        match res {
            // 沒帶 If-Match 時，已經有這一頁會被拒絕（不會覆蓋）。
            Err(ureq::Error::StatusCode(409 | 412)) => Err(tr!("已經有同名的頁面了，請換一個名稱")),
            res => {
                let (_, etag) = read_with_etag(res, &tr!("建立 Wiki 頁面"))?;
                Ok(match etag {
                    Some(etag) => Some(etag),
                    None => read_wiki_page(&a.url, &pat, &project_id, &wiki_id, &path, None)?.etag,
                })
            }
        }
    })
    .await
}

/// 刪除 Wiki 頁面（只限專案 Wiki）；底下的子頁面會一起刪除（和網頁版一樣）。
#[tauri::command]
pub async fn ado_wiki_delete(
    app: AppHandle,
    project_id: String,
    wiki_id: String,
    path: String,
) -> Result<(), String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let api = wiki_pages_path(&project_id, &wiki_id, &path, None);
        let res = crate::update::agent()
            .delete(&format!("{}{api}&api-version={API_VERSION}", a.url))
            .header("Authorization", &basic(&pat))
            .header("Accept", "application/json")
            .call();
        match res {
            // 回應的內容是被刪掉的頁面，不需要讀。
            Ok(_) => Ok(()),
            res => read(res, &tr!("刪除 Wiki 頁面")).map(|_| ()),
        }
    })
    .await
}

/// 搬移頁面的 API 路徑。
pub(super) fn wiki_moves_path(project_id: &str, wiki_id: &str) -> String {
    format!(
        "/{}/_apis/wiki/wikis/{}/pagemoves",
        encode_segment(project_id),
        encode_segment(wiki_id)
    )
}

/// 搬移頁面的內容：`new_path` 和 `path` 一樣時只調整順序；`new_order` 是在上層底下排第幾個（從 0 算起），
/// 沒給時由伺服器決定。
pub(super) fn page_move_body(path: &str, new_path: &str, new_order: Option<u32>) -> Value {
    let mut body = serde_json::json!({ "path": path, "newPath": new_path });
    if let Some(order) = new_order {
        body["newOrder"] = order.into();
    }
    body
}

/// 搬移 Wiki 頁面或調整順序（只限專案 Wiki；子頁面跟著搬）。和網頁版拖曳目錄一樣。
#[tauri::command]
pub async fn ado_wiki_move(
    app: AppHandle,
    project_id: String,
    wiki_id: String,
    path: String,
    new_path: String,
    new_order: Option<u32>,
) -> Result<(), String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let what = if path == new_path {
            tr!("調整 Wiki 頁面順序")
        } else {
            tr!("搬移 Wiki 頁面")
        };
        post(
            &a.url,
            &pat,
            &wiki_moves_path(&project_id, &wiki_id),
            &page_move_body(&path, &new_path, new_order),
            &what,
        )
        .map(|_| ())
    })
    .await
}

/// 一個 Wiki 頁面的內容（Markdown）。
#[tauri::command]
pub async fn ado_wiki_page(
    app: AppHandle,
    project_id: String,
    wiki_id: String,
    path: String,
    version: Option<String>,
) -> Result<WikiContent, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        read_wiki_page(
            &a.url,
            &pat,
            &project_id,
            &wiki_id,
            &path,
            version.as_deref(),
        )
    })
    .await
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WikiPageInfo {
    /// 伺服器上目前的版本（和開始編輯時的不同，就是被別人改過了）。
    pub(super) etag: Option<String>,
    /// 最後修改的人與時間（Wiki 儲存庫裡這一頁的最新提交；查不到時是空的）。
    pub(super) author: Option<String>,
    pub(super) date: Option<String>,
}

/// 提交清單（`git/commits`）裡第一筆的作者與時間。
pub(super) fn latest_author(v: &Value) -> (Option<String>, Option<String>) {
    let author = v
        .get("value")
        .and_then(Value::as_array)
        .and_then(|list| list.first())
        .and_then(|c| c.get("author"));
    let field = |key: &str| {
        author
            .and_then(|a| str_of(a, key))
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    (field("name"), field("date"))
}

/// Wiki 頁面目前的版本與最後修改的人（編輯中定期檢查有沒有人改過，開始編輯前提醒）。
/// 不讀內容，只看版本；最後修改的人另外查 Wiki 儲存庫的提交，查不到不算錯。
#[tauri::command]
pub async fn ado_wiki_page_info(
    app: AppHandle,
    project_id: String,
    wiki_id: String,
    repository_id: Option<String>,
    path: String,
) -> Result<WikiPageInfo, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let api = wiki_pages_path(&project_id, &wiki_id, &path, None);
        let (page, etag) = read_with_etag(
            crate::update::agent()
                .get(&format!("{}{api}&api-version={API_VERSION}", a.url))
                .header("Authorization", &basic(&pat))
                .header("Accept", "application/json")
                .call(),
            &tr!("讀取 Wiki 頁面"),
        )?;
        let (author, date) = match str_of(&page, "gitItemPath") {
            Some(item) => {
                let repo = repository_id.as_deref().filter(|r| !r.is_empty()).unwrap_or(&wiki_id);
                let url = format!(
                    "{}/{}/_apis/git/repositories/{}/commits?searchCriteria.itemPath={}&searchCriteria.$top=1&api-version={API_VERSION}",
                    a.url,
                    encode_segment(&project_id),
                    encode_segment(repo),
                    encode_segment(item)
                );
                read(
                    crate::update::agent()
                        .get(&url)
                        .header("Authorization", &basic(&pat))
                        .header("Accept", "application/json")
                        .call(),
                    &tr!("讀取 Wiki 頁面"),
                )
                .map(|v| latest_author(&v))
                .unwrap_or_default()
            }
            None => (None, None),
        };
        Ok(WikiPageInfo { etag, author, date })
    })
    .await
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WikiRevision {
    pub(super) id: String,
    pub(super) author: String,
    pub(super) date: String,
    pub(super) comment: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WikiHistory {
    /// 頁面在 Wiki 儲存庫裡的檔案路徑（讀某一版的內容時用）。
    pub(super) git_path: String,
    /// 新的在前。
    pub(super) revisions: Vec<WikiRevision>,
}

/// 提交清單（`git/commits`）轉成修改記錄。
pub(super) fn revisions_of(v: &Value) -> Vec<WikiRevision> {
    v.get("value")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let author = c.get("author");
            Some(WikiRevision {
                id: str_of(c, "commitId")?.to_string(),
                author: author
                    .and_then(|a| str_of(a, "name"))
                    .unwrap_or_default()
                    .to_string(),
                date: author
                    .and_then(|a| str_of(a, "date"))
                    .unwrap_or_default()
                    .to_string(),
                comment: str_of(c, "comment").unwrap_or_default().trim().to_string(),
            })
        })
        .collect()
}

/// Wiki 頁面的修改記錄（最近 100 次）：誰、什麼時候、說明。
#[tauri::command]
pub async fn ado_wiki_history(
    app: AppHandle,
    project_id: String,
    wiki_id: String,
    repository_id: Option<String>,
    path: String,
) -> Result<WikiHistory, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let what = tr!("讀取 Wiki 頁面的修改記錄");
        let api = wiki_pages_path(&project_id, &wiki_id, &path, None);
        let page = read(
            crate::update::agent()
                .get(&format!("{}{api}&api-version={API_VERSION}", a.url))
                .header("Authorization", &basic(&pat))
                .header("Accept", "application/json")
                .call(),
            &what,
        )?;
        let git_path = str_of(&page, "gitItemPath")
            .ok_or_else(|| tr!("{what}失敗：伺服器沒有提供頁面的檔案位置", what = what))?
            .to_string();
        let repo = repository_id
            .as_deref()
            .filter(|r| !r.is_empty())
            .unwrap_or(&wiki_id);
        let url = format!(
            "{}/{}/_apis/git/repositories/{}/commits?searchCriteria.itemPath={}&searchCriteria.$top=100&api-version={API_VERSION}",
            a.url,
            encode_segment(&project_id),
            encode_segment(repo),
            encode_segment(&git_path)
        );
        let v = read(
            crate::update::agent()
                .get(&url)
                .header("Authorization", &basic(&pat))
                .header("Accept", "application/json")
                .call(),
            &what,
        )?;
        Ok(WikiHistory {
            git_path,
            revisions: revisions_of(&v),
        })
    })
    .await
}

/// Wiki 最近修改的一筆：哪一頁、怎麼改（`add`、`edit`、`delete`、`rename`）、誰、什麼時候、說明。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WikiChange {
    /// Wiki 頁面的路徑（例如 `/產品/安裝說明`）。
    pub(super) path: String,
    pub(super) change: String,
    pub(super) author: String,
    pub(super) date: String,
    pub(super) comment: String,
    pub(super) commit_id: String,
}

/// 最近修改看最近幾次提交。
const RECENT_COMMITS: usize = 30;

/// Wiki 儲存庫裡的檔案路徑 → 頁面路徑：去掉 Wiki 所在的資料夾與 `.md`，
/// 檔名裡的 `-` 是空白、`%2D` 是 `-`（和 Azure DevOps 的檔名規則一樣）。附件、`.order` 等不是頁面的回傳 None。
pub(super) fn page_of_git_path(git_path: &str, mapped_path: &str) -> Option<String> {
    let root = mapped_path.trim_end_matches('/');
    let rest = if root.is_empty() {
        git_path
    } else {
        let head = git_path.get(..root.len())?;
        if !head.eq_ignore_ascii_case(root) {
            return None;
        }
        &git_path[root.len()..]
    };
    let rest = rest.strip_prefix('/')?;
    let len = rest.len();
    if len < 4 || !rest[len - 3..].eq_ignore_ascii_case(".md") {
        return None;
    }
    let rest = &rest[..len - 3];
    let mut out = String::new();
    for seg in rest.split('/') {
        if seg.is_empty() || seg.starts_with('.') {
            return None;
        }
        out.push('/');
        out.push_str(&crate::dav::decode_percent(&seg.replace('-', " ")));
    }
    Some(out)
}

/// 一次提交改到的頁面（`commits/{id}/changes`）：(頁面路徑, 怎麼改)，同一頁只留一筆。
pub(super) fn changed_pages(v: &Value, mapped_path: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = vec![];
    for c in v
        .get("changes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let item = c.get("item");
        if item
            .and_then(|i| str_of(i, "gitObjectType"))
            .is_some_and(|t| t != "blob")
        {
            continue;
        }
        let Some(page) = item
            .and_then(|i| str_of(i, "path"))
            .and_then(|p| page_of_git_path(p, mapped_path))
        else {
            continue;
        };
        let kind = str_of(c, "changeType")
            .unwrap_or("edit")
            .to_ascii_lowercase();
        let change = if kind.contains("delete") {
            "delete"
        } else if kind.contains("rename") {
            "rename"
        } else if kind.contains("add") {
            "add"
        } else {
            "edit"
        };
        if !out.iter().any(|(p, _)| p == &page) {
            out.push((page, change.to_string()));
        }
    }
    out
}

/// Wiki 最近修改：最近 30 次提交改到的頁面（新的在前）。每次提交改了哪些檔案要另外讀，同時讀幾個。
#[tauri::command]
pub async fn ado_wiki_recent(
    app: AppHandle,
    project_id: String,
    wiki_id: String,
    repository_id: Option<String>,
    mapped_path: Option<String>,
    version: Option<String>,
) -> Result<Vec<WikiChange>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let what = tr!("讀取 Wiki 的最近修改");
        let repo = repository_id
            .as_deref()
            .filter(|r| !r.is_empty())
            .unwrap_or(&wiki_id)
            .to_string();
        let mapped = mapped_path.unwrap_or_else(|| "/".into());
        let base = format!(
            "{}/{}/_apis/git/repositories/{}",
            a.url,
            encode_segment(&project_id),
            encode_segment(&repo)
        );
        let mut url = format!("{base}/commits?searchCriteria.$top={RECENT_COMMITS}");
        if !mapped.trim_end_matches('/').is_empty() {
            url.push_str(&format!(
                "&searchCriteria.itemPath={}",
                encode_segment(&mapped)
            ));
        }
        if let Some(v) = version.as_deref().filter(|v| !v.is_empty()) {
            url.push_str(&format!(
                "&searchCriteria.itemVersion.version={}",
                encode_segment(v)
            ));
        }
        let call = |url: &str| {
            read(
                crate::update::agent()
                    .get(&format!("{url}&api-version={API_VERSION}"))
                    .header("Authorization", &basic(&pat))
                    .header("Accept", "application/json")
                    .call(),
                &what,
            )
        };
        let commits = revisions_of(&call(&url)?);
        // 每次提交改到哪些頁面：一次讀 6 個，讀不到的那次略過（不讓整個清單失敗）。
        let mut pages: Vec<Vec<(String, String)>> = vec![vec![]; commits.len()];
        for (chunk_index, chunk) in commits.chunks(6).enumerate() {
            std::thread::scope(|s| {
                let handles: Vec<_> = chunk
                    .iter()
                    .map(|c| {
                        let url =
                            format!("{base}/commits/{}/changes?top=100", encode_segment(&c.id));
                        let call = &call;
                        let mapped = &mapped;
                        s.spawn(move || {
                            call(&url)
                                .map(|v| changed_pages(&v, mapped))
                                .unwrap_or_default()
                        })
                    })
                    .collect();
                for (i, h) in handles.into_iter().enumerate() {
                    pages[chunk_index * 6 + i] = h.join().unwrap_or_default();
                }
            });
        }
        Ok(commits
            .into_iter()
            .zip(pages)
            .flat_map(|(c, list)| {
                list.into_iter().map(move |(path, change)| WikiChange {
                    path,
                    change,
                    author: c.author.clone(),
                    date: c.date.clone(),
                    comment: c.comment.clone(),
                    commit_id: c.id.clone(),
                })
            })
            .collect())
    })
    .await
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WikiSource {
    /// 頁面路徑（例如 `/產品/安裝說明`）。
    pub(super) path: String,
    /// 頁面的 Markdown。
    pub(super) text: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WikiSources {
    pub(super) pages: Vec<WikiSource>,
    /// 讀不到的頁面數（清單可能不完整）。
    pub(super) skipped: usize,
}

/// 一次最多讀幾頁的內文。
const SOURCE_LIMIT: usize = 3000;
/// 讀過的頁面內文最多記幾頁（超過就全部忘掉重來）。
const SOURCE_CACHE_LIMIT: usize = 6000;
/// 讀整個 Wiki 的內文可能比較久。
const SOURCES_TIMEOUT: Duration = Duration::from_secs(180);

/// 讀過的頁面內文，依內容的編號（Git 的 objectId：內容一樣編號就一樣，不會過期）。
static SOURCE_CACHE: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());

/// 儲存庫檔案清單（`items?recursionLevel=Full`）裡的 Wiki 頁面：(頁面路徑, 檔案在儲存庫裡的路徑, 內容的編號)。
pub(super) fn wiki_page_files(v: &Value, mapped_path: &str) -> Vec<(String, String, String)> {
    values(v)
        .iter()
        .filter(|i| {
            i.get("isFolder").and_then(Value::as_bool) != Some(true)
                && str_of(i, "gitObjectType").is_none_or(|t| t == "blob")
        })
        .filter_map(|i| {
            let git = str_of(i, "path")?;
            let id = str_of(i, "objectId")?;
            Some((
                page_of_git_path(git, mapped_path)?,
                git.to_string(),
                id.to_string(),
            ))
        })
        .collect()
}

/// Wiki 每一頁的內文（找哪些頁面連到某一頁用）：先讀儲存庫的檔案清單，再讀每一頁（一次 6 頁）。
/// 讀過、內容沒變的頁面不再讀；讀不到的頁面略過，數量放在 `skipped`。
#[tauri::command]
pub async fn ado_wiki_sources(
    app: AppHandle,
    project_id: String,
    wiki_id: String,
    repository_id: Option<String>,
    mapped_path: Option<String>,
    version: Option<String>,
) -> Result<WikiSources, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(SOURCES_TIMEOUT, move || {
        let what = tr!("讀取 Wiki 頁面的內容");
        let repo = repository_id
            .as_deref()
            .filter(|r| !r.is_empty())
            .unwrap_or(&wiki_id)
            .to_string();
        let mapped = mapped_path.unwrap_or_else(|| "/".into());
        let base = format!(
            "{}/{}/_apis/git/repositories/{}",
            a.url,
            encode_segment(&project_id),
            encode_segment(&repo)
        );
        let version = version
            .as_deref()
            .filter(|v| !v.is_empty())
            .map(|v| {
                format!(
                    "&versionDescriptor.version={}&versionDescriptor.versionType=branch",
                    encode_segment(v)
                )
            })
            .unwrap_or_default();
        let list = format!(
            "{base}/items?scopePath={}&recursionLevel=Full{version}&api-version={API_VERSION}",
            encode_segment(&mapped)
        );
        let items = read(
            crate::update::agent()
                .get(&list)
                .header("Authorization", &basic(&pat))
                .header("Accept", "application/json")
                .call(),
            &what,
        )?;
        let mut files = wiki_page_files(&items, &mapped);
        files.truncate(SOURCE_LIMIT);
        let mut texts: Vec<Option<String>> = {
            let cache = SOURCE_CACHE.lock();
            files
                .iter()
                .map(|(_, _, id)| cache.get(id).cloned())
                .collect()
        };
        let missing: Vec<usize> = (0..files.len()).filter(|&i| texts[i].is_none()).collect();
        for chunk in missing.chunks(6) {
            let got: Vec<Option<String>> = std::thread::scope(|s| {
                let handles: Vec<_> = chunk
                    .iter()
                    .map(|&i| {
                        let url = format!(
                            "{base}/items?path={}&download=true{version}&api-version={API_VERSION}",
                            encode_segment(&files[i].1)
                        );
                        let pat = &pat;
                        s.spawn(move || super::files::fetch_text(&url, pat).ok())
                    })
                    .collect();
                handles
                    .into_iter()
                    .map(|h| h.join().ok().flatten())
                    .collect()
            });
            let mut cache = SOURCE_CACHE.lock();
            if cache.len() > SOURCE_CACHE_LIMIT {
                cache.clear();
            }
            for (&i, text) in chunk.iter().zip(got) {
                if let Some(text) = &text {
                    cache.insert(files[i].2.clone(), text.clone());
                }
                texts[i] = text;
            }
        }
        let mut skipped = 0;
        let pages = files
            .into_iter()
            .zip(texts)
            .filter_map(|((path, _, _), text)| match text {
                Some(text) => Some(WikiSource { path, text }),
                None => {
                    skipped += 1;
                    None
                }
            })
            .collect();
        Ok(WikiSources { pages, skipped })
    })
    .await
}
