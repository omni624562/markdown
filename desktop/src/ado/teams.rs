//! 團隊：專案的團隊、團隊選用的 Sprint（工作項目的 Sprint 篩選、comet setup 用），以及找人（留言 @ 人用）。

use super::*;

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

/// 團隊成員（留言 @ 人用）。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    pub(super) name: String,
    /// 帳號（`網域\帳號` 或信箱）：指派時送這個。
    pub(super) unique: String,
    /// 身分的編號：留言裡 @ 人要用這個，對方才會收到通知（舊版伺服器沒給時是空字串）。
    pub(super) id: String,
}

/// 專案預設團隊的成員（留言 @ 人時先列出這些人）。
#[tauri::command]
pub async fn ado_project_members(
    app: AppHandle,
    project: String,
) -> Result<Vec<TeamMember>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let what = tr!("讀取團隊成員");
        let info = get(
            &a.url,
            &pat,
            &format!("/_apis/projects/{}", encode_segment(&project)),
            &what,
        )?;
        let Some(team) = info.get("defaultTeam").and_then(|t| str_of(t, "id")) else {
            return Ok(vec![]);
        };
        let path = format!(
            "/_apis/projects/{}/teams/{}/members?$top=500",
            encode_segment(&project),
            encode_segment(team)
        );
        Ok(team_members_of(&get(&a.url, &pat, &path, &what)?))
    })
    .await
}

/// 找人（和網頁版留言裡打 @ 一樣，用伺服器的身分搜尋，找得到不在團隊裡的人）。
#[tauri::command]
pub async fn ado_search_people(app: AppHandle, query: String) -> Result<Vec<TeamMember>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(vec![]);
    }
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let body = serde_json::json!({
            "query": query,
            "identityTypes": ["user"],
            "operationScopes": ["ims", "source"],
            "properties": ["DisplayName", "SignInAddress", "SamAccountName", "ScopeName", "Mail"],
            "options": { "MinResults": 5, "MaxResults": 20 },
        });
        let res = post_version(
            &a.url,
            &pat,
            "/_apis/IdentityPicker/Identities",
            &body,
            "5.0-preview.1",
            &tr!("找人"),
        )?;
        Ok(picked_people(&res))
    })
    .await
}

/// 身分搜尋的結果：沒有伺服器上的身分（從來沒登入過，`localId` 是空的）的人 @ 了也收不到，不列出。
pub(super) fn picked_people(res: &Value) -> Vec<TeamMember> {
    let mut list: Vec<TeamMember> = vec![];
    let identities = res
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|r| r.get("identities").and_then(Value::as_array))
        .flatten();
    for who in identities {
        let (Some(id), Some(name)) = (
            str_of(who, "localId").filter(|s| !s.is_empty()),
            str_of(who, "displayName"),
        ) else {
            continue;
        };
        let unique = match (str_of(who, "scopeName"), str_of(who, "samAccountName")) {
            (Some(scope), Some(sam)) if !scope.is_empty() && !sam.is_empty() => {
                format!("{scope}\\{sam}")
            }
            _ => str_of(who, "signInAddress")
                .or_else(|| str_of(who, "mail"))
                .unwrap_or_default()
                .to_string(),
        };
        if !list.iter().any(|m| m.id.eq_ignore_ascii_case(id)) {
            list.push(TeamMember {
                name: name.to_string(),
                unique,
                id: id.to_string(),
            });
        }
    }
    list
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
                id: str_of(who, "id").unwrap_or_default().to_string(),
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
