//! Git 儲存庫：列出、下載（clone）、把本機資料夾上傳成儲存庫，以及建立 Pull Request。

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
    /// 還沒有任何分支的空儲存庫（可以把本機資料夾上傳到這裡）。
    pub(super) empty: bool,
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
                empty: is_empty_repo(r),
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
            empty: false,
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

// ---- 上傳本機資料夾 -------------------------------------------------------------

/// 空的儲存庫：還沒有任何分支，伺服器不會給預設分支。
pub(super) fn is_empty_repo(repo: &Value) -> bool {
    str_of(repo, "defaultBranch").is_none()
}

/// 建立儲存庫的內容：名稱與所屬的專案（地端的 TFS 要在內容裡寫專案的 id）。
pub(super) fn create_repo_body(name: &str, project_id: &str) -> Value {
    serde_json::json!({ "name": name, "project": { "id": project_id } })
}

/// 推送用的網址：伺服器回傳的網址可能帶著帳號（`https://組織@dev.azure.com/…`），拿掉。
pub(super) fn push_url(remote: &str) -> String {
    crate::git_files::display_remote(remote.trim())
}

/// 上傳前要問的話：資料夾原本有別的遠端 origin 時才問（原本就是同一個儲存庫不算換掉）。
pub(super) fn publish_question(
    project: &str,
    name: &str,
    folder: &str,
    origin: Option<&str>,
    target: &str,
) -> Option<Question> {
    let origin = origin.map(push_url)?;
    let same = |a: &str, b: &str| {
        a.trim_end_matches('/')
            .eq_ignore_ascii_case(b.trim_end_matches('/'))
    };
    if same(&origin, &push_url(target)) {
        return None;
    }
    Some(Question::new(
        tr!("上傳到 Azure DevOps"),
        tr!(
            "「{folder}」資料夾原本的遠端 origin 是「{origin}」。要改成 Azure DevOps 專案「{project}」的儲存庫「{name}」，並上傳所有的檔案和版本紀錄嗎？",
            folder = folder,
            origin = origin,
            project = project,
            name = name
        ),
    ))
}

/// 要上傳到哪裡：推送的網址、網頁網址，以及要不要先建立（要建立時是專案的 id）。
struct PublishTarget {
    remote: String,
    web: String,
    create_in: Option<String>,
}

/// 把目前開啟的本機資料夾上傳到 Azure DevOps：在 `project` 建立新的儲存庫 `name`，
/// 或（`existing`）上傳到已經存在的空儲存庫。設定成資料夾的遠端 origin、提交還沒提交的修改後推送，
/// 回傳儲存庫的網頁網址。會換掉資料夾原本的遠端 origin 時先用系統的對話框確認；
/// 使用者選「否」時什麼都不做（也不會建立儲存庫），回傳 `None`。
#[tauri::command]
pub async fn ado_publish(
    app: AppHandle,
    window: Window,
    workspace: tauri::State<'_, crate::workspace::Workspace>,
    project: String,
    name: String,
    existing: bool,
) -> Result<Option<String>, String> {
    let (a, pat) = require(&app)?;
    let dir = workspace.root().ok_or_else(|| tr!("還沒有開啟資料夾"))?;
    let project = project.trim().to_string();
    let name = name.trim().to_string();
    if project.is_empty() {
        return Err(tr!("請選擇 Azure DevOps 專案"));
    }
    if name.is_empty() {
        return Err(tr!("請輸入儲存庫名稱"));
    }
    let base = a.url.trim_end_matches('/').to_string();
    let (b, token, p, n) = (base.clone(), pat.clone(), project.clone(), name.clone());
    let target = crate::io::blocking_for(TIMEOUT, move || {
        let (pp, rr) = (encode_segment(&p), encode_segment(&n));
        if existing {
            let what = tr!("讀取儲存庫");
            let info = get(
                &b,
                &token,
                &format!("/{pp}/_apis/git/repositories/{rr}"),
                &what,
            )?;
            if !is_empty_repo(&info) {
                return Err(tr!(
                    "「{name}」已經有內容，請選空的儲存庫，或建立新的儲存庫",
                    name = n
                ));
            }
            let remote = str_of(&info, "remoteUrl")
                .map(push_url)
                .unwrap_or_else(|| format!("{b}/{pp}/_git/{rr}"));
            let web = str_of(&info, "webUrl")
                .map(str::to_string)
                .unwrap_or_else(|| format!("{b}/{pp}/_git/{rr}"));
            Ok(PublishTarget {
                remote,
                web,
                create_in: None,
            })
        } else {
            let info = get(
                &b,
                &token,
                &format!("/_apis/projects/{pp}"),
                &tr!("讀取專案"),
            )?;
            let id = str_of(&info, "id")
                .ok_or_else(|| tr!("讀取專案失敗"))?
                .to_string();
            let url = format!("{b}/{pp}/_git/{rr}");
            Ok(PublishTarget {
                remote: url.clone(),
                web: url,
                create_in: Some(id),
            })
        }
    })
    .await?;
    let d = dir.clone();
    let origin = crate::io::blocking(move || Ok(crate::git::origin_at(&d))).await?;
    let question = publish_question(
        &project,
        &name,
        &crate::files::display_name(&dir),
        origin.as_deref(),
        &target.remote,
    );
    if !crate::confirm::confirm(&window, question).await {
        return Ok(None);
    }
    let auth = crate::git::auth(&app);
    let who = identity(&app);
    crate::io::blocking_for(crate::git::NETWORK_TIMEOUT, move || {
        let PublishTarget {
            mut remote,
            mut web,
            create_in,
        } = target;
        if let Some(project_id) = create_in {
            let what = tr!("建立儲存庫");
            let created = post(
                &base,
                &pat,
                &format!("/{}/_apis/git/repositories", encode_segment(&project)),
                &create_repo_body(&name, &project_id),
                &what,
            )
            .map_err(|e| {
                if e.contains("409") {
                    tr!(
                        "{what}失敗：專案「{project}」已經有叫「{name}」的儲存庫，請換一個名稱，或選「用已經存在的空儲存庫」",
                        what = what,
                        project = project,
                        name = name
                    )
                } else if e == tr!("{what}失敗：沒有權限", what = what) {
                    // 建立儲存庫要專案的「建立儲存庫」權限，權杖也要 Code 的 Read, write, & manage。
                    tr!(
                        "{what}失敗：沒有權限。建立儲存庫需要專案的「建立儲存庫」權限，個人存取權杖也要勾選 Code 的 Read, write, & manage；也可以請管理員先建立空的儲存庫，再選「用已經存在的空儲存庫」",
                        what = what
                    )
                } else {
                    e
                }
            })?;
            if let Some(url) = str_of(&created, "remoteUrl") {
                remote = push_url(url);
            }
            if let Some(url) = str_of(&created, "webUrl") {
                web = url.to_string();
            }
        }
        // 只推到這台伺服器上的儲存庫：權杖不會送到別的地方。
        if !starts_with_base(&remote, &base) {
            return Err(tr!("儲存庫網址不在目前連線的 Azure DevOps 上"));
        }
        crate::git::publish_at(&dir, &remote, &auth, who.as_ref())?;
        Ok(Some(web))
    })
    .await
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
