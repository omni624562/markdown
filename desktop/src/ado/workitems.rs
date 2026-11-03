//! 工作項目：查詢、篩選、詳細內容、改狀態、留言、新增，以及內容裡的圖片。

use super::*;

#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    pub(super) id: u64,
    pub(super) title: String,
    pub(super) state: String,
    pub(super) kind: String,
    pub(super) project: String,
    /// 指派給誰（清單上看所有人的工作項目時顯示）。
    pub(super) assigned_to: Option<String>,
    pub(super) changed: Option<String>,
    /// 優先順序（1 最高）；流程範本沒有這個欄位時是空的。
    pub(super) priority: Option<u64>,
    pub(super) web_url: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemDetail {
    #[serde(flatten)]
    pub(super) item: WorkItem,
    pub(super) created_by: Option<String>,
    /// 狀態的原因（例如 Fixed、Moved to the backlog）。
    pub(super) reason: Option<String>,
    /// 區域與反覆項目（例如「產品\前端」「產品\Sprint 3」）。
    pub(super) area: Option<String>,
    pub(super) iteration: Option<String>,
    pub(super) tags: Vec<String>,
    /// 說明（HTML，前端轉成 Markdown 顯示）。
    pub(super) description: Option<String>,
    /// 驗收條件或重現步驟（HTML）。
    pub(super) details: Option<String>,
    /// 系統資訊（Bug 的環境說明，HTML）。
    pub(super) system_info: Option<String>,
    /// 留言（舊到新）；伺服器不支援或讀不到時是空的。
    pub(super) comments: Vec<WorkItemComment>,
    /// 修訂版本（改狀態、指派時用來確認這段時間沒有被別人改過）。
    pub(super) rev: Option<u64>,
    /// 相關的工作項目（上層、子項目、相關、前置、後續…）；讀不到時是空的。
    pub(super) relations: Vec<WorkItemRelation>,
    /// 附件（上傳到工作項目的檔案）。
    pub(super) attachments: Vec<WorkItemAttachment>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemAttachment {
    pub(super) name: String,
    /// 伺服器上的附件網址（`…/_apis/wit/attachments/<id>`）。
    pub(super) url: String,
    /// 大小（位元組）；舊的附件可能沒有。
    pub(super) size: Option<u64>,
    /// 上傳時間。
    pub(super) created: Option<String>,
    /// 上傳時填的說明。
    pub(super) comment: Option<String>,
}

/// 關聯裡的附件（`AttachedFile`），依上傳時間排列（新的在前面）。
pub(super) fn attachments_of(v: &Value) -> Vec<WorkItemAttachment> {
    let mut list: Vec<WorkItemAttachment> = v
        .get("relations")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter(|r| str_of(r, "rel") == Some("AttachedFile"))
        .filter_map(|r| {
            let url = str_of(r, "url")?.to_string();
            let attr = r.get("attributes");
            let text = |key: &str| {
                attr.and_then(|a| str_of(a, key))
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            };
            let name = text("name")
                .unwrap_or_else(|| url.rsplit('/').next().unwrap_or_default().to_string());
            Some(WorkItemAttachment {
                name,
                size: attr
                    .and_then(|a| a.get("resourceSize"))
                    .and_then(Value::as_u64),
                created: text("resourceCreatedDate").or_else(|| text("authorizedDate")),
                comment: text("comment"),
                url,
            })
        })
        .collect();
    list.sort_by(|a, b| b.created.cmp(&a.created));
    list
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemRelation {
    /// `parent`、`child`、`related`、`predecessor`、`successor` 或 `other`。
    pub(super) link: &'static str,
    /// 伺服器上的連結名稱（例如 Parent、Tested By），`other` 時顯示。
    pub(super) link_name: String,
    #[serde(flatten)]
    pub(super) item: WorkItem,
}

/// 最多列出幾個相關的工作項目（一次查詢的上限是 200）。
pub(super) const MAX_RELATIONS: usize = 200;

/// 關聯裡連到其他工作項目的部分：(種類, 名稱, 編號)；附件、超連結、認可、PR 等略過。
pub(super) fn relation_links(v: &Value) -> Vec<(&'static str, String, u64)> {
    let mut seen = std::collections::HashSet::new();
    v.get("relations")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|r| {
            let rel = str_of(r, "rel")?;
            let id = relation_target(r)?;
            let link = match rel {
                "System.LinkTypes.Hierarchy-Reverse" => "parent",
                "System.LinkTypes.Hierarchy-Forward" => "child",
                "System.LinkTypes.Related" => "related",
                "System.LinkTypes.Dependency-Reverse" => "predecessor",
                "System.LinkTypes.Dependency-Forward" => "successor",
                _ => "other",
            };
            let name = r
                .get("attributes")
                .and_then(|a| str_of(a, "name"))
                .unwrap_or(rel)
                .to_string();
            seen.insert((link, id)).then_some((link, name, id))
        })
        .take(MAX_RELATIONS)
        .collect()
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemComment {
    /// 留言的編號（伺服器支援編輯、刪除留言時才有；TFS 2019 沒有）。
    pub(super) id: Option<u64>,
    pub(super) author: String,
    pub(super) created: Option<String>,
    /// HTML。
    pub(super) text: String,
}

/// 指派給我、還沒結束的工作項目；中英文的流程範本都有對應的「結束」狀態名稱。
pub(super) const CLOSED_STATES: &[&str] = &[
    "Closed",
    "Done",
    "Removed",
    "Completed",
    "Cut",
    "Inactive",
    // 中文的流程範本（不是介面文字）。
    "已關閉", // i18n-ignore
    "已完成", // i18n-ignore
    "已移除", // i18n-ignore
    "已刪除", // i18n-ignore
    "關閉",   // i18n-ignore
    "完成",   // i18n-ignore
];
pub(super) const FIELDS: &str = "System.Id,System.Title,System.State,System.WorkItemType,System.TeamProject,System.AssignedTo,System.ChangedDate";
/// 優先順序欄位（清單排序用）；自訂的流程範本可能沒有。
pub(super) const PRIORITY: &str = "Microsoft.VSTS.Common.Priority";

pub(super) fn wiql_string(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 工作項目清單的篩選條件（前端的篩選列）。
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkItemFilter {
    /// 依 `assigned`（指派給）或 `created`（建立者）篩選人。
    pub role: String,
    /// `@me`（我）、空字串（不限）或名字（部分符合即可）。
    pub person: String,
    /// `open`（還沒結束）、`closed`（已結束）或 `all`。`states` 有值時不看這個。
    pub state: String,
    /// 指定的狀態（例如 `New`、`Active`）；空的是照 `state`。
    pub states: Vec<String>,
    /// 類型（空的是不限）。
    pub kinds: Vec<String>,
    /// 專案（空的是不限）。
    pub projects: Vec<String>,
    /// 區域路徑（例如 `產品\前端`），包含底下的區域；空的是不限。
    pub areas: Vec<String>,
}

impl Default for WorkItemFilter {
    fn default() -> Self {
        WorkItemFilter {
            role: "assigned".into(),
            person: "@me".into(),
            state: "open".into(),
            states: vec![],
            kinds: vec![],
            projects: vec![],
            areas: vec![],
        }
    }
}

/// 多選的條件：去掉空白、重複的值，轉成 WIQL 的 `IN (...)` 清單；沒有值時是 None（不限）。
fn any_of(values: &[String]) -> Option<String> {
    let mut seen: Vec<&str> = vec![];
    for v in values.iter().map(|v| v.trim()).filter(|v| !v.is_empty()) {
        if !seen.contains(&v) {
            seen.push(v);
        }
    }
    (!seen.is_empty()).then(|| {
        seen.iter()
            .map(|v| wiql_string(v))
            .collect::<Vec<_>>()
            .join(", ")
    })
}

/// 搜尋內容時一併搜尋的長文字欄位（全文搜尋）。伺服器沒有全文索引、或流程範本沒有某個欄位時
/// 查詢會失敗，所以依序退回較少的欄位，最後只搜尋標題。
pub(super) const CONTENT_FIELDS: [&[&str]; 3] = [
    &[
        "System.Description",
        "Microsoft.VSTS.TCM.ReproSteps",
        "Microsoft.VSTS.Common.AcceptanceCriteria",
    ],
    &["System.Description"],
    &[],
];

/// 搜尋文字是工作項目編號（`123`、`#123`）時回傳編號。
fn id_search(search: &str) -> Option<u64> {
    let q = search.trim().trim_start_matches('#');
    if q.is_empty() || !q.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    q.parse().ok()
}

/// 搜尋文字與篩選條件（WIQL 的 WHERE 條件，用 AND 連起來）。`p` 是欄位前綴：一般查詢是空字串，
/// 連結查詢裡篩選子項目時是 `[Target].`。
fn conditions(search: &str, f: &WorkItemFilter, content: &[&str], p: &str) -> Vec<String> {
    let q = search.trim().trim_start_matches('#');
    let mut cond: Vec<String> = vec![];
    let role = if f.role == "created" {
        "System.CreatedBy"
    } else {
        "System.AssignedTo"
    };
    match f.person.trim() {
        "" => {}
        "@me" => cond.push(format!("{p}[{role}] = @Me")),
        name => cond.push(format!("{p}[{role}] CONTAINS {}", wiql_string(name))),
    }
    let closed: Vec<String> = CLOSED_STATES.iter().map(|s| wiql_string(s)).collect();
    if let Some(states) = any_of(&f.states) {
        cond.push(format!("{p}[System.State] IN ({states})"));
    } else {
        match f.state.as_str() {
            "open" => cond.push(format!("{p}[System.State] NOT IN ({})", closed.join(", "))),
            "closed" => cond.push(format!("{p}[System.State] IN ({})", closed.join(", "))),
            _ => {}
        }
    }
    if let Some(kinds) = any_of(&f.kinds) {
        cond.push(format!("{p}[System.WorkItemType] IN ({kinds})"));
    }
    if let Some(projects) = any_of(&f.projects) {
        cond.push(format!("{p}[System.TeamProject] IN ({projects})"));
    }
    let areas: Vec<String> = f
        .areas
        .iter()
        .map(|a| a.trim())
        .filter(|a| !a.is_empty())
        .map(|a| format!("{p}[System.AreaPath] UNDER {}", wiql_string(a)))
        .collect();
    if !areas.is_empty() {
        cond.push(format!("({})", areas.join(" OR ")));
    }
    if !q.is_empty() {
        let mut any = vec![format!("{p}[System.Title] CONTAINS {}", wiql_string(q))];
        for field in content {
            any.push(format!("{p}[{field}] CONTAINS WORDS {}", wiql_string(q)));
        }
        cond.push(format!("({})", any.join(" OR ")));
    }
    cond
}

/// 依搜尋文字與篩選條件產生 WIQL；輸入的是編號（`123`、`#123`）時回傳 None，直接讀取那一個。
pub(super) fn wiql_for(search: &str, f: &WorkItemFilter, content: &[&str]) -> Option<String> {
    if id_search(search).is_some() {
        return None;
    }
    let mut cond = conditions(search, f, content, "");
    if cond.is_empty() {
        cond.push("[System.Id] > 0".into());
    }
    Some(format!(
        "SELECT [System.Id] FROM WorkItems WHERE {} ORDER BY [System.ChangedDate] DESC",
        cond.join(" AND ")
    ))
}

/// 上層項目底下、符合搜尋文字與篩選條件的子項目（連結查詢）。
pub(super) fn children_wiql(
    parents: &[u64],
    search: &str,
    f: &WorkItemFilter,
    content: &[&str],
) -> String {
    let ids = parents
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    let mut cond = vec![
        format!("[Source].[System.Id] IN ({ids})"),
        format!("[System.Links.LinkType] = {}", wiql_string(CHILD_LINK)),
    ];
    cond.extend(conditions(search, f, content, "[Target]."));
    format!(
        "SELECT [System.Id] FROM WorkItemLinks WHERE {} MODE (MustContain)",
        cond.join(" AND ")
    )
}

/// 上層 → 子項目的連結類型。
const CHILD_LINK: &str = "System.LinkTypes.Hierarchy-Forward";

/// 連結查詢的結果：(子項目, 上層)。第一層（只有 target、沒有 source）的列是上層項目本身，略過。
pub(super) fn child_links(res: &Value) -> Vec<(u64, u64)> {
    res.get("workItemRelations")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|r| r.get("rel").and_then(Value::as_str) == Some(CHILD_LINK))
                .filter_map(|r| {
                    let parent = r.get("source")?.get("id")?.as_u64()?;
                    let child = r.get("target")?.get("id")?.as_u64()?;
                    Some((child, parent))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn work_item_url(base: &str, project: &str, id: u64) -> String {
    format!("{base}/{}/_workitems/edit/{id}", encode_segment(project))
}

pub(super) fn field<'a>(item: &'a Value, name: &str) -> Option<&'a Value> {
    item.get("fields")?.get(name)
}

pub(super) fn field_str(item: &Value, name: &str) -> String {
    field(item, name)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

pub(super) fn item_of(base: &str, v: &Value) -> Option<WorkItem> {
    let id = v.get("id").and_then(Value::as_u64)?;
    let project = field_str(v, "System.TeamProject");
    Some(WorkItem {
        id,
        title: field_str(v, "System.Title"),
        state: field_str(v, "System.State"),
        kind: field_str(v, "System.WorkItemType"),
        web_url: work_item_url(base, &project, id),
        project,
        assigned_to: person(field(v, "System.AssignedTo")),
        changed: field(v, "System.ChangedDate")
            .and_then(Value::as_str)
            .map(str::to_string),
        priority: field(v, PRIORITY).and_then(Value::as_u64),
    })
}

/// 指派對象：新版是物件（取 displayName），舊版是「名字 <網域\帳號>」字串。
pub(super) fn person(v: Option<&Value>) -> Option<String> {
    let v = v?;
    let name = match v {
        Value::Object(_) => str_of(v, "displayName")?.to_string(),
        Value::String(s) => s.split(" <").next().unwrap_or(s).to_string(),
        _ => return None,
    };
    Some(name).filter(|n| !n.trim().is_empty())
}

/// 工作項目清單（最多 100 個）：搜尋文字空白時是「指派給我、還沒結束的」。
#[tauri::command]
pub async fn ado_work_items(
    app: AppHandle,
    search: String,
    filter: Option<WorkItemFilter>,
) -> Result<Vec<WorkItem>, String> {
    let (a, pat) = require(&app)?;
    let filter = filter.unwrap_or_default();
    crate::io::blocking_for(TIMEOUT, move || {
        let base = a.url;
        let ids: Vec<u64> = if wiql_for(&search, &filter, &[]).is_none() {
            vec![search.trim().trim_start_matches('#').parse().unwrap_or(0)]
        } else {
            let mut last = String::new();
            let mut found = None;
            // 有搜尋文字時先試全文搜尋內容，失敗（伺服器不支援）再退回較少的欄位。
            let levels: &[&[&str]] = if search.trim().is_empty() {
                &[&[]]
            } else {
                &CONTENT_FIELDS
            };
            for content in levels {
                let query = wiql_for(&search, &filter, content).unwrap_or_default();
                match post(
                    &base,
                    &pat,
                    "/_apis/wit/wiql?$top=100",
                    &serde_json::json!({ "query": query }),
                    &tr!("查詢工作項目"),
                ) {
                    Ok(res) => {
                        found = Some(res);
                        break;
                    }
                    // 權杖或權限的問題換欄位也沒用。
                    Err(e) if e.contains("401") || e.contains("403") => return Err(e),
                    Err(e) => last = e,
                }
            }
            let res = found.ok_or(last)?;
            res.get("workItems")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|w| w.get("id").and_then(Value::as_u64))
                        .take(100)
                        .collect()
                })
                .unwrap_or_default()
        };
        if ids.is_empty() {
            return Ok(vec![]);
        }
        fetch_work_items(&base, &pat, &ids)
    })
    .await
}

/// 讀取工作項目的摘要，保持 `ids` 的順序（查詢的排序）；讀不到的略過。
pub(super) fn fetch_work_items(
    base: &str,
    pat: &str,
    ids: &[u64],
) -> Result<Vec<WorkItem>, String> {
    let list: Vec<String> = ids.iter().map(u64::to_string).collect();
    let fetch = |fields: &str| {
        get(
            base,
            pat,
            &format!(
                "/_apis/wit/workitems?ids={}&fields={fields}&errorPolicy=omit",
                list.join(",")
            ),
            &tr!("讀取工作項目"),
        )
    };
    // 連優先順序一起讀；流程範本沒有這個欄位（伺服器回錯誤）時改成不讀。
    let res = match fetch(&format!("{FIELDS},{PRIORITY}")) {
        Ok(res) => res,
        Err(e) if e.contains("401") || e.contains("403") => return Err(e),
        Err(_) => fetch(FIELDS)?,
    };
    let mut items: Vec<WorkItem> = values(&res)
        .iter()
        .filter_map(|v| item_of(base, v))
        .collect();
    // 保持查詢的排序（最近更新的在前面）。
    items.sort_by_key(|w| ids.iter().position(|id| *id == w.id).unwrap_or(usize::MAX));
    Ok(items)
}

/// TFS 上存的查詢（我的查詢、共用查詢）。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub(super) id: String,
    pub(super) project: String,
    pub(super) name: String,
    /// 所在的資料夾（例如 `Shared Queries/團隊`）。
    pub(super) folder: String,
}

/// 查詢樹（`wit/queries?$depth=2`）攤平成查詢清單（資料夾不列）。
pub(super) fn flatten_queries(project: &str, nodes: &[Value], out: &mut Vec<SavedQuery>) {
    for node in nodes {
        if node
            .get("isFolder")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            if let Some(children) = node.get("children").and_then(Value::as_array) {
                flatten_queries(project, children, out);
            }
            continue;
        }
        let (Some(id), Some(name)) = (str_of(node, "id"), str_of(node, "name")) else {
            continue;
        };
        let path = str_of(node, "path").unwrap_or(name);
        let folder = path.rsplit_once('/').map_or("", |(f, _)| f).to_string();
        out.push(SavedQuery {
            id: id.to_string(),
            project: project.to_string(),
            name: name.to_string(),
            folder,
        });
    }
}

/// 所有專案（最多 20 個）存的查詢；讀不到的專案略過。
#[tauri::command]
pub async fn ado_queries(app: AppHandle) -> Result<Vec<SavedQuery>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let res = get(&a.url, &pat, "/_apis/projects?$top=1000", &tr!("讀取專案"))?;
        let mut projects: Vec<String> = values(&res)
            .iter()
            .filter_map(|p| str_of(p, "name").map(str::to_string))
            .collect();
        projects.sort_by_key(|p| p.to_lowercase());
        let mut out = vec![];
        for project in projects.iter().take(20) {
            let path = format!(
                "/{}/_apis/wit/queries?$depth=2&$expand=minimal",
                encode_segment(project)
            );
            if let Ok(res) = get(&a.url, &pat, &path, &tr!("讀取已儲存的查詢")) {
                flatten_queries(project, values(&res), &mut out);
            }
        }
        Ok(out)
    })
    .await
}

/// 查詢結果裡的工作項目編號（一般查詢是 `workItems`，樹狀、連結查詢是 `workItemRelations`），不重複、照順序。
pub(super) fn query_ids(v: &Value) -> Vec<u64> {
    let mut ids: Vec<u64> = vec![];
    let mut push = |id: Option<u64>| {
        if let Some(id) = id {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    };
    for w in v
        .get("workItems")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        push(w.get("id").and_then(Value::as_u64));
    }
    for r in v
        .get("workItemRelations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        push(r.pointer("/source/id").and_then(Value::as_u64));
        push(r.pointer("/target/id").and_then(Value::as_u64));
    }
    ids.truncate(200);
    ids
}

/// 執行存的查詢，回傳工作項目（最多 200 個，照查詢的排序）。
#[tauri::command]
pub async fn ado_query_run(
    app: AppHandle,
    project: String,
    id: String,
) -> Result<Vec<WorkItem>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let path = format!(
            "/{}/_apis/wit/wiql/{}?$top=200",
            encode_segment(&project),
            encode_segment(&id)
        );
        let res = get(&a.url, &pat, &path, &tr!("執行查詢"))?;
        let ids = query_ids(&res);
        if ids.is_empty() {
            return Ok(vec![]);
        }
        // 一次最多讀 200 個（伺服器的上限）。
        fetch_work_items(&a.url, &pat, &ids)
    })
    .await
}

/// 依編號讀取工作項目（文件裡連結旁的狀態標籤用）；最多 200 個，讀不到的（刪除、沒權限）略過。
#[tauri::command]
pub async fn ado_work_items_by_ids(app: AppHandle, ids: Vec<u64>) -> Result<Vec<WorkItem>, String> {
    let (a, pat) = require(&app)?;
    let mut ids = ids;
    ids.sort_unstable();
    ids.dedup();
    ids.truncate(200);
    if ids.is_empty() {
        return Ok(vec![]);
    }
    crate::io::blocking_for(TIMEOUT, move || {
        let list: Vec<String> = ids.iter().map(u64::to_string).collect();
        let res = get(
            &a.url,
            &pat,
            &format!(
                "/_apis/wit/workitems?ids={}&fields={FIELDS}&errorPolicy=omit",
                list.join(",")
            ),
            &tr!("讀取工作項目"),
        )?;
        Ok(values(&res)
            .iter()
            .filter_map(|v| item_of(&a.url, v))
            .collect())
    })
    .await
}

/// 工作項目的上層項目（例如 Task 屬於哪個 User Story）：`links` 是 (項目, 上層)，`parents` 是上層項目本身（分組標題用）。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemParents {
    pub(super) links: Vec<(u64, u64)>,
    pub(super) parents: Vec<WorkItem>,
}

/// 新版伺服器有 `System.Parent` 欄位。
pub(super) fn parent_field(v: &Value) -> Option<(u64, u64)> {
    Some((v.get("id")?.as_u64()?, field(v, "System.Parent")?.as_u64()?))
}

/// 舊版（TFS 2019 以前）沒有那個欄位，從關聯裡找「上層」。
pub(super) fn parent_relation(v: &Value) -> Option<(u64, u64)> {
    let id = v.get("id")?.as_u64()?;
    let parent = relation_links(v)
        .into_iter()
        .find(|(link, ..)| *link == "parent")?
        .2;
    Some((id, parent))
}

/// 依清單上的工作項目讀出上層項目（「依上層項目分組」用）；最多 200 個。
#[tauri::command]
pub async fn ado_work_item_parents(
    app: AppHandle,
    ids: Vec<u64>,
) -> Result<WorkItemParents, String> {
    let (a, pat) = require(&app)?;
    let mut ids = ids;
    ids.sort_unstable();
    ids.dedup();
    ids.truncate(200);
    if ids.is_empty() {
        return Ok(WorkItemParents {
            links: vec![],
            parents: vec![],
        });
    }
    crate::io::blocking_for(TIMEOUT, move || {
        let list = ids.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
        let what = tr!("讀取上層項目");
        let links: Vec<(u64, u64)> = match get(
            &a.url,
            &pat,
            &format!(
                "/_apis/wit/workitems?ids={list}&fields=System.Id,System.Parent&errorPolicy=omit"
            ),
            &what,
        ) {
            Ok(res) => values(&res).iter().filter_map(parent_field).collect(),
            Err(e) if e.contains("401") || e.contains("403") => return Err(e),
            // 沒有 System.Parent 欄位的伺服器：改讀關聯（會帶回所有欄位，比較慢）。
            Err(_) => {
                let res = get(
                    &a.url,
                    &pat,
                    &format!("/_apis/wit/workitems?ids={list}&$expand=relations&errorPolicy=omit"),
                    &what,
                )?;
                values(&res).iter().filter_map(parent_relation).collect()
            }
        };
        let mut parent_ids: Vec<u64> = links.iter().map(|(_, p)| *p).collect();
        parent_ids.sort_unstable();
        parent_ids.dedup();
        let parents = if parent_ids.is_empty() {
            vec![]
        } else {
            fetch_work_items(&a.url, &pat, &parent_ids)?
        };
        Ok(WorkItemParents { links, parents })
    })
    .await
}

/// 上層項目底下的子項目：`links` 是 (子項目, 上層)，`items` 是子項目本身。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemChildren {
    pub(super) links: Vec<(u64, u64)>,
    pub(super) items: Vec<WorkItem>,
}

/// 子項目最多讀幾個（每個上層的子項目通常不多，這是避免一次讀太多的保險）。
const CHILDREN_LIMIT: usize = 400;

/// 「依上層項目分組」：上層項目底下、符合篩選條件的子項目。清單只取最近更新的 100 個，
/// 比較早更新的子項目不在清單上，組裡的數量就會比上層項目實際的子項目少；用這個補齊。
#[tauri::command]
pub async fn ado_work_item_children(
    app: AppHandle,
    parents: Vec<u64>,
    search: String,
    filter: Option<WorkItemFilter>,
) -> Result<WorkItemChildren, String> {
    let (a, pat) = require(&app)?;
    let filter = filter.unwrap_or_default();
    let mut parents = parents;
    parents.sort_unstable();
    parents.dedup();
    parents.truncate(200);
    let empty = WorkItemChildren {
        links: vec![],
        items: vec![],
    };
    if parents.is_empty() || id_search(&search).is_some() {
        return Ok(empty);
    }
    crate::io::blocking_for(TIMEOUT, move || {
        let levels: &[&[&str]] = if search.trim().is_empty() {
            &[&[]]
        } else {
            &CONTENT_FIELDS
        };
        let mut last = String::new();
        let mut found = None;
        for content in levels {
            let query = children_wiql(&parents, &search, &filter, content);
            match post(
                &a.url,
                &pat,
                "/_apis/wit/wiql",
                &serde_json::json!({ "query": query }),
                &tr!("讀取子項目"),
            ) {
                Ok(res) => {
                    found = Some(res);
                    break;
                }
                Err(e) if e.contains("401") || e.contains("403") => return Err(e),
                Err(e) => last = e,
            }
        }
        let mut links = child_links(&found.ok_or(last)?);
        links.truncate(CHILDREN_LIMIT);
        let ids: Vec<u64> = links.iter().map(|(child, _)| *child).collect();
        let mut items = vec![];
        for chunk in ids.chunks(200) {
            items.extend(fetch_work_items(&a.url, &pat, chunk)?);
        }
        Ok(WorkItemChildren { links, items })
    })
    .await
}

/// 一個工作項目的內容。
/// 篩選列的選項：專案、工作項目類型與狀態。
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemFilterOptions {
    pub(super) projects: Vec<String>,
    pub(super) kinds: Vec<String>,
    pub(super) states: Vec<StateOption>,
}

/// 狀態篩選的一個選項：名稱，與是不是「已結束」（和清單「進行中」的條件用同一份名單）。
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct StateOption {
    pub(super) name: String,
    pub(super) closed: bool,
}

/// 「已結束」的狀態（`CLOSED_STATES`，不分大小寫，和 WIQL 一樣）。
fn is_closed_state(name: &str) -> bool {
    CLOSED_STATES.iter().any(|c| c.eq_ignore_ascii_case(name))
}

/// 一個工作項目類型定義的狀態與階段：新版的類型有 `states`（名稱與分類），舊版從狀態轉換整理。
pub(super) fn type_states(t: &Value) -> Vec<(u8, String)> {
    let listed: Vec<(u8, String)> = t
        .get("states")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|s| {
            let name = str_of(s, "name")?.to_string();
            let stage =
                str_of(s, "category").map_or_else(|| stage_of_name(&name), stage_of_category);
            Some((stage, name))
        })
        .collect();
    if !listed.is_empty() {
        return listed;
    }
    states_from_transitions(t)
        .into_iter()
        .map(|n| (stage_of_name(&n), n))
        .collect()
}

/// 幾個類型的狀態合成一份：同名的（不分大小寫）只列一次，依流程的階段排（同一階段照出現的順序）。
pub(super) fn merge_states(all: Vec<(u8, String)>) -> Vec<StateOption> {
    let mut out: Vec<(u8, String)> = vec![];
    for (stage, name) in all {
        if !out.iter().any(|(_, n)| n.eq_ignore_ascii_case(&name)) {
            out.push((stage, name));
        }
    }
    out.sort_by_key(|(stage, _)| *stage);
    out.into_iter()
        .map(|(_, name)| StateOption {
            closed: is_closed_state(&name),
            name,
        })
        .collect()
}

/// 不會出現在一般清單的類型（測試、程式碼檢閱、意見反應等）。
pub(super) const HIDDEN_KINDS: &[&str] = &[
    "Code Review Request",
    "Code Review Response",
    "Feedback Request",
    "Feedback Response",
    "Shared Steps",
    "Shared Parameter",
    "Test Case",
    "Test Plan",
    "Test Suite",
];

#[tauri::command]
pub async fn ado_work_item_filters(app: AppHandle) -> Result<WorkItemFilterOptions, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let res = get(&a.url, &pat, "/_apis/projects?$top=1000", &tr!("讀取專案"))?;
        let mut projects: Vec<String> = values(&res)
            .iter()
            .filter_map(|p| str_of(p, "name").map(str::to_string))
            .collect();
        projects.sort_by_key(|p| p.to_lowercase());
        let mut kinds: Vec<String> = vec![];
        let mut states: Vec<(u8, String)> = vec![];
        for p in projects.iter().take(20) {
            let path = format!("/{}/_apis/wit/workitemtypes", encode_segment(p));
            let Ok(res) = get(&a.url, &pat, &path, &tr!("讀取工作項目類型")) else {
                continue;
            };
            for t in values(&res) {
                let Some(k) = str_of(t, "name") else { continue };
                if HIDDEN_KINDS.contains(&k) {
                    continue;
                }
                if !kinds.iter().any(|x| x == k) {
                    kinds.push(k.to_string());
                }
                states.extend(type_states(t));
            }
        }
        kinds.sort_by_key(|k| k.to_lowercase());
        Ok(WorkItemFilterOptions {
            projects,
            kinds,
            states: merge_states(states),
        })
    })
    .await
}

/// 一個專案（或所有專案）可以篩選的區域與人。
#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemScopeOptions {
    /// 區域路徑（不含專案本身），依樹狀順序。
    pub(super) areas: Vec<String>,
    /// 團隊成員的顯示名稱。
    pub(super) people: Vec<String>,
}

pub(super) const MAX_AREAS: usize = 500;
pub(super) const MAX_TEAMS: usize = 20;

/// 把區域樹攤平成路徑（`產品\前端\登入`）；最上層是專案本身，不列出。
pub(super) fn area_paths(root: &Value) -> Vec<String> {
    fn walk(node: &Value, path: &str, out: &mut Vec<String>) {
        for child in node
            .get("children")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            if out.len() >= MAX_AREAS {
                return;
            }
            let Some(name) = str_of(child, "name") else {
                continue;
            };
            let p = format!("{path}\\{name}");
            out.push(p.clone());
            walk(child, &p, out);
        }
    }
    let mut out = vec![];
    if let Some(name) = str_of(root, "name") {
        walk(root, name, &mut out);
    }
    out
}

/// 反覆項目（Sprint）：路徑與起訖日期（沒有設定日期時是空的）。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Iteration {
    pub(super) path: String,
    pub(super) start: Option<String>,
    pub(super) finish: Option<String>,
}

/// 把反覆項目樹攤平成路徑（`產品\Sprint 3`），第一個是專案本身（不屬於任何 Sprint）。
pub(super) fn iteration_list(root: &Value) -> Vec<Iteration> {
    fn date(node: &Value, key: &str) -> Option<String> {
        node.get("attributes")
            .and_then(|a| str_of(a, key))
            .map(str::to_string)
    }
    fn walk(node: &Value, path: &str, out: &mut Vec<Iteration>) {
        for child in node
            .get("children")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            if out.len() >= MAX_AREAS {
                return;
            }
            let Some(name) = str_of(child, "name") else {
                continue;
            };
            let p = format!("{path}\\{name}");
            out.push(Iteration {
                path: p.clone(),
                start: date(child, "startDate"),
                finish: date(child, "finishDate"),
            });
            walk(child, &p, out);
        }
    }
    let mut out = vec![];
    if let Some(name) = str_of(root, "name") {
        out.push(Iteration {
            path: name.to_string(),
            start: None,
            finish: None,
        });
        walk(root, name, &mut out);
    }
    out
}

/// 專案的反覆項目（Sprint）：編輯工作項目時選擇。
#[tauri::command]
pub async fn ado_iterations(app: AppHandle, project: String) -> Result<Vec<Iteration>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let path = format!(
            "/{}/_apis/wit/classificationnodes/iterations?$depth=10",
            encode_segment(&project)
        );
        Ok(iteration_list(&get(
            &a.url,
            &pat,
            &path,
            &tr!("讀取 Sprint 清單"),
        )?))
    })
    .await
}

/// 團隊成員的名字：新版在 `identity` 裡，舊版直接是成員；群組不列出。
pub(super) fn member_names(res: &Value) -> Vec<String> {
    values(res)
        .iter()
        .map(|m| m.get("identity").unwrap_or(m))
        .filter(|m| m.get("isContainer").and_then(Value::as_bool) != Some(true))
        .filter_map(|m| str_of(m, "displayName"))
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .collect()
}

/// 篩選列的區域與人：有選專案時讀那個專案的區域與團隊成員；沒選時只讀前幾個專案的成員。
#[tauri::command]
pub async fn ado_work_item_scope(
    app: AppHandle,
    project: Option<String>,
) -> Result<WorkItemScopeOptions, String> {
    let (a, pat) = require(&app)?;
    let project = project.filter(|p| !p.trim().is_empty());
    crate::io::blocking_for(TIMEOUT, move || {
        let mut areas = vec![];
        let projects: Vec<String> = match &project {
            Some(p) => {
                let path = format!(
                    "/{}/_apis/wit/classificationnodes/areas?$depth=10",
                    encode_segment(p)
                );
                areas = area_paths(&get(&a.url, &pat, &path, &tr!("讀取區域"))?);
                vec![p.clone()]
            }
            None => {
                let res = get(&a.url, &pat, "/_apis/projects?$top=10", &tr!("讀取專案"))?;
                values(&res)
                    .iter()
                    .filter_map(|p| str_of(p, "name").map(str::to_string))
                    .collect()
            }
        };
        let mut seen = std::collections::HashSet::new();
        let mut people: Vec<String> = vec![];
        let mut teams = 0;
        // 讀不到成員（權限不足、舊版伺服器）時只是沒有建議名字，仍可自己輸入。
        'projects: for p in &projects {
            let path = format!("/_apis/projects/{}/teams?$top=100", encode_segment(p));
            let Ok(res) = get(&a.url, &pat, &path, &tr!("讀取團隊")) else {
                continue;
            };
            for team in values(&res) {
                if teams >= MAX_TEAMS {
                    break 'projects;
                }
                let Some(id) = str_of(team, "id") else {
                    continue;
                };
                teams += 1;
                let path = format!(
                    "/_apis/projects/{}/teams/{}/members?$top=1000",
                    encode_segment(p),
                    encode_segment(id)
                );
                if let Ok(res) = get(&a.url, &pat, &path, &tr!("讀取團隊成員")) {
                    for name in member_names(&res) {
                        if seen.insert(name.clone()) {
                            people.push(name);
                        }
                    }
                }
            }
        }
        people.sort_by_key(|n| n.to_lowercase());
        Ok(WorkItemScopeOptions { areas, people })
    })
    .await
}

#[tauri::command]
pub async fn ado_work_item(app: AppHandle, id: u64) -> Result<WorkItemDetail, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let v = get(
            &a.url,
            &pat,
            &format!("/_apis/wit/workitems/{id}?$expand=relations"),
            &tr!("讀取工作項目"),
        )?;
        let mut d =
            detail_of(&a.url, &v).ok_or_else(|| tr!("讀取工作項目失敗：回應的格式不正確"))?;
        // 相關工作項目的標題、狀態要另外查；讀不到不影響其他內容。
        let links = relation_links(&v);
        if !links.is_empty() {
            let mut ids: Vec<u64> = links.iter().map(|(_, _, id)| *id).collect();
            ids.sort_unstable();
            ids.dedup();
            let ids: Vec<String> = ids.iter().map(u64::to_string).collect();
            let path = format!(
                "/_apis/wit/workitems?ids={}&fields={FIELDS}&errorPolicy=omit",
                ids.join(",")
            );
            if let Ok(res) = get(&a.url, &pat, &path, &tr!("讀取工作項目")) {
                let items: Vec<WorkItem> = values(&res)
                    .iter()
                    .filter_map(|v| item_of(&a.url, v))
                    .collect();
                d.relations = links
                    .into_iter()
                    .filter_map(|(link, link_name, id)| {
                        let item = items.iter().find(|w| w.id == id)?.clone();
                        Some(WorkItemRelation {
                            link,
                            link_name,
                            item,
                        })
                    })
                    .collect();
            }
        }
        // 留言是另外的 API；讀不到不影響其他內容。先用可以編輯、刪除的版本（Azure DevOps Server 2020 起），
        // 舊版伺服器（TFS 2019）退回只能讀的版本。
        let path = format!(
            "/{}/_apis/wit/workItems/{id}/comments",
            encode_segment(&d.item.project)
        );
        if let Ok(c) = get_version(&a.url, &pat, &path, Some(COMMENTS_API), &tr!("讀取留言")) {
            d.comments = comments_of(&c, true);
        } else if let Ok(c) =
            get_version(&a.url, &pat, &path, Some("5.0-preview.2"), &tr!("讀取留言"))
        {
            d.comments = comments_of(&c, false);
        }
        Ok(d)
    })
    .await
}

/// 可以編輯、刪除留言的 API 版本（Azure DevOps Server 2020 起）。
const COMMENTS_API: &str = "5.1-preview.3";

/// `editable`：用的是可以編輯、刪除的 API（留言帶編號）。
pub(super) fn comments_of(v: &Value, editable: bool) -> Vec<WorkItemComment> {
    let mut list: Vec<WorkItemComment> = v
        .get("comments")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        // 刪除的留言（5.1 起可能還會列出來，標成 isDeleted）不顯示。
        .filter(|c| c.get("isDeleted").and_then(Value::as_bool) != Some(true))
        .filter_map(|c| {
            let text = str_of(c, "text")?.trim().to_string();
            // 5.1 起是 createdBy／createdDate；TFS 2019（5.0-preview.2）是 revisedBy／revisedDate。
            (!text.is_empty()).then(|| WorkItemComment {
                id: editable
                    .then(|| c.get("id").and_then(Value::as_u64))
                    .flatten(),
                author: person(c.get("createdBy"))
                    .or_else(|| person(c.get("revisedBy")))
                    .unwrap_or_default(),
                created: str_of(c, "createdDate")
                    .or_else(|| str_of(c, "revisedDate"))
                    .map(str::to_string),
                text,
            })
        })
        .collect();
    list.sort_by(|a, b| a.created.cmp(&b.created));
    list
}

/// 改一則留言（只能改自己的；伺服器會檢查）。`html` 是新的內容。
#[tauri::command]
pub async fn ado_comment_update(
    app: AppHandle,
    project: String,
    id: u64,
    comment_id: u64,
    html: String,
) -> Result<(), String> {
    if html.trim().is_empty() {
        return Err(tr!("留言不能是空的"));
    }
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let res = crate::update::agent()
            .patch(&comment_url(&a.url, &project, id, comment_id))
            .header("Authorization", &basic(&pat))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .send(&serde_json::json!({ "text": html }).to_string());
        read(res, &tr!("修改留言"))
            .map(|_| ())
            .map_err(comment_error)
    })
    .await
}

/// 刪除一則留言（只能刪自己的；伺服器會檢查）。
#[tauri::command]
pub async fn ado_comment_delete(
    app: AppHandle,
    project: String,
    id: u64,
    comment_id: u64,
) -> Result<(), String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let res = crate::update::agent()
            .delete(&comment_url(&a.url, &project, id, comment_id))
            .header("Authorization", &basic(&pat))
            .header("Accept", "application/json")
            .call();
        match res {
            // 成功時沒有內容（204）。
            Ok(_) => Ok(()),
            res => read(res, &tr!("刪除留言"))
                .map(|_| ())
                .map_err(comment_error),
        }
    })
    .await
}

fn comment_url(base: &str, project: &str, id: u64, comment_id: u64) -> String {
    format!(
        "{base}/{}/_apis/wit/workItems/{id}/comments/{comment_id}?api-version={COMMENTS_API}",
        encode_segment(project)
    )
}

/// 舊版伺服器沒有這個 API（404）時，說明原因。
fn comment_error(e: String) -> String {
    if super::is_not_found(&e) {
        tr!("這個伺服器不支援修改或刪除留言（需要 Azure DevOps Server 2020 以上）")
    } else {
        e
    }
}

// ---- 工作項目：上傳附件 -------------------------------------------------------------

/// 上傳檔案成工作項目的附件（還沒掛到工作項目上），回傳附件的網址：之後用 `attachments` 掛上去，
/// 或放進說明、留言的圖片。原始位元組放在請求本文，專案與檔名放在標頭（百分比編碼）。
#[tauri::command]
pub async fn ado_attachment_upload(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let header = |key: &str| {
        request
            .headers()
            .get(key)
            .and_then(|v| v.to_str().ok())
            .map(crate::dav::decode_percent)
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| tr!("上傳的資料不正確"))
    };
    let project = header("x-project")?;
    let name = header("x-name")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(tr!("上傳的資料不正確"));
    };
    if bytes.len() > MAX_ATTACHMENT {
        return Err(tr!(
            "「{name}」超過 60 MB，Azure DevOps 不接受這麼大的附件",
            name = name
        ));
    }
    let bytes = bytes.clone();
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let what = tr!("上傳附件");
        let res = crate::update::agent()
            .post(&format!(
                "{}/{}/_apis/wit/attachments?fileName={}&api-version={API_VERSION}",
                a.url,
                encode_segment(&project),
                encode_segment(&name)
            ))
            .header("Authorization", &basic(&pat))
            .header("Accept", "application/json")
            .header("Content-Type", "application/octet-stream")
            .send(&bytes[..]);
        let v = read(res, &what)?;
        str_of(&v, "url")
            .map(str::to_string)
            .ok_or_else(|| tr!("上傳附件失敗：回應的格式不正確"))
    })
    .await
}

// ---- 工作項目：修改記錄 -------------------------------------------------------------

/// 修改記錄裡一個改了的欄位。長文字欄位（說明、驗收條件等 HTML）只標出有修改，不帶內容。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FieldChange {
    /// 欄位的參考名稱（例如 `System.State`）；前端換成看得懂的名稱。
    pub(super) field: String,
    pub(super) old: Option<String>,
    pub(super) new: Option<String>,
    pub(super) long: bool,
}

/// 修改記錄裡加入或移除的關聯：工作項目（`id`）或附件、超連結（`name`）。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RevisionLink {
    /// `parent`、`child`、`related`、`predecessor`、`successor`、`attachment`、`hyperlink` 或 `other`。
    pub(super) kind: &'static str,
    pub(super) id: Option<u64>,
    pub(super) name: String,
}

/// 修改記錄的一筆：誰、什麼時候、改了哪些欄位、留言、加了或移除哪些關聯。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemRevision {
    pub(super) rev: u64,
    pub(super) author: String,
    pub(super) date: Option<String>,
    pub(super) fields: Vec<FieldChange>,
    /// 這次加的留言（HTML）。
    pub(super) comment: Option<String>,
    pub(super) added: Vec<RevisionLink>,
    pub(super) removed: Vec<RevisionLink>,
}

/// 每次修改都會變、看了沒有意義的欄位。
const NOISE_FIELDS: &[&str] = &[
    "System.Rev",
    "System.Id",
    "System.AuthorizedDate",
    "System.RevisedDate",
    "System.ChangedDate",
    "System.ChangedBy",
    "System.AuthorizedAs",
    "System.PersonId",
    "System.Watermark",
    "System.CommentCount",
    "System.AreaId",
    "System.IterationId",
    "System.NodeName",
    "System.TeamProject",
    "System.History",
    "System.CreatedDate",
    "System.BoardColumnDone",
    "System.ExternalLinkCount",
    "System.HyperLinkCount",
    "System.AttachedFileCount",
    "System.RelatedLinkCount",
    "System.RemoteLinkCount",
    "System.Parent",
    "Microsoft.VSTS.Common.StateChangeDate",
];

/// 人的欄位：值是「名字 <網域\帳號>」或物件，只留名字。
const IDENTITY_FIELDS: &[&str] = &[
    "System.AssignedTo",
    "System.CreatedBy",
    "Microsoft.VSTS.Common.ActivatedBy",
    "Microsoft.VSTS.Common.ResolvedBy",
    "Microsoft.VSTS.Common.ClosedBy",
];

/// 長文字（HTML）欄位：只標出有修改。
const LONG_FIELDS: &[&str] = &[
    "System.Description",
    "Microsoft.VSTS.Common.AcceptanceCriteria",
    "Microsoft.VSTS.TCM.ReproSteps",
    "Microsoft.VSTS.TCM.SystemInfo",
    "Microsoft.VSTS.TCM.Steps",
];

fn change_value(field: &str, v: Option<&Value>) -> Option<String> {
    let v = v?;
    if IDENTITY_FIELDS.contains(&field) || v.is_object() {
        return person(Some(v));
    }
    match v {
        Value::String(s) => Some(s.clone()).filter(|s| !s.is_empty()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn revision_link(r: &Value) -> Option<RevisionLink> {
    let rel = str_of(r, "rel")?;
    let url = str_of(r, "url").unwrap_or_default();
    let name = r
        .get("attributes")
        .and_then(|a| str_of(a, "name"))
        .unwrap_or_default()
        .to_string();
    let id = url
        .to_ascii_lowercase()
        .rfind("/workitems/")
        .and_then(|at| url[at + "/workitems/".len()..].parse().ok());
    let kind = match rel {
        "System.LinkTypes.Hierarchy-Reverse" => "parent",
        "System.LinkTypes.Hierarchy-Forward" => "child",
        "System.LinkTypes.Related" => "related",
        "System.LinkTypes.Dependency-Reverse" => "predecessor",
        "System.LinkTypes.Dependency-Forward" => "successor",
        "AttachedFile" => "attachment",
        "Hyperlink" => "hyperlink",
        _ => "other",
    };
    let name = if name.is_empty() && kind == "hyperlink" {
        url.to_string()
    } else if name.is_empty() {
        rel.to_string()
    } else {
        name
    };
    Some(RevisionLink { kind, id, name })
}

/// `wit/workItems/{id}/updates` 的回應整理成修改記錄（最新的在前）；只改了系統欄位的那幾次略過。
pub(super) fn work_item_revisions(res: &Value) -> Vec<WorkItemRevision> {
    let mut out: Vec<WorkItemRevision> = values(res)
        .iter()
        .filter_map(|u| {
            let fields = u.get("fields").and_then(Value::as_object);
            let comment = fields
                .and_then(|f| f.get("System.History"))
                .and_then(|h| h.get("newValue"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .map(str::to_string);
            let mut changes: Vec<FieldChange> = fields
                .map(|f| {
                    f.iter()
                        .filter(|(name, _)| !NOISE_FIELDS.contains(&name.as_str()))
                        .filter_map(|(name, change)| {
                            let long = LONG_FIELDS.contains(&name.as_str());
                            let old = change_value(name, change.get("oldValue"));
                            let new = change_value(name, change.get("newValue"));
                            if old == new {
                                return None;
                            }
                            Some(if long {
                                FieldChange {
                                    field: name.clone(),
                                    old: None,
                                    new: None,
                                    long,
                                }
                            } else {
                                FieldChange {
                                    field: name.clone(),
                                    old,
                                    new,
                                    long,
                                }
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            changes.sort_by_key(|c| field_order(&c.field));
            let links = |key: &str| -> Vec<RevisionLink> {
                u.pointer(&format!("/relations/{key}"))
                    .and_then(Value::as_array)
                    .map(|list| list.iter().filter_map(revision_link).collect())
                    .unwrap_or_default()
            };
            let added = links("added");
            let removed = links("removed");
            if changes.is_empty() && comment.is_none() && added.is_empty() && removed.is_empty() {
                return None;
            }
            let author = fields
                .and_then(|f| f.get("System.ChangedBy"))
                .and_then(|c| person(c.get("newValue")))
                .or_else(|| person(u.get("revisedBy")))
                .unwrap_or_default();
            // 修改的時間是那次的 ChangedDate；revisedDate 是下一次修改的時間（最新一筆是 9999 年）。
            let date = fields
                .and_then(|f| f.get("System.ChangedDate"))
                .and_then(|c| c.get("newValue"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    str_of(u, "revisedDate")
                        .filter(|d| !d.starts_with("9999"))
                        .map(str::to_string)
                });
            Some(WorkItemRevision {
                rev: u.get("rev").and_then(Value::as_u64).unwrap_or_default(),
                author,
                date,
                fields: changes,
                comment,
                added,
                removed,
            })
        })
        .collect();
    out.reverse();
    out
}

/// 常看的欄位排前面（標題、狀態、指派…），其他照名稱。
fn field_order(field: &str) -> (usize, String) {
    const FIRST: &[&str] = &[
        "System.Title",
        "System.State",
        "System.Reason",
        "System.AssignedTo",
        "System.IterationPath",
        "System.AreaPath",
        "Microsoft.VSTS.Common.Priority",
        "Microsoft.VSTS.Scheduling.RemainingWork",
        "Microsoft.VSTS.Scheduling.CompletedWork",
        "System.Tags",
    ];
    let at = FIRST
        .iter()
        .position(|f| *f == field)
        .unwrap_or(FIRST.len());
    (at, field.to_string())
}

/// 工作項目的修改記錄（最新的在前，最多 200 次修改）。
#[tauri::command]
pub async fn ado_work_item_history(
    app: AppHandle,
    id: u64,
) -> Result<Vec<WorkItemRevision>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let res = get(
            &a.url,
            &pat,
            &format!("/_apis/wit/workItems/{id}/updates?$top=200"),
            &tr!("讀取修改記錄"),
        )?;
        Ok(work_item_revisions(&res))
    })
    .await
}

// ---- 工作項目：改狀態、指派給我、留言 ---------------------------------------------

/// 這個類型的工作項目可以設定的狀態（依流程的順序）。
#[tauri::command]
pub async fn ado_work_item_states(
    app: AppHandle,
    project: String,
    kind: String,
) -> Result<Vec<String>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let what = tr!("讀取工作項目的狀態");
        let base = format!(
            "/{}/_apis/wit/workitemtypes/{}",
            encode_segment(&project),
            encode_segment(&kind)
        );
        // 狀態清單是 2018 起的預覽版 API；舊版伺服器改從類型定義的狀態轉換整理出來。
        if let Ok(v) = get_version(
            &a.url,
            &pat,
            &format!("{base}/states"),
            Some("4.1-preview.1"),
            &what,
        ) {
            let states = states_by_category(&v);
            if !states.is_empty() {
                return Ok(states);
            }
        }
        let v = get(&a.url, &pat, &base, &what)?;
        Ok(states_from_transitions(&v))
    })
    .await
}

/// 狀態在流程裡的階段（工作板的欄位、狀態選單依這個排）：提議、進行中、已解決、已完成、已移除。
fn stage_of_category(category: &str) -> u8 {
    match category {
        "Proposed" => 0,
        "InProgress" => 1,
        "Resolved" => 2,
        "Completed" => 3,
        "Removed" => 4,
        _ => 1,
    }
}

/// 從名稱猜階段（舊版伺服器沒有分類）；認不得的當成進行中。
fn stage_of_name(name: &str) -> u8 {
    // 常見流程範本的狀態名稱（英文與中文），不是介面文字。
    match name.to_lowercase().as_str() {
        "new" | "to do" | "proposed" | "design" | "approved" | "新增" | "待辦" => 0, // i18n-ignore
        "resolved" | "已解決" => 2,                                                  // i18n-ignore
        "closed" | "done" | "completed" | "已關閉" | "已完成" | "完成" => 3,         // i18n-ignore
        "removed" | "cut" | "已移除" | "已刪除" => 4,                                // i18n-ignore
        _ => 1,
    }
}

/// 新版 API 的狀態清單：依分類（提議 → 進行中 → 已解決 → 已完成 → 已移除）排，同一類照伺服器的順序。
pub(super) fn states_by_category(v: &Value) -> Vec<String> {
    let mut list: Vec<(u8, String)> = values(v)
        .iter()
        .filter_map(|s| {
            let name = str_of(s, "name")?.to_string();
            let stage =
                str_of(s, "category").map_or_else(|| stage_of_name(&name), stage_of_category);
            Some((stage, name))
        })
        .collect();
    list.sort_by_key(|(stage, _)| *stage);
    list.into_iter().map(|(_, n)| n).collect()
}

/// 類型定義裡的狀態轉換（`{"": [{"to": "New"}], "New": [{"to": "Active"}], ...}`）出現過的所有狀態，
/// 依流程排：從起始狀態（`""` 轉過去的）沿著轉換走，再依名稱猜的階段排（JSON 物件的順序不可靠）。
pub(super) fn states_from_transitions(v: &Value) -> Vec<String> {
    let Some(map) = v.get("transitions").and_then(Value::as_object) else {
        return vec![];
    };
    let next = |from: &str| -> Vec<String> {
        map.get(from)
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .filter_map(|t| str_of(t, "to"))
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    };
    let mut out: Vec<String> = vec![];
    let mut queue: std::collections::VecDeque<String> = next("").into();
    while let Some(s) = queue.pop_front() {
        if out.contains(&s) {
            continue;
        }
        queue.extend(next(&s));
        out.push(s);
    }
    // 起始狀態走不到的（不完整的定義）也列出來。
    let mut rest: Vec<String> = map.keys().filter(|k| !k.is_empty()).cloned().collect();
    for list in map.values() {
        for t in list.as_array().map_or(&[][..], Vec::as_slice) {
            rest.extend(
                str_of(t, "to")
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
            );
        }
    }
    rest.sort();
    for s in rest {
        if !out.contains(&s) {
            out.push(s);
        }
    }
    out.sort_by_key(|s| stage_of_name(s));
    out
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkItemChange {
    pub state: Option<String>,
    pub assign_to_me: bool,
    /// 留言（HTML），加到討論裡。
    pub comment: Option<String>,
    /// 開啟時的修訂版本：伺服器上的版本不同（被別人改過）時不更新。
    pub rev: Option<u64>,
    /// 標題（不可以是空的）。
    pub title: Option<String>,
    /// 優先順序（1 最高，到 4）。
    pub priority: Option<u8>,
    /// 反覆項目（Sprint）的路徑，例如 `產品\Sprint 3`。
    pub iteration: Option<String>,
    /// 標籤；空的清單表示清除所有標籤。
    pub tags: Option<Vec<String>>,
    /// 說明（HTML）；空字串表示清除。
    pub description: Option<String>,
    /// 驗收條件（HTML，User Story、Feature 等）；空字串表示清除。
    pub acceptance_criteria: Option<String>,
    /// 重現步驟（HTML，Bug）；空字串表示清除。
    pub repro_steps: Option<String>,
    /// 指派給誰（帳號，例如 `網域\帳號` 或信箱）；空字串表示取消指派。
    pub assigned_to: Option<String>,
    /// 剩餘工時（小時）。
    pub remaining: Option<f64>,
    /// 已完成工時（小時）。
    pub completed: Option<f64>,
    /// 設定上層（換掉原本的上層）；0 表示移除上層。
    pub parent: Option<u64>,
    /// 加入的關聯（子項目、相關、前置、後續…）。
    pub links_add: Vec<LinkChange>,
    /// 移除的關聯。
    pub links_remove: Vec<LinkChange>,
    /// 加入附件：先用 `ado_attachment_upload` 上傳，這裡是回傳的網址。
    pub attachments: Option<Vec<String>>,
}

/// 加入或移除的一個關聯：種類（`parent`、`child`、`related`、`predecessor`、`successor`）與對方的編號。
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkChange {
    pub kind: String,
    pub id: u64,
}

/// 關聯種類對應的連結類型。
pub(super) fn link_rel(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "parent" => "System.LinkTypes.Hierarchy-Reverse",
        "child" => "System.LinkTypes.Hierarchy-Forward",
        "related" => "System.LinkTypes.Related",
        "predecessor" => "System.LinkTypes.Dependency-Reverse",
        "successor" => "System.LinkTypes.Dependency-Forward",
        _ => return None,
    })
}

/// 關聯指到的工作項目編號（`.../_apis/wit/workItems/42`）。
fn relation_target(r: &Value) -> Option<u64> {
    let url = str_of(r, "url")?;
    let at = url.to_ascii_lowercase().rfind("/workitems/")?;
    url[at + "/workitems/".len()..].parse().ok()
}

/// 改關聯的 JSON Patch：先移除（由後往前，前面的位置才不會跑掉），再加入（加在最後）。
/// `relations` 是工作項目目前的關聯（移除時要知道位置；已經有的關聯不重複加）。
pub(super) fn link_ops(
    change: &WorkItemChange,
    relations: &[Value],
    base: &str,
    id: u64,
) -> Result<Vec<Value>, String> {
    let mut adds: Vec<(&'static str, u64)> = vec![];
    if let Some(p) = change.parent.filter(|p| *p != 0) {
        adds.push(("System.LinkTypes.Hierarchy-Reverse", p));
    }
    for l in &change.links_add {
        let rel =
            link_rel(&l.kind).ok_or_else(|| tr!("看不懂的關聯種類：{kind}", kind = l.kind))?;
        adds.push((rel, l.id));
    }
    let mut removes: Vec<(&'static str, u64)> = vec![];
    for l in &change.links_remove {
        let rel =
            link_rel(&l.kind).ok_or_else(|| tr!("看不懂的關聯種類：{kind}", kind = l.kind))?;
        removes.push((rel, l.id));
    }
    if adds.iter().any(|(_, target)| *target == id) {
        return Err(tr!("不能把工作項目連到自己"));
    }
    let mut indexes: Vec<usize> = relations
        .iter()
        .enumerate()
        .filter(|(_, r)| {
            let rel = str_of(r, "rel").unwrap_or_default();
            let target = relation_target(r);
            // 換上層：原本的上層（不管是哪一個）都拿掉。
            (change.parent.is_some() && rel == "System.LinkTypes.Hierarchy-Reverse")
                || removes
                    .iter()
                    .any(|(want, t)| *want == rel && Some(*t) == target)
        })
        .map(|(i, _)| i)
        .collect();
    indexes.sort_unstable_by(|a, b| b.cmp(a));
    let mut ops: Vec<Value> = indexes
        .iter()
        .map(|i| serde_json::json!({ "op": "remove", "path": format!("/relations/{i}") }))
        .collect();
    let kept = |rel: &str, target: u64| {
        relations.iter().enumerate().any(|(i, r)| {
            !indexes.contains(&i)
                && str_of(r, "rel") == Some(rel)
                && relation_target(r) == Some(target)
        })
    };
    let mut seen: Vec<(&str, u64)> = vec![];
    for (rel, target) in adds {
        if kept(rel, target) || seen.contains(&(rel, target)) {
            continue;
        }
        seen.push((rel, target));
        ops.push(serde_json::json!({
            "op": "add",
            "path": "/relations/-",
            "value": {
                "rel": rel,
                "url": format!("{}/_apis/wit/workItems/{target}", base.trim_end_matches('/')),
            },
        }));
    }
    Ok(ops)
}

/// 附件一次最多多大（Azure DevOps 預設的上限是 60 MB）。
pub(super) const MAX_ATTACHMENT: usize = 60 * 1024 * 1024;

/// 加入的附件必須是這台伺服器的工作項目附件（不能把任意網址掛成附件）。
pub(super) fn check_attachments(change: &WorkItemChange, base: &str) -> Result<(), String> {
    let base = base.trim_end_matches('/').to_ascii_lowercase();
    for url in change.attachments.iter().flatten() {
        let lower = url.to_ascii_lowercase();
        if !lower.starts_with(&format!("{base}/")) || !lower.contains("/_apis/wit/attachments/") {
            return Err(tr!("附件的網址不正確"));
        }
    }
    Ok(())
}

/// 標題最多幾個字（Azure DevOps 的限制）。
pub(super) const MAX_TITLE: usize = 255;

/// 檢查要更新的欄位：標題不可以是空的或太長、優先順序只能是 1～4。
pub(super) fn check_change(change: &WorkItemChange) -> Result<(), String> {
    if let Some(title) = &change.title {
        if title.trim().is_empty() {
            return Err(tr!("請輸入標題"));
        }
        if title.trim().chars().count() > MAX_TITLE {
            return Err(tr!("標題最多 {n} 個字", n = MAX_TITLE));
        }
    }
    if change.priority.is_some_and(|p| !(1..=4).contains(&p)) {
        return Err(tr!("優先順序要是 1 到 4"));
    }
    if [change.remaining, change.completed]
        .into_iter()
        .flatten()
        .any(|h| !h.is_finite() || h < 0.0)
    {
        return Err(tr!("工時要是 0 或正數"));
    }
    Ok(())
}

/// 標籤欄位的值：去掉空白、分號（標籤之間用分號隔開）與重複的（不分大小寫）。
pub(super) fn tags_value(tags: &[String]) -> String {
    let mut out: Vec<String> = vec![];
    for tag in tags {
        let tag = tag.replace(';', " ");
        let tag = tag.trim();
        if !tag.is_empty() && !out.iter().any(|t| t.to_lowercase() == tag.to_lowercase()) {
            out.push(tag.to_string());
        }
    }
    out.join("; ")
}

/// 更新工作項目要送出的 JSON Patch。`me` 是登入的帳號（指派給我用）。
pub(super) fn change_ops(change: &WorkItemChange, me: &str) -> Vec<Value> {
    let mut ops = vec![];
    if let Some(rev) = change.rev {
        ops.push(serde_json::json!({ "op": "test", "path": "/rev", "value": rev }));
    }
    if let Some(title) = change
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        ops.push(
            serde_json::json!({ "op": "add", "path": "/fields/System.Title", "value": title }),
        );
    }
    if let Some(priority) = change.priority {
        ops.push(serde_json::json!({ "op": "add", "path": "/fields/Microsoft.VSTS.Common.Priority", "value": priority }));
    }
    if let Some(iteration) = change
        .iteration
        .as_deref()
        .map(str::trim)
        .filter(|i| !i.is_empty())
    {
        ops.push(serde_json::json!({ "op": "add", "path": "/fields/System.IterationPath", "value": iteration }));
    }
    if let Some(tags) = &change.tags {
        // 空字串就是清除所有標籤。
        ops.push(serde_json::json!({ "op": "add", "path": "/fields/System.Tags", "value": tags_value(tags) }));
    }
    // 長文字欄位（HTML）：空字串就是清除。
    for (field, value) in [
        ("System.Description", &change.description),
        (
            "Microsoft.VSTS.Common.AcceptanceCriteria",
            &change.acceptance_criteria,
        ),
        ("Microsoft.VSTS.TCM.ReproSteps", &change.repro_steps),
    ] {
        if let Some(html) = value {
            ops.push(serde_json::json!({ "op": "add", "path": format!("/fields/{field}"), "value": html.trim() }));
        }
    }
    if let Some(state) = change.state.as_deref().filter(|s| !s.is_empty()) {
        ops.push(
            serde_json::json!({ "op": "add", "path": "/fields/System.State", "value": state }),
        );
    }
    if change.assign_to_me {
        ops.push(
            serde_json::json!({ "op": "add", "path": "/fields/System.AssignedTo", "value": me }),
        );
    } else if let Some(who) = change.assigned_to.as_deref().map(str::trim) {
        // 空的就是取消指派。
        ops.push(
            serde_json::json!({ "op": "add", "path": "/fields/System.AssignedTo", "value": who }),
        );
    }
    for url in change.attachments.iter().flatten() {
        ops.push(serde_json::json!({
            "op": "add",
            "path": "/relations/-",
            "value": { "rel": "AttachedFile", "url": url },
        }));
    }
    for (field, hours) in [
        ("Microsoft.VSTS.Scheduling.RemainingWork", change.remaining),
        ("Microsoft.VSTS.Scheduling.CompletedWork", change.completed),
    ] {
        if let Some(h) = hours {
            ops.push(
                serde_json::json!({ "op": "add", "path": format!("/fields/{field}"), "value": h }),
            );
        }
    }
    if let Some(comment) = change.comment.as_deref().filter(|c| !c.trim().is_empty()) {
        // System.History 就是工作項目的討論（所有版本的伺服器都支援）。
        ops.push(
            serde_json::json!({ "op": "add", "path": "/fields/System.History", "value": comment }),
        );
    }
    ops
}

/// 改狀態、指派給我、留言、標題、優先順序、Sprint、標籤、說明、驗收條件、重現步驟（可以一起）。
#[tauri::command]
pub async fn ado_work_item_update(
    app: AppHandle,
    id: u64,
    change: WorkItemChange,
) -> Result<(), String> {
    let (a, pat) = require(&app)?;
    check_change(&change)?;
    check_attachments(&change, &a.url)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let me = assign_me(&a);
        let mut ops = change_ops(&change, &me);
        if change.parent.is_some() || !change.links_add.is_empty() || !change.links_remove.is_empty() {
            // 移除關聯要知道它在第幾個；也順便避免重複加入一樣的關聯。
            let current = get(
                &a.url,
                &pat,
                &format!("/_apis/wit/workitems/{id}?$expand=relations"),
                &tr!("讀取工作項目"),
            )?;
            let relations = current
                .get("relations")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice);
            ops.extend(link_ops(&change, relations, &a.url, id)?);
        }
        if ops.iter().all(|op| op["op"] == "test") {
            return Ok(());
        }
        let res = crate::update::agent()
            .patch(&format!(
                "{}/_apis/wit/workitems/{id}?api-version={API_VERSION}",
                a.url
            ))
            .config()
            .http_status_as_error(false)
            .build()
            .header("Authorization", &basic(&pat))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json-patch+json")
            .send(&Value::Array(ops).to_string());
        let mut r = res.map_err(|e| {
            tr!(
                "更新工作項目失敗：連不到 Azure DevOps 伺服器，請確認網路或 VPN 連線（{e}）",
                e = e
            )
        })?;
        let code = r.status().as_u16();
        if code < 400 {
            return Ok(());
        }
        let text = r.body_mut().read_to_string().unwrap_or_default();
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| str_of(&v, "message").map(str::to_string))
            .unwrap_or_default();
        Err(match code {
            401 => tr!("更新工作項目失敗：個人存取權杖無效或已過期，或權杖沒有「工作項目：讀取與寫入」的權限"),
            403 => tr!("更新工作項目失敗：沒有權限修改這個工作項目"),
            // 修訂版本不同：開啟之後被別人改過了。
            409 | 412 => tr!("這個工作項目在你開啟之後被別人改過了，請重新整理後再試一次"),
            _ if message.is_empty() => tr!("更新工作項目失敗：伺服器回應 {code}", code = code),
            _ => tr!("更新工作項目失敗：{message}", message = message),
        })
    })
    .await
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NewWorkItem {
    pub project: String,
    pub kind: String,
    pub title: String,
    /// 內容（HTML）；Bug 放在「重現步驟」，其他類型放在「描述」。
    pub description: Option<String>,
    pub assign_to_me: bool,
    /// 指派給誰（團隊成員清單裡的帳號）；有給時不看 `assign_to_me`。
    pub assigned_to: Option<String>,
    /// 上層工作項目的編號。
    pub parent: Option<u64>,
    /// 放進哪個反覆項目（Sprint）的路徑；沒給時由伺服器決定（通常是專案的根）。
    pub iteration: Option<String>,
    /// 剩餘工時（小時）。
    pub remaining: Option<f64>,
}

/// 「指派給我」送出的身分。帳號是「網域\帳號」或信箱時用帳號；有些伺服器的登入資訊只有帳號本身
/// （例如員工編號 00595436），直接送出會被拒絕（unknown identity），這時改用顯示名稱，伺服器會用名稱找到人。
pub(super) fn assign_me(a: &Account) -> String {
    match a.account.as_deref().map(str::trim) {
        Some(acc) if acc.contains('\\') || acc.contains('@') => acc.to_string(),
        _ => a.name.trim().to_string(),
    }
}

/// 建立工作項目要送出的 JSON Patch。`me` 是登入的帳號，`base` 是集合的網址（上層連結用）。
pub(super) fn create_ops(item: &NewWorkItem, me: &str, base: &str) -> Vec<Value> {
    let mut ops = vec![
        serde_json::json!({ "op": "add", "path": "/fields/System.Title", "value": item.title.trim() }),
    ];
    if let Some(html) = item.description.as_deref().filter(|d| !d.trim().is_empty()) {
        let field = if item.kind.eq_ignore_ascii_case("Bug") {
            "Microsoft.VSTS.TCM.ReproSteps"
        } else {
            "System.Description"
        };
        ops.push(
            serde_json::json!({ "op": "add", "path": format!("/fields/{field}"), "value": html }),
        );
    }
    let who = item
        .assigned_to
        .as_deref()
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .or(item.assign_to_me.then_some(me));
    if let Some(who) = who {
        ops.push(
            serde_json::json!({ "op": "add", "path": "/fields/System.AssignedTo", "value": who }),
        );
    }
    if let Some(iteration) = item
        .iteration
        .as_deref()
        .map(str::trim)
        .filter(|i| !i.is_empty())
    {
        ops.push(serde_json::json!({ "op": "add", "path": "/fields/System.IterationPath", "value": iteration }));
    }
    if let Some(h) = item.remaining.filter(|h| h.is_finite() && *h >= 0.0) {
        ops.push(serde_json::json!({ "op": "add", "path": "/fields/Microsoft.VSTS.Scheduling.RemainingWork", "value": h }));
    }
    if let Some(parent) = item.parent {
        ops.push(serde_json::json!({
            "op": "add",
            "path": "/relations/-",
            "value": {
                "rel": "System.LinkTypes.Hierarchy-Reverse",
                "url": format!("{}/_apis/wit/workItems/{parent}", base.trim_end_matches('/')),
            }
        }));
    }
    ops
}

/// 建立工作項目，回傳新的工作項目。
#[tauri::command]
pub async fn ado_work_item_create(app: AppHandle, item: NewWorkItem) -> Result<WorkItem, String> {
    let (a, pat) = require(&app)?;
    if item.title.trim().is_empty() {
        return Err(tr!("請輸入標題"));
    }
    crate::io::blocking_for(TIMEOUT, move || {
        let me = assign_me(&a);
        let ops = create_ops(&item, &me, &a.url);
        let res = crate::update::agent()
            .post(&format!(
                "{}/{}/_apis/wit/workitems/${}?api-version={API_VERSION}",
                a.url,
                encode_segment(&item.project),
                encode_segment(&item.kind)
            ))
            .config()
            .http_status_as_error(false)
            .build()
            .header("Authorization", &basic(&pat))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json-patch+json")
            .send(&Value::Array(ops).to_string());
        let mut r = res.map_err(|e| {
            tr!(
                "建立工作項目失敗：連不到 Azure DevOps 伺服器，請確認網路或 VPN 連線（{e}）",
                e = e
            )
        })?;
        let code = r.status().as_u16();
        let text = r.body_mut().read_to_string().unwrap_or_default();
        let v = serde_json::from_str::<Value>(&text).ok();
        if code < 400 {
            return v
                .as_ref()
                .and_then(|v| item_of(&a.url, v))
                .ok_or_else(|| tr!("建立工作項目失敗：伺服器的回應不是預期的格式"));
        }
        let message = v
            .as_ref()
            .and_then(|v| str_of(v, "message").map(str::to_string))
            .unwrap_or_default();
        Err(match code {
            401 => tr!("建立工作項目失敗：個人存取權杖無效或已過期，或權杖沒有「工作項目：讀取與寫入」的權限"),
            403 => tr!("建立工作項目失敗：沒有權限在這個專案建立工作項目"),
            _ if message.is_empty() => tr!("建立工作項目失敗：伺服器回應 {code}", code = code),
            _ => tr!("建立工作項目失敗：{message}", message = message),
        })
    })
    .await
}

/// 工作項目內文裡的圖片：附件要用權杖才能讀，網頁元件自己載不到。
/// 只讀取連線中那台伺服器上的網址，不跟隨轉址（權杖不會被送到別的地方），回傳 data: 網址。
#[tauri::command]
pub async fn ado_image(app: AppHandle, url: String) -> Result<String, String> {
    let (a, pat) = require(&app)?;
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://"))
        || !same_server(&url, &a.url)
    {
        return Err(tr!("只能讀取 Azure DevOps 伺服器上的圖片"));
    }
    crate::io::blocking_for(TIMEOUT, move || {
        let mut res = crate::update::agent()
            .get(&url)
            .config()
            .max_redirects(0)
            .build()
            .header("Authorization", &basic(&pat))
            .call()
            .map_err(|e| tr!("無法讀取圖片：{e}", e = e))?;
        let mime = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if !mime.starts_with("image/") || mime == "image/svg+xml" {
            return Err(tr!("無法讀取圖片：不是圖片"));
        }
        let bytes = res
            .body_mut()
            .with_config()
            .limit(10 * 1024 * 1024)
            .read_to_vec()
            .map_err(|e| tr!("無法讀取圖片：{e}", e = e))?;
        Ok(data_url(&mime, bytes))
    })
    .await
}
