//! Sprint 工作板：團隊、團隊的 Sprint，以及一個 Sprint 裡的工作項目（含上層項目的關係）。
//! 欄位（狀態）由前端依工作項目類型的狀態排；拖曳改狀態沿用 `ado_work_item_update`。

use super::*;

/// 一次最多讀幾個工作項目（API 一次最多 200 個，分批讀）。
const BOARD_MAX: usize = 600;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub(super) id: String,
    pub(super) name: String,
    /// 專案的預設團隊。
    pub(super) default: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamIteration {
    pub(super) id: String,
    pub(super) name: String,
    /// 反覆項目路徑（例如 `產品\Sprint 102`）。
    pub(super) path: String,
    pub(super) start: Option<String>,
    pub(super) finish: Option<String>,
    /// 目前的 Sprint（伺服器依日期判斷）。
    pub(super) current: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardItem {
    #[serde(flatten)]
    pub(super) item: WorkItem,
    /// 修訂版本（拖曳改狀態時確認這段時間沒有被別人改過）。
    pub(super) rev: Option<u64>,
    /// 上層項目的編號（不一定在這個 Sprint 裡）。
    pub(super) parent: Option<u64>,
    /// 剩餘、已完成、原始估計的工時；流程範本沒有或沒填時是空的。
    pub(super) remaining: Option<f64>,
    pub(super) completed: Option<f64>,
    pub(super) original: Option<f64>,
}

/// 專案的團隊（預設團隊排第一個）。
#[tauri::command]
pub async fn ado_teams(app: AppHandle, project: String) -> Result<Vec<Team>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let what = tr!("讀取團隊");
        let p = encode_segment(&project);
        let default = get(&a.url, &pat, &format!("/_apis/projects/{p}"), &what)
            .ok()
            .and_then(|v| {
                v.pointer("/defaultTeam/id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
        let res = get(
            &a.url,
            &pat,
            &format!("/_apis/projects/{p}/teams?$top=300"),
            &what,
        )?;
        Ok(teams_of(&res, default.as_deref()))
    })
    .await
}

pub(super) fn teams_of(res: &Value, default: Option<&str>) -> Vec<Team> {
    let mut list: Vec<Team> = values(res)
        .iter()
        .filter_map(|t| {
            let id = str_of(t, "id")?.to_string();
            Some(Team {
                default: default.is_some_and(|d| d.eq_ignore_ascii_case(&id)),
                name: str_of(t, "name")?.to_string(),
                id,
            })
        })
        .collect();
    list.sort_by(|a, b| b.default.cmp(&a.default).then_with(|| a.name.cmp(&b.name)));
    list
}

/// 一段休假（含頭尾，日期字串 `YYYY-MM-DD…`）。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DaysOff {
    pub(super) start: String,
    pub(super) end: String,
}

/// 一位成員在這個 Sprint 的容量：每天可以做幾小時（各活動加總）與休假。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemberCapacity {
    pub(super) name: String,
    pub(super) per_day: f64,
    pub(super) days_off: Vec<DaysOff>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Capacity {
    pub(super) members: Vec<MemberCapacity>,
    /// 整個團隊的休假（例如國定假日）。
    pub(super) team_days_off: Vec<DaysOff>,
}

/// 團隊在某個 Sprint 的容量（成員每天的工時、個人與團隊的休假）；團隊沒有設定時是空的。
#[tauri::command]
pub async fn ado_capacity(
    app: AppHandle,
    project: String,
    team: String,
    iteration: String,
) -> Result<Capacity, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let base = format!(
            "/{}/{}/_apis/work/teamsettings/iterations/{}",
            encode_segment(&project),
            encode_segment(&team),
            encode_segment(&iteration)
        );
        let what = tr!("讀取容量");
        let members = get(&a.url, &pat, &format!("{base}/capacities"), &what)?;
        // 團隊休假讀不到（舊版伺服器、沒有權限）就當沒有。
        let team_off = get(&a.url, &pat, &format!("{base}/teamdaysoff"), &what).ok();
        Ok(capacity_of(&members, team_off.as_ref()))
    })
    .await
}

fn days_off_of(v: Option<&Value>) -> Vec<DaysOff> {
    v.and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|d| {
            Some(DaysOff {
                start: str_of(d, "start")?.to_string(),
                end: str_of(d, "end")?.to_string(),
            })
        })
        .collect()
}

/// 舊版回傳 `value`，新版（7.x）回傳 `teamMembers`。
pub(super) fn capacity_of(members: &Value, team_off: Option<&Value>) -> Capacity {
    let list = members
        .get("teamMembers")
        .and_then(Value::as_array)
        .map_or_else(|| values(members), Vec::as_slice);
    let members = list
        .iter()
        .filter_map(|m| {
            let name = m
                .pointer("/teamMember/displayName")
                .and_then(Value::as_str)?
                .to_string();
            let per_day = m
                .get("activities")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice)
                .iter()
                .filter_map(|a| a.get("capacityPerDay").and_then(Value::as_f64))
                .sum();
            Some(MemberCapacity {
                name,
                per_day,
                days_off: days_off_of(m.get("daysOff")),
            })
        })
        .collect();
    Capacity {
        members,
        team_days_off: days_off_of(team_off.and_then(|v| v.get("daysOff"))),
    }
}

/// 團隊成員（指派工作時選人用）。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    pub(super) name: String,
    /// 帳號（`網域\帳號` 或信箱）：指派時送這個。
    pub(super) unique: String,
}

/// 團隊的成員（依名稱排）。
#[tauri::command]
pub async fn ado_team_members(
    app: AppHandle,
    project: String,
    team: String,
) -> Result<Vec<TeamMember>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let path = format!(
            "/_apis/projects/{}/teams/{}/members?$top=500",
            encode_segment(&project),
            encode_segment(&team)
        );
        Ok(team_members_of(&get(
            &a.url,
            &pat,
            &path,
            &tr!("讀取團隊成員"),
        )?))
    })
    .await
}

/// 5.0 以後每個成員包在 `identity` 裡，4.1 直接是身分；停用的帳號不列出。
pub(super) fn team_members_of(res: &Value) -> Vec<TeamMember> {
    let mut list: Vec<TeamMember> = values(res)
        .iter()
        .filter_map(|m| {
            let who = m.get("identity").unwrap_or(m);
            if who.get("inactive").and_then(Value::as_bool) == Some(true) {
                return None;
            }
            Some(TeamMember {
                name: str_of(who, "displayName")?.to_string(),
                unique: str_of(who, "uniqueName")?.to_string(),
            })
        })
        .collect();
    list.sort_by(|a, b| a.name.cmp(&b.name));
    list.dedup_by(|a, b| a.unique.eq_ignore_ascii_case(&b.unique));
    list
}

/// 團隊選用的 Sprint（依開始日期排）。
#[tauri::command]
pub async fn ado_team_iterations(
    app: AppHandle,
    project: String,
    team: String,
) -> Result<Vec<TeamIteration>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let path = format!(
            "/{}/{}/_apis/work/teamsettings/iterations",
            encode_segment(&project),
            encode_segment(&team)
        );
        Ok(team_iterations_of(&get(
            &a.url,
            &pat,
            &path,
            &tr!("讀取 Sprint 清單"),
        )?))
    })
    .await
}

pub(super) fn team_iterations_of(res: &Value) -> Vec<TeamIteration> {
    let mut list: Vec<TeamIteration> = values(res)
        .iter()
        .filter_map(|i| {
            let attr = i.get("attributes");
            let date = |key: &str| attr.and_then(|a| str_of(a, key)).map(str::to_string);
            Some(TeamIteration {
                id: str_of(i, "id")?.to_string(),
                name: str_of(i, "name")?.to_string(),
                path: str_of(i, "path")?.to_string(),
                start: date("startDate"),
                finish: date("finishDate"),
                current: attr.and_then(|a| str_of(a, "timeFrame")) == Some("current"),
            })
        })
        .collect();
    // 沒有日期的排最後。
    list.sort_by(|a, b| match (&a.start, &b.start) {
        (Some(x), Some(y)) => x.cmp(y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.path.cmp(&b.path),
    });
    list
}

/// 一個團隊在某個 Sprint 裡的工作項目（含上層項目的編號與工時）。
/// 團隊負責的範圍依團隊設定（通常是區域路徑）；已移除的不列出。
#[tauri::command]
pub async fn ado_board(
    app: AppHandle,
    project: String,
    team: String,
    iteration: String,
) -> Result<Vec<BoardItem>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let p = encode_segment(&project);
        let scope = get(
            &a.url,
            &pat,
            &format!(
                "/{p}/{}/_apis/work/teamsettings/teamfieldvalues",
                encode_segment(&team)
            ),
            &tr!("讀取團隊設定"),
        )
        .ok();
        let query = board_wiql(&project, &iteration, scope.as_ref());
        let res = post(
            &a.url,
            &pat,
            "/_apis/wit/wiql",
            &serde_json::json!({ "query": query }),
            &tr!("查詢工作板"),
        )?;
        items_of_query(&a.url, &pat, &res)
    })
    .await
}

/// 工作板的查詢：這個 Sprint、團隊負責的範圍（`teamfieldvalues`；讀不到時不限），排除已移除的。
pub(super) fn board_wiql(project: &str, iteration: &str, scope: Option<&Value>) -> String {
    let mut cond = vec![
        format!("[System.TeamProject] = {}", wiql_string(project)),
        format!("[System.IterationPath] = {}", wiql_string(iteration)),
        "[System.State] <> 'Removed'".to_string(),
    ];
    cond.extend(scope.and_then(scope_condition));
    format!(
        "SELECT [System.Id] FROM WorkItems WHERE {} ORDER BY [System.Id]",
        cond.join(" AND ")
    )
}

/// 團隊負責的範圍（`teamfieldvalues`）變成 WIQL 條件；沒有設定時是 `None`（不限）。
fn scope_condition(scope: &Value) -> Option<String> {
    let field = scope
        .pointer("/field/referenceName")
        .and_then(Value::as_str)
        .filter(|f| {
            f.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
        })
        .unwrap_or("System.AreaPath");
    let parts: Vec<String> = scope
        .get("values")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|v| {
            let value = str_of(v, "value")?;
            let under = v.get("includeChildren").and_then(Value::as_bool) == Some(true);
            Some(format!(
                "[{field}] {} {}",
                if under { "UNDER" } else { "=" },
                wiql_string(value)
            ))
        })
        .collect();
    (!parts.is_empty()).then(|| format!("({})", parts.join(" OR ")))
}

/// Backlog 的查詢：團隊範圍裡、還在 Backlog（反覆項目是團隊的 Backlog 反覆項目）、需求類（User Story、PBI、Bug…）、
/// 還沒結束的工作項目；依 Backlog 的順序排（`order` 是排序欄位，`None` 時依編號）。
pub(super) fn backlog_wiql(
    project: &str,
    iteration: &str,
    scope: Option<&Value>,
    order: Option<&str>,
) -> String {
    let mut cond = vec![
        format!("[System.TeamProject] = {}", wiql_string(project)),
        format!("[System.IterationPath] = {}", wiql_string(iteration)),
        "[System.WorkItemType] IN GROUP 'Microsoft.RequirementCategory'".to_string(),
        "[System.State] NOT IN ('Closed', 'Done', 'Removed', 'Completed', 'Cut')".to_string(),
    ];
    cond.extend(scope.and_then(scope_condition));
    format!(
        "SELECT [System.Id] FROM WorkItems WHERE {} ORDER BY [{}]",
        cond.join(" AND "),
        order.unwrap_or("System.Id")
    )
}

/// 團隊設定裡 Backlog 反覆項目的路徑：`\專案\Iteration\X` 這種分類節點的寫法換成 WIQL 用的 `專案\X`；
/// 沒有路徑時用名稱（根節點的名稱就是專案名稱）。
pub(super) fn backlog_iteration_of(settings: &Value, project: &str) -> String {
    let node = settings.get("backlogIteration");
    let path = node
        .and_then(|n| str_of(n, "path"))
        .unwrap_or("")
        .trim_matches('\\');
    if path.is_empty() {
        return node
            .and_then(|n| str_of(n, "name"))
            .filter(|n| !n.is_empty())
            .unwrap_or(project)
            .to_string();
    }
    let mut parts: Vec<&str> = path.split('\\').collect();
    if parts.len() > 1 && parts[1].eq_ignore_ascii_case("Iteration") {
        parts.remove(1);
    }
    parts.join("\\")
}

/// 依查詢結果的順序讀工作項目（含上層項目與工時），最多 `BOARD_MAX` 個。
fn items_of_query(base: &str, pat: &str, res: &Value) -> Result<Vec<BoardItem>, String> {
    let ids: Vec<u64> = res
        .get("workItems")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|w| w.get("id").and_then(Value::as_u64))
        .take(BOARD_MAX)
        .collect();
    let mut items = Vec::new();
    for chunk in ids.chunks(200) {
        let list: Vec<String> = chunk.iter().map(u64::to_string).collect();
        let res = get(
            base,
            pat,
            &format!(
                "/_apis/wit/workitems?ids={}&$expand=relations&errorPolicy=omit",
                list.join(",")
            ),
            &tr!("讀取工作項目"),
        )?;
        items.extend(values(&res).iter().filter_map(|v| board_item_of(base, v)));
    }
    Ok(items)
}

/// 團隊的 Backlog：還沒排進 Sprint 的需求類工作項目，依 Backlog 的順序。
#[tauri::command]
pub async fn ado_backlog(
    app: AppHandle,
    project: String,
    team: String,
) -> Result<Vec<BoardItem>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let p = encode_segment(&project);
        let t = encode_segment(&team);
        let what = tr!("讀取團隊設定");
        let scope = get(
            &a.url,
            &pat,
            &format!("/{p}/{t}/_apis/work/teamsettings/teamfieldvalues"),
            &what,
        )
        .ok();
        let settings = get(
            &a.url,
            &pat,
            &format!("/{p}/{t}/_apis/work/teamsettings"),
            &what,
        )
        .unwrap_or(Value::Null);
        let iteration = backlog_iteration_of(&settings, &project);
        // 排序欄位依流程範本不同（Agile、CMMI 是 StackRank，Scrum 是 BacklogPriority）：一個一個試。
        let mut last = None;
        for order in [
            Some("Microsoft.VSTS.Common.StackRank"),
            Some("Microsoft.VSTS.Common.BacklogPriority"),
            None,
        ] {
            let query = backlog_wiql(&project, &iteration, scope.as_ref(), order);
            match post(
                &a.url,
                &pat,
                "/_apis/wit/wiql",
                &serde_json::json!({ "query": query }),
                &tr!("查詢 Backlog"),
            ) {
                Ok(res) => return items_of_query(&a.url, &pat, &res),
                Err(e) => last = Some(e),
            }
        }
        Err(last.unwrap_or_default())
    })
    .await
}

pub(super) fn board_item_of(base: &str, v: &Value) -> Option<BoardItem> {
    let item = item_of(base, v)?;
    let number = |name: &str| field(v, name).and_then(Value::as_f64);
    let parent = v
        .get("relations")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .find(|r| str_of(r, "rel") == Some("System.LinkTypes.Hierarchy-Reverse"))
        .and_then(|r| str_of(r, "url"))
        .and_then(|u| u.rsplit('/').next())
        .and_then(|id| id.parse().ok());
    Some(BoardItem {
        rev: v.get("rev").and_then(Value::as_u64),
        parent,
        remaining: number("Microsoft.VSTS.Scheduling.RemainingWork"),
        completed: number("Microsoft.VSTS.Scheduling.CompletedWork"),
        original: number("Microsoft.VSTS.Scheduling.OriginalEstimate"),
        item,
    })
}
