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
    /// 區域與反覆項目（例如「產品\前端」「產品\Sprint 3」）。
    pub(super) area: Option<String>,
    pub(super) iteration: Option<String>,
    pub(super) tags: Vec<String>,
    /// 說明（HTML，前端轉成 Markdown 顯示）。
    pub(super) description: Option<String>,
    /// 驗收條件或重現步驟（HTML）。
    pub(super) details: Option<String>,
    /// 留言（舊到新）；伺服器不支援或讀不到時是空的。
    pub(super) comments: Vec<WorkItemComment>,
    /// 修訂版本（改狀態、指派時用來確認這段時間沒有被別人改過）。
    pub(super) rev: Option<u64>,
    /// 相關的工作項目（上層、子項目、相關、前置、後續…）；讀不到時是空的。
    pub(super) relations: Vec<WorkItemRelation>,
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
            let url = str_of(r, "url")?;
            let at = url.to_ascii_lowercase().rfind("/workitems/")?;
            let id: u64 = url[at + "/workitems/".len()..].parse().ok()?;
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
    /// `open`（還沒結束）、`closed`（已結束）或 `all`。
    pub state: String,
    pub kind: Option<String>,
    pub project: Option<String>,
    /// 區域路徑（例如 `產品\前端`），包含底下的區域。
    pub area: Option<String>,
}

impl Default for WorkItemFilter {
    fn default() -> Self {
        WorkItemFilter {
            role: "assigned".into(),
            person: "@me".into(),
            state: "open".into(),
            kind: None,
            project: None,
            area: None,
        }
    }
}

pub(super) fn filled(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|v| !v.is_empty())
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

/// 依搜尋文字與篩選條件產生 WIQL；輸入的是編號（`123`、`#123`）時回傳 None，直接讀取那一個。
pub(super) fn wiql_for(search: &str, f: &WorkItemFilter, content: &[&str]) -> Option<String> {
    let q = search.trim().trim_start_matches('#');
    if q.chars().all(|c| c.is_ascii_digit()) && !q.is_empty() {
        return None;
    }
    let mut cond: Vec<String> = vec![];
    let role = if f.role == "created" {
        "System.CreatedBy"
    } else {
        "System.AssignedTo"
    };
    match f.person.trim() {
        "" => {}
        "@me" => cond.push(format!("[{role}] = @Me")),
        name => cond.push(format!("[{role}] CONTAINS {}", wiql_string(name))),
    }
    let closed: Vec<String> = CLOSED_STATES.iter().map(|s| wiql_string(s)).collect();
    match f.state.as_str() {
        "open" => cond.push(format!("[System.State] NOT IN ({})", closed.join(", "))),
        "closed" => cond.push(format!("[System.State] IN ({})", closed.join(", "))),
        _ => {}
    }
    if let Some(k) = filled(&f.kind) {
        cond.push(format!("[System.WorkItemType] = {}", wiql_string(k)));
    }
    if let Some(p) = filled(&f.project) {
        cond.push(format!("[System.TeamProject] = {}", wiql_string(p)));
    }
    if let Some(a) = filled(&f.area) {
        cond.push(format!("[System.AreaPath] UNDER {}", wiql_string(a)));
    }
    if !q.is_empty() {
        let mut any = vec![format!("[System.Title] CONTAINS {}", wiql_string(q))];
        for field in content {
            any.push(format!("[{field}] CONTAINS WORDS {}", wiql_string(q)));
        }
        cond.push(format!("({})", any.join(" OR ")));
    }
    if cond.is_empty() {
        cond.push("[System.Id] > 0".into());
    }
    Some(format!(
        "SELECT [System.Id] FROM WorkItems WHERE {} ORDER BY [System.ChangedDate] DESC",
        cond.join(" AND ")
    ))
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

/// 一個工作項目的內容。
/// 篩選列的選項：專案與工作項目類型。
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemFilterOptions {
    pub(super) projects: Vec<String>,
    pub(super) kinds: Vec<String>,
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
        for p in projects.iter().take(20) {
            let path = format!("/{}/_apis/wit/workitemtypes", encode_segment(p));
            let Ok(res) = get(&a.url, &pat, &path, &tr!("讀取工作項目類型")) else {
                continue;
            };
            for k in values(&res).iter().filter_map(|t| str_of(t, "name")) {
                if !HIDDEN_KINDS.contains(&k) && !kinds.iter().any(|x| x == k) {
                    kinds.push(k.to_string());
                }
            }
        }
        kinds.sort_by_key(|k| k.to_lowercase());
        Ok(WorkItemFilterOptions { projects, kinds })
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
        // 留言是另外的 API（2019 起的預覽版）；讀不到不影響其他內容。
        let path = format!(
            "/{}/_apis/wit/workItems/{id}/comments",
            encode_segment(&d.item.project)
        );
        if let Ok(c) = get_version(&a.url, &pat, &path, Some("5.0-preview.2"), &tr!("讀取留言"))
        {
            d.comments = comments_of(&c);
        }
        Ok(d)
    })
    .await
}

pub(super) fn comments_of(v: &Value) -> Vec<WorkItemComment> {
    let mut list: Vec<WorkItemComment> = v
        .get("comments")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|c| {
            let text = str_of(c, "text")?.trim().to_string();
            (!text.is_empty()).then(|| WorkItemComment {
                author: person(c.get("createdBy")).unwrap_or_default(),
                created: str_of(c, "createdDate").map(str::to_string),
                text,
            })
        })
        .collect();
    list.sort_by(|a, b| a.created.cmp(&b.created));
    list
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
            let states: Vec<String> = values(&v)
                .iter()
                .filter_map(|s| str_of(s, "name").map(str::to_string))
                .collect();
            if !states.is_empty() {
                return Ok(states);
            }
        }
        let v = get(&a.url, &pat, &base, &what)?;
        Ok(states_from_transitions(&v))
    })
    .await
}

/// 類型定義裡的狀態轉換（`{"Active": [{"to": "Resolved"}], ...}`）出現過的所有狀態。
pub(super) fn states_from_transitions(v: &Value) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut add = |s: &str| {
        if !s.is_empty() && !out.iter().any(|x| x == s) {
            out.push(s.to_string());
        }
    };
    if let Some(map) = v.get("transitions").and_then(Value::as_object) {
        for (from, list) in map {
            add(from);
            for t in list.as_array().map_or(&[][..], Vec::as_slice) {
                add(str_of(t, "to").unwrap_or_default());
            }
        }
    }
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
}

/// 更新工作項目要送出的 JSON Patch。`me` 是登入的帳號（指派給我用）。
pub(super) fn change_ops(change: &WorkItemChange, me: &str) -> Vec<Value> {
    let mut ops = vec![];
    if let Some(rev) = change.rev {
        ops.push(serde_json::json!({ "op": "test", "path": "/rev", "value": rev }));
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
    }
    if let Some(comment) = change.comment.as_deref().filter(|c| !c.trim().is_empty()) {
        // System.History 就是工作項目的討論（所有版本的伺服器都支援）。
        ops.push(
            serde_json::json!({ "op": "add", "path": "/fields/System.History", "value": comment }),
        );
    }
    ops
}

/// 改狀態、指派給我、留言（可以一起）。
#[tauri::command]
pub async fn ado_work_item_update(
    app: AppHandle,
    id: u64,
    change: WorkItemChange,
) -> Result<(), String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let me = a.account.clone().unwrap_or_else(|| a.name.clone());
        let ops = change_ops(&change, &me);
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
    /// 上層工作項目的編號。
    pub parent: Option<u64>,
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
    if item.assign_to_me {
        ops.push(
            serde_json::json!({ "op": "add", "path": "/fields/System.AssignedTo", "value": me }),
        );
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
        let me = a.account.clone().unwrap_or_else(|| a.name.clone());
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
