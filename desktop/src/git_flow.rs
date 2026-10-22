//! 分支與合併衝突：切換、建立分支；拉取遇到衝突時逐段處理，再完成或放棄合併。

use std::fs;
use std::path::Path;

use git2::build::CheckoutBuilder;
use git2::{BranchType, FileFavor, MergeFileInput, MergeFileOptions, Repository, RepositoryState};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::files::path_string;
use crate::git::{
    err, has_changes, open, require_clean_state, signature, tracking, workdir, Identity,
};
use crate::workspace::Workspace;

// ---- 分支 -------------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    current: Option<String>,
    local: Vec<String>,
    /// 只在遠端（origin）上、本機還沒有的分支。
    remote: Vec<String>,
}

pub fn branches_at(dir: &Path) -> Result<Branches, String> {
    let repo = open(dir)?;
    let current = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().ok().map(str::to_string));
    let names = |kind| -> Vec<String> {
        repo.branches(Some(kind))
            .map(|it| {
                it.filter_map(Result::ok)
                    .filter_map(|(b, _)| b.name().ok().flatten().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut local = names(BranchType::Local);
    local.sort();
    let mut remote: Vec<String> = names(BranchType::Remote)
        .into_iter()
        .filter_map(|n| n.strip_prefix("origin/").map(str::to_string))
        .filter(|n| n != "HEAD" && !local.contains(n))
        .collect();
    remote.sort();
    Ok(Branches {
        current,
        local,
        remote,
    })
}

fn require_clean(repo: &Repository) -> Result<(), String> {
    require_clean_state(repo)?;
    if has_changes(repo)? {
        return Err("還有未提交的變更，請先提交再切換分支".into());
    }
    Ok(())
}

/// 切換分支；只在遠端上的分支會先建立本機分支並追蹤它。
pub fn checkout_at(dir: &Path, name: &str) -> Result<String, String> {
    let repo = open(dir)?;
    require_clean(&repo)?;
    let branch = match repo.find_branch(name, BranchType::Local) {
        Ok(b) => b,
        Err(_) => {
            let remote = repo
                .find_branch(&format!("origin/{name}"), BranchType::Remote)
                .map_err(|_| format!("找不到分支「{name}」"))?;
            let commit = remote.get().peel_to_commit().map_err(err)?;
            let mut b = repo.branch(name, &commit, false).map_err(err)?;
            b.set_upstream(Some(&format!("origin/{name}")))
                .map_err(err)?;
            b
        }
    };
    let target = branch.get().peel_to_commit().map_err(err)?;
    repo.checkout_tree(target.as_object(), Some(CheckoutBuilder::new().safe()))
        .map_err(|e| format!("切換分支失敗：{}", e.message()))?;
    repo.set_head(&format!("refs/heads/{name}")).map_err(err)?;
    Ok(format!("已切換到「{name}」"))
}

/// 從目前的提交建立新分支並切換過去（檔案不會變動）。
pub fn create_branch_at(dir: &Path, name: &str) -> Result<String, String> {
    let name = name.trim();
    if !git2::Branch::name_is_valid(name).unwrap_or(false) || name.starts_with('-') {
        return Err("分支名稱不正確：不能有空白與 ~ ^ : ? * [ \\ 等符號".into());
    }
    let repo = open(dir)?;
    require_clean_state(&repo)?;
    if repo.find_branch(name, BranchType::Local).is_ok() {
        return Err(format!("已經有「{name}」這個分支"));
    }
    let head = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|_| "還沒有任何提交，請先提交一次".to_string())?;
    repo.branch(name, &head, false).map_err(err)?;
    repo.set_head(&format!("refs/heads/{name}")).map_err(err)?;
    Ok(format!("已建立並切換到「{name}」"))
}

// ---- 合併衝突 -----------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    path: String,
    /// 衝突的段落都採用遠端時的內容；磁碟上的檔案是都採用本機時的內容。
    /// 沒有值時表示不能逐段處理（例如一邊刪除了檔案，或不是文字檔），已經保留本機的版本。
    theirs: Option<String>,
    /// 不能逐段處理時的說明。
    note: Option<String>,
}

fn blob_text(repo: &Repository, entry: Option<&git2::IndexEntry>) -> Option<Vec<u8>> {
    let e = entry?;
    Some(repo.find_blob(e.id).ok()?.content().to_vec())
}

fn merge_text(
    base: &[u8],
    ours: &[u8],
    theirs: &[u8],
    favor: FileFavor,
) -> Result<Vec<u8>, String> {
    let input = |b| {
        let mut i = MergeFileInput::new();
        i.content(b);
        i
    };
    let mut opts = MergeFileOptions::new();
    opts.favor(favor);
    git2::merge_file(&input(base), &input(ours), &input(theirs), Some(&mut opts))
        .map(|r| r.content().to_vec())
        .map_err(err)
}

/// 開始合併遠端分支：沒有衝突的部分直接合併；有衝突的檔案先寫成「都採用本機」的內容，
/// 並回傳「都採用遠端」的內容，讓使用者逐段選擇。
pub fn merge_start_at(dir: &Path) -> Result<Vec<Conflict>, String> {
    let repo = open(dir)?;
    require_clean_state(&repo)?;
    if has_changes(&repo)? {
        return Err("還有未提交的變更，請先提交".into());
    }
    let (_, remote_name, merge) = tracking(&repo)?;
    let short = merge.trim_start_matches("refs/heads/");
    let theirs_id = repo
        .refname_to_id(&format!("refs/remotes/{remote_name}/{short}"))
        .map_err(|_| "找不到遠端的分支，請先拉取".to_string())?;
    let annotated = repo.find_annotated_commit(theirs_id).map_err(err)?;
    let mut checkout = CheckoutBuilder::new();
    checkout
        .safe()
        .allow_conflicts(true)
        .conflict_style_merge(true);
    repo.merge(&[&annotated], None, Some(&mut checkout))
        .map_err(|e| format!("合併失敗：{}", e.message()))?;

    let root = workdir(&repo)?;
    let index = repo.index().map_err(err)?;
    let conflicts: Vec<git2::IndexConflict> = index
        .conflicts()
        .map_err(err)?
        .filter_map(Result::ok)
        .collect();
    let mut out = Vec::new();
    for c in conflicts {
        let Some(entry) = c.our.as_ref().or(c.their.as_ref()).or(c.ancestor.as_ref()) else {
            continue;
        };
        let rel = String::from_utf8_lossy(&entry.path).into_owned();
        let abs = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        let base = blob_text(&repo, c.ancestor.as_ref()).unwrap_or_default();
        let ours = blob_text(&repo, c.our.as_ref());
        let theirs = blob_text(&repo, c.their.as_ref());
        let write = |bytes: &[u8]| {
            if let Some(dir) = abs.parent() {
                let _ = fs::create_dir_all(dir);
            }
            fs::write(&abs, bytes).map_err(|e| format!("無法寫入「{rel}」：{e}"))
        };
        let (theirs_text, note) = match (&ours, &theirs) {
            (Some(o), Some(t))
                if crate::files::not_text_reason(o).is_none()
                    && crate::files::not_text_reason(t).is_none() =>
            {
                write(&merge_text(&base, o, t, FileFavor::Ours)?)?;
                let t = merge_text(&base, o, t, FileFavor::Theirs)?;
                (Some(crate::files::decode(&t).0), None)
            }
            (Some(o), Some(_)) => {
                write(o)?;
                (None, Some("不是文字檔，保留本機的版本".to_string()))
            }
            (Some(o), None) => {
                write(o)?;
                (None, Some("遠端刪除了這個檔案，保留本機的版本".to_string()))
            }
            (None, Some(_)) => {
                let _ = fs::remove_file(&abs);
                (None, Some("本機刪除了這個檔案，維持刪除".to_string()))
            }
            (None, None) => continue,
        };
        out.push(Conflict {
            path: path_string(&abs),
            theirs: theirs_text,
            note,
        });
    }
    Ok(out)
}

/// 正在合併時，還有衝突的檔案（重新開啟程式後接著處理用）。
pub fn merge_conflicts_at(dir: &Path) -> Result<Vec<String>, String> {
    let repo = open(dir)?;
    if repo.state() != RepositoryState::Merge {
        return Ok(vec![]);
    }
    let root = workdir(&repo)?;
    let index = repo.index().map_err(err)?;
    let list = index
        .conflicts()
        .map_err(err)?
        .filter_map(Result::ok)
        .filter_map(|c| {
            let e = c.our.or(c.their).or(c.ancestor)?;
            let rel = String::from_utf8_lossy(&e.path).replace('/', std::path::MAIN_SEPARATOR_STR);
            Some(path_string(&root.join(rel)))
        })
        .collect();
    Ok(list)
}

/// 完成合併：衝突的檔案用磁碟上目前的內容，建立合併提交。
pub fn merge_finish_at(dir: &Path, who: Option<&Identity>) -> Result<String, String> {
    let mut repo = open(dir)?;
    if repo.state() != RepositoryState::Merge {
        return Err("目前沒有正在進行的合併".into());
    }
    let mut heads = Vec::new();
    repo.mergehead_foreach(|oid| {
        heads.push(*oid);
        true
    })
    .map_err(err)?;
    let root = workdir(&repo)?;
    let mut index = repo.index().map_err(err)?;
    let paths: Vec<String> = index
        .conflicts()
        .map_err(err)?
        .filter_map(Result::ok)
        .filter_map(|c| {
            let e = c.our.or(c.their).or(c.ancestor)?;
            Some(String::from_utf8_lossy(&e.path).into_owned())
        })
        .collect();
    for rel in &paths {
        let abs = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if abs.exists() {
            if fs::read(&abs).is_ok_and(|b| has_markers(&b)) {
                return Err(format!(
                    "「{rel}」裡還有 <<<<<<< 衝突標記，請先處理完再完成合併"
                ));
            }
            index.add_path(Path::new(rel)).map_err(err)?;
        } else {
            index.remove_path(Path::new(rel)).map_err(err)?;
        }
    }
    index.write().map_err(err)?;
    let tree = repo
        .find_tree(index.write_tree().map_err(err)?)
        .map_err(err)?;
    let ours = repo.head().and_then(|h| h.peel_to_commit()).map_err(err)?;
    let theirs = repo
        .find_commit(*heads.first().ok_or("找不到要合併的提交")?)
        .map_err(err)?;
    let sig = signature(&repo, who)?;
    let message = match tracking(&repo) {
        Ok((_, remote, merge)) => format!(
            "合併 {remote}/{} 的變更",
            merge.trim_start_matches("refs/heads/")
        ),
        Err(_) => "合併遠端的變更".into(),
    };
    repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &[&ours, &theirs])
        .map_err(|e| format!("完成合併失敗：{}", e.message()))?;
    repo.cleanup_state().map_err(err)?;
    Ok("已完成合併，記得推送".into())
}

fn has_markers(bytes: &[u8]) -> bool {
    String::from_utf8_lossy(bytes)
        .lines()
        .any(|l| l.starts_with("<<<<<<< ") || l.starts_with(">>>>>>> "))
}

/// 放棄合併：回到合併前的狀態（處理到一半的內容會被丟掉）。
pub fn merge_abort_at(dir: &Path) -> Result<String, String> {
    let repo = open(dir)?;
    if repo.state() != RepositoryState::Merge {
        return Ok("目前沒有正在進行的合併".into());
    }
    let head = repo.head().and_then(|h| h.peel_to_commit()).map_err(err)?;
    repo.reset(head.as_object(), git2::ResetType::Hard, None)
        .map_err(|e| format!("放棄合併失敗：{}", e.message()))?;
    repo.cleanup_state().map_err(err)?;
    Ok("已放棄合併，回到合併前的狀態".into())
}

// ---- Pull Request -------------------------------------------------------------

/// 建立 PR：需要時先建立新分支，推送後在 GitHub 或 Azure DevOps 建立 PR，回傳網址。
fn create_pr(
    app: &AppHandle,
    dir: &Path,
    title: &str,
    body: &str,
    new_branch: Option<&str>,
) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("請輸入 Pull Request 的標題".into());
    }
    if let Some(name) = new_branch.filter(|n| !n.trim().is_empty()) {
        create_branch_at(dir, name)?;
    }
    let repo = open(dir)?;
    if has_changes(&repo)? {
        return Err("還有未提交的變更，請先提交".into());
    }
    let branch = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().ok().map(str::to_string))
        .ok_or("目前不在任何分支上")?;
    let remote = repo
        .find_remote("origin")
        .ok()
        .and_then(|r| r.url().ok().map(str::to_string))
        .ok_or("這個資料夾還沒有連到 GitHub 或 Azure DevOps")?;
    drop(repo);
    crate::git::push_at(dir, &crate::git::auth(app))?;
    if let Some((owner, name)) = crate::git_files::github_repo(&remote) {
        let token = crate::github::auth(app)
            .github_token
            .ok_or("請先用 GitHub 登入")?;
        return crate::github::create_pull(&token, &owner, &name, &branch, title, body);
    }
    crate::ado::create_pull(app, &remote, &branch, title, body)
}

// ---- 前端呼叫 ----------------------------------------------------------------

fn root(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.state::<Workspace>()
        .root()
        .ok_or_else(|| "還沒有開啟資料夾".to_string())
}

#[tauri::command]
pub async fn git_branches(app: AppHandle) -> Result<Branches, String> {
    let dir = root(&app)?;
    crate::io::blocking(move || branches_at(&dir)).await
}

#[tauri::command]
pub async fn git_checkout(app: AppHandle, name: String) -> Result<String, String> {
    let dir = root(&app)?;
    crate::io::blocking(move || checkout_at(&dir, &name)).await
}

#[tauri::command]
pub async fn git_create_branch(app: AppHandle, name: String) -> Result<String, String> {
    let dir = root(&app)?;
    crate::io::blocking(move || create_branch_at(&dir, &name)).await
}

#[tauri::command]
pub async fn git_merge_start(app: AppHandle) -> Result<Vec<Conflict>, String> {
    let dir = root(&app)?;
    crate::io::blocking(move || merge_start_at(&dir)).await
}

#[tauri::command]
pub async fn git_merge_conflicts(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = root(&app)?;
    crate::io::blocking(move || merge_conflicts_at(&dir)).await
}

#[tauri::command]
pub async fn git_merge_finish(app: AppHandle) -> Result<String, String> {
    let dir = root(&app)?;
    let who = crate::git::identity_for(&app, &dir);
    crate::io::blocking(move || merge_finish_at(&dir, who.as_ref())).await
}

#[tauri::command]
pub async fn git_create_pr(
    app: AppHandle,
    title: String,
    body: String,
    new_branch: Option<String>,
) -> Result<String, String> {
    let dir = root(&app)?;
    crate::io::blocking_for(crate::git::NETWORK_TIMEOUT, move || {
        create_pr(&app, &dir, &title, &body, new_branch.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn git_merge_abort(app: AppHandle) -> Result<String, String> {
    let dir = root(&app)?;
    crate::io::blocking(move || merge_abort_at(&dir)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me() -> Identity {
        Identity {
            name: "測試".into(),
            email: "t@example.com".into(),
        }
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("md-flow-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(&dir).unwrap()
    }

    fn init(dir: &Path) -> Repository {
        let mut opts = git2::RepositoryInitOptions::new();
        opts.initial_head("main");
        Repository::init_opts(dir, &opts).unwrap()
    }

    fn commit_all(dir: &Path, msg: &str) {
        crate::git::commit_at(dir, msg, Some(&me())).unwrap();
    }

    /// 建立 origin 與本機兩份副本，兩邊改到同一行，再讓本機抓到 origin 的提交。
    fn conflicted(name: &str) -> std::path::PathBuf {
        let origin = temp(&format!("{name}-origin"));
        let repo = init(&origin);
        fs::write(origin.join("a.md"), "一\n二\n三\n").unwrap();
        commit_all(&origin, "初始");
        let local = temp(&format!("{name}-local"));
        let _ = fs::remove_dir_all(&local);
        Repository::clone(origin.to_str().unwrap(), &local).unwrap();
        fs::write(origin.join("a.md"), "一\n遠端\n三\n").unwrap();
        commit_all(&origin, "遠端修改");
        fs::write(local.join("a.md"), "一\n本機\n三\n").unwrap();
        commit_all(&local, "本機修改");
        let l = Repository::open(&local).unwrap();
        l.find_remote("origin")
            .unwrap()
            .fetch::<&str>(&[], None, None)
            .unwrap();
        drop(repo);
        local
    }

    #[test]
    fn resolves_conflicts_chunk_by_chunk() {
        let local = conflicted("resolve");
        let list = merge_start_at(&local).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(
            fs::read_to_string(local.join("a.md")).unwrap(),
            "一\n本機\n三\n"
        );
        assert_eq!(list[0].theirs.as_deref(), Some("一\n遠端\n三\n"));
        assert!(crate::git::status_at(&local).merging);
        assert_eq!(merge_conflicts_at(&local).unwrap().len(), 1);
        // 使用者選了遠端的版本後完成合併。
        fs::write(local.join("a.md"), "一\n遠端\n三\n").unwrap();
        merge_finish_at(&local, Some(&me())).unwrap();
        let repo = Repository::open(&local).unwrap();
        assert_eq!(repo.state(), RepositoryState::Clean);
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 2);
        assert!(!has_changes(&repo).unwrap());
    }

    #[test]
    fn refuses_to_finish_with_markers_and_can_abort() {
        let local = conflicted("abort");
        merge_start_at(&local).unwrap();
        fs::write(
            local.join("a.md"),
            "<<<<<<< ours\n本機\n=======\n遠端\n>>>>>>> theirs\n",
        )
        .unwrap();
        assert!(merge_finish_at(&local, Some(&me())).is_err());
        merge_abort_at(&local).unwrap();
        assert_eq!(
            fs::read_to_string(local.join("a.md")).unwrap(),
            "一\n本機\n三\n"
        );
        assert!(!crate::git::status_at(&local).merging);
    }

    #[test]
    fn creates_and_switches_branches() {
        let dir = temp("branches");
        init(&dir);
        fs::write(dir.join("a.md"), "一\n").unwrap();
        commit_all(&dir, "初始");
        assert!(create_branch_at(&dir, "bad name").is_err());
        create_branch_at(&dir, "草稿").unwrap();
        fs::write(dir.join("a.md"), "草稿內容\n").unwrap();
        commit_all(&dir, "草稿");
        let b = branches_at(&dir).unwrap();
        assert_eq!(b.current.as_deref(), Some("草稿"));
        assert_eq!(b.local, ["main", "草稿"]);
        checkout_at(&dir, "main").unwrap();
        assert_eq!(fs::read_to_string(dir.join("a.md")).unwrap(), "一\n");
        fs::write(dir.join("a.md"), "沒存的修改\n").unwrap();
        assert!(checkout_at(&dir, "草稿").is_err());
    }
}
