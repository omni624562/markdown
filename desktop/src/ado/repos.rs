//! Git 儲存庫：列出、下載（clone），以及建立 Pull Request。

use super::*;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub(super) name: String,
    pub(super) project: String,
    pub(super) clone_url: String,
    pub(super) web_url: Option<String>,
    /// 專案 Wiki（不是一般的程式碼儲存庫）。
    pub(super) wiki: bool,
}

pub(super) fn repos_from(base: &str, repos: &Value, wikis: &Value, projects: &Value) -> Vec<Repo> {
    let mut out: Vec<Repo> = values(repos)
        .iter()
        .filter(|r| r.get("isDisabled").and_then(Value::as_bool) != Some(true))
        .filter_map(|r| {
            Some(Repo {
                name: str_of(r, "name")?.to_string(),
                project: r
                    .pointer("/project/name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                clone_url: str_of(r, "remoteUrl")?.to_string(),
                web_url: str_of(r, "webUrl").map(str::to_string),
                wiki: false,
            })
        })
        .collect();
    // 專案 Wiki 的儲存庫不會出現在儲存庫清單裡，用專案名稱組出網址。
    for w in values(wikis) {
        if str_of(w, "type") != Some("projectWiki") {
            continue;
        }
        let (Some(name), Some(project_id)) = (str_of(w, "name"), str_of(w, "projectId")) else {
            continue;
        };
        let Some(project) = values(projects)
            .iter()
            .find(|p| str_of(p, "id") == Some(project_id))
            .and_then(|p| str_of(p, "name"))
        else {
            continue;
        };
        out.push(Repo {
            name: name.to_string(),
            project: project.to_string(),
            clone_url: format!(
                "{base}/{}/_git/{}",
                encode_segment(project),
                encode_segment(name)
            ),
            web_url: str_of(w, "remoteUrl").map(str::to_string),
            wiki: true,
        });
    }
    out.sort_by(|a, b| {
        (a.project.to_lowercase(), a.wiki, a.name.to_lowercase()).cmp(&(
            b.project.to_lowercase(),
            b.wiki,
            b.name.to_lowercase(),
        ))
    });
    out
}

/// 集合裡所有專案的 Git 儲存庫與專案 Wiki。
#[tauri::command]
pub async fn ado_repos(app: AppHandle) -> Result<Vec<Repo>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let base = a.url;
        let repos = get(
            &base,
            &pat,
            "/_apis/git/repositories",
            &tr!("讀取儲存庫清單"),
        )?;
        // 讀不到 Wiki（例如沒有權限）時仍然列出儲存庫。
        let wikis = get(&base, &pat, "/_apis/wiki/wikis", &tr!("讀取 Wiki")).unwrap_or(Value::Null);
        let projects = if values(&wikis).is_empty() {
            Value::Null
        } else {
            get(&base, &pat, "/_apis/projects?$top=1000", &tr!("讀取專案")).unwrap_or(Value::Null)
        };
        Ok(repos_from(&base, &repos, &wikis, &projects))
    })
    .await
}

/// 下載儲存庫或 Wiki：選擇要放在哪個資料夾，下載到裡面的「名稱」資料夾，然後開啟它。
#[tauri::command]
pub async fn ado_clone(
    app: AppHandle,
    window: Window,
    clone_url: String,
    name: String,
) -> Result<Option<crate::git_clone::Cloned>, String> {
    let (a, _) = require(&app)?;
    // 只下載這台伺服器上的儲存庫，避免前端傳來任意網址時把權杖送到別的地方。
    if !starts_with_base(&clone_url, &a.url) {
        return Err(tr!("儲存庫網址不在目前連線的 Azure DevOps 上"));
    }
    let folder = name.trim().trim_end_matches(".wiki").to_string();
    let folder = if name.trim().ends_with(".wiki") {
        format!("{folder}-wiki")
    } else {
        folder
    };
    let Some(dest) = crate::git_clone::pick_clone_dest(&app, &window, &folder, &clone_url).await?
    else {
        return Ok(None);
    };
    let auth = crate::git::auth(&app);
    crate::git_clone::clone_and_open(&app, dest, clone_url, auth, "Azure DevOps")
        .await
        .map(Some)
}

/// `url` 和 `base` 是不是同一台伺服器（通訊協定、主機與連接埠都相同）。
pub fn same_server(url: &str, base: &str) -> bool {
    let origin = |u: &str| {
        let lower = u.to_ascii_lowercase();
        let start = lower.find("://").map_or(0, |i| i + 3);
        let end = lower[start..].find('/').map_or(lower.len(), |i| start + i);
        lower[..end].to_string()
    };
    origin(url) == origin(base)
}

/// `url` 是不是在 `base`（集合網址）底下；比對時不分大小寫，也不會把 `…/tfs2` 當成 `…/tfs` 底下。
pub fn starts_with_base(url: &str, base: &str) -> bool {
    let url = url.to_ascii_lowercase();
    let base = base.trim_end_matches('/').to_ascii_lowercase();
    url == base || url.starts_with(&format!("{base}/"))
}

// ---- Pull Request -------------------------------------------------------------

/// 儲存庫網址（…/專案/_git/儲存庫）裡的專案與儲存庫兩段（保持原本的編碼）。
pub(super) fn project_and_repo(remote: &str, base: &str) -> Option<(String, String)> {
    let clean = remote.trim().trim_end_matches('/');
    // 去掉網址裡的帳號（https://帳號@主機/…）。
    let clean = match clean.split_once("://") {
        Some((scheme, rest)) => {
            let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
            format!(
                "{scheme}://{}/{path}",
                host.rsplit('@').next().unwrap_or(host)
            )
        }
        None => clean.to_string(),
    };
    if !starts_with_base(&clean, base) {
        return None;
    }
    let rest = &clean[base.trim_end_matches('/').len()..];
    let (project, repo) = rest.trim_start_matches('/').split_once("/_git/")?;
    let repo = repo.split('/').next()?;
    (!project.is_empty() && !repo.is_empty()).then(|| (project.to_string(), repo.to_string()))
}

/// 建立 PR：從 `branch` 合併到儲存庫的預設分支，回傳 PR 的網頁網址。
pub fn create_pull(
    app: &AppHandle,
    remote: &str,
    branch: &str,
    title: &str,
    body: &str,
) -> Result<String, String> {
    let (a, pat) = require(app)?;
    let base = a.url;
    let (project, repo) = project_and_repo(remote, &base)
        .ok_or_else(|| tr!("這個儲存庫不在目前連線的 Azure DevOps 上"))?;
    let what = &tr!("建立 Pull Request");
    let info = get(
        &base,
        &pat,
        &format!("/{project}/_apis/git/repositories/{repo}"),
        what,
    )?;
    let id = str_of(&info, "id")
        .ok_or_else(|| tr!("讀取儲存庫失敗"))?
        .to_string();
    let target = str_of(&info, "defaultBranch")
        .unwrap_or("refs/heads/main")
        .to_string();
    if target == format!("refs/heads/{branch}") {
        return Err(tr!(
            "目前在預設分支「{branch}」上，請先建立新分支再建立 Pull Request",
            branch = branch
        ));
    }
    let web = str_of(&info, "webUrl")
        .map(str::to_string)
        .unwrap_or_else(|| format!("{base}/{project}/_git/{repo}"));
    let res = post(
        &base,
        &pat,
        &format!("/{project}/_apis/git/repositories/{id}/pullrequests"),
        &serde_json::json!({
            "sourceRefName": format!("refs/heads/{branch}"),
            "targetRefName": target,
            "title": title,
            "description": body,
        }),
        what,
    )
    .map_err(|e| {
        if e.contains("409") {
            tr!(
                "{what}失敗：這個分支已經有一個開著的 Pull Request",
                what = what
            )
        } else {
            e
        }
    })?;
    let number = res
        .get("pullRequestId")
        .and_then(Value::as_u64)
        .ok_or_else(|| tr!("建立 Pull Request 失敗：回應的格式不正確"))?;
    Ok(format!("{web}/pullrequest/{number}"))
}
