//! Git 整合：內建 libgit2（git2），不需要另外安裝 Git。
//!
//! 安全原則：
//! - 所有操作都在目前開啟的資料夾（工作區）所在的儲存庫進行。
//! - libgit2 不會執行儲存庫設定指定的外部程式（hooks、fsmonitor、filter 等），
//!   打開別人給的資料夾也不會被執行程式，所以不需要先「信任」資料夾。
//! - 拉取時有未提交的變更就不做；能快轉就快轉，否則在記憶體裡合併，有衝突就放棄，
//!   磁碟上的檔案完全不會被動到。
//! - 遠端認證：github.com 用「登入 GitHub」取得的權杖；其他 HTTPS 遠端用使用者
//!   全域 Git 設定裡的認證小幫手（credential helper）。不支援 SSH 遠端。

use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf, MAIN_SEPARATOR_STR};
use std::time::Duration;

use git2::build::CheckoutBuilder;
use git2::{
    BranchType, Cred, CredentialType, ErrorClass, ErrorCode, FetchOptions, IndexAddOption, Oid,
    ProxyOptions, PushOptions, RemoteCallbacks, Repository, RepositoryState, Signature,
    StatusOptions,
};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::files::path_string;
use crate::workspace::Workspace;

/// 拉取、推送、下載可能要等很久（大型儲存庫、慢速網路）。
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Change {
    path: String,
    status: FileStatus,
}

#[derive(Serialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    name: String,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// 內建 Git，一律可以使用（保留欄位給前端判斷）。
    available: bool,
    /// 工作區是不是 Git 儲存庫。
    repo: bool,
    /// 不再需要信任資料夾（libgit2 不執行外部程式）；保留欄位給前端判斷。
    trusted: bool,
    branch: Option<Branch>,
    changes: Vec<Change>,
    /// 遠端（origin）的網址，例如 https://github.com/使用者/儲存庫.git。
    remote: Option<String>,
}

/// 提交時的名字與 Email（沒有設定 Git 時用 GitHub 帳號）。
#[derive(Clone, Debug)]
pub struct Identity {
    pub name: String,
    pub email: String,
}

/// 連線到遠端時用的認證。
#[derive(Clone, Default)]
pub struct Auth {
    /// 登入 GitHub 取得的權杖（只用在 github.com）。
    pub github_token: Option<String>,
}

fn classify(s: git2::Status) -> Option<FileStatus> {
    use git2::Status as S;
    if s.is_ignored() || s == S::CURRENT {
        None
    } else if s.is_conflicted() {
        Some(FileStatus::Conflicted)
    } else if s.intersects(S::INDEX_DELETED | S::WT_DELETED) {
        Some(FileStatus::Deleted)
    } else if s.intersects(S::INDEX_RENAMED | S::WT_RENAMED) {
        Some(FileStatus::Renamed)
    } else if s.contains(S::INDEX_NEW) {
        Some(FileStatus::Added)
    } else if s.contains(S::WT_NEW) {
        Some(FileStatus::Untracked)
    } else {
        Some(FileStatus::Modified)
    }
}

fn open(dir: &Path) -> Result<Repository, String> {
    Repository::discover(dir).map_err(|_| "這個資料夾不是 Git 儲存庫".to_string())
}

fn workdir(repo: &Repository) -> Result<PathBuf, String> {
    let dir = repo
        .workdir()
        .ok_or_else(|| "這個儲存庫沒有工作目錄（bare）".to_string())?;
    Ok(dunce::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf()))
}

fn err(e: git2::Error) -> String {
    e.message().to_string()
}

/// 儲存庫中的變更，路徑轉成絕對路徑（Windows 用反斜線）。
fn changes_of(repo: &Repository, root: &Path) -> Result<Vec<Change>, git2::Error> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repo.statuses(Some(&mut opts))?;
    let abs = |rel: &str| path_string(&root.join(rel.replace('/', MAIN_SEPARATOR_STR)));
    Ok(statuses
        .iter()
        .filter_map(|e| {
            let status = classify(e.status())?;
            // 改名時用新的路徑。
            let rel = e
                .index_to_workdir()
                .and_then(|d| d.new_file().path().map(Path::to_path_buf))
                .or_else(|| {
                    e.head_to_index()
                        .and_then(|d| d.new_file().path().map(Path::to_path_buf))
                })
                .or_else(|| e.path().ok().map(PathBuf::from))?;
            Some(Change {
                path: abs(&rel.to_string_lossy()),
                status,
            })
        })
        .collect())
}

fn has_changes(repo: &Repository) -> Result<bool, String> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).include_ignored(false);
    Ok(!repo.statuses(Some(&mut opts)).map_err(err)?.is_empty())
}

/// 目前分支、追蹤的遠端分支，以及領先／落後幾個提交。
fn branch_of(repo: &Repository) -> Branch {
    let mut b = Branch::default();
    match repo.head() {
        Ok(head) => {
            b.name = head.shorthand().unwrap_or("HEAD").to_string();
            if let (true, Some(local), Some(name)) =
                (head.is_branch(), head.target(), head.name().ok())
            {
                if let Some((up, oid)) = upstream_of(repo, name) {
                    let (ahead, behind) = repo.graph_ahead_behind(local, oid).unwrap_or((0, 0));
                    b.upstream = Some(up);
                    b.ahead = ahead as u32;
                    b.behind = behind as u32;
                }
            }
        }
        // 還沒有任何提交：顯示 HEAD 指向的分支名稱。
        Err(_) => {
            b.name = repo
                .find_reference("HEAD")
                .ok()
                .and_then(|r| r.symbolic_target().ok().flatten().map(str::to_string))
                .map(|t| t.trim_start_matches("refs/heads/").to_string())
                .unwrap_or_else(|| "main".into());
        }
    }
    b
}

/// 分支追蹤的遠端分支（例如 `origin/main`）與它目前的提交。
fn upstream_of(repo: &Repository, refname: &str) -> Option<(String, Oid)> {
    let up = repo.branch_upstream_name(refname).ok()?;
    let up = up.as_str().ok()?;
    let oid = repo.refname_to_id(up).ok()?;
    Some((up.trim_start_matches("refs/remotes/").to_string(), oid))
}

fn origin_url(repo: &Repository) -> Option<String> {
    repo.find_remote("origin")
        .ok()?
        .url()
        .ok()
        .map(str::to_string)
}

pub fn status_at(dir: &Path) -> Status {
    let empty = |repo| Status {
        available: true,
        repo,
        trusted: true,
        branch: None,
        changes: vec![],
        remote: None,
    };
    let Ok(repo) = open(dir) else {
        return empty(false);
    };
    let Ok(root) = workdir(&repo) else {
        return empty(false);
    };
    match changes_of(&repo, &root) {
        Ok(changes) => Status {
            available: true,
            repo: true,
            trusted: true,
            branch: Some(branch_of(&repo)),
            changes,
            remote: origin_url(&repo),
        },
        Err(_) => empty(true),
    }
}

fn require_clean_state(repo: &Repository) -> Result<(), String> {
    if repo.state() == RepositoryState::Clean {
        Ok(())
    } else {
        Err("這個儲存庫正在進行合併或 rebase，請先用其他 Git 工具完成或取消".into())
    }
}

fn signature(repo: &Repository, who: Option<&Identity>) -> Result<Signature<'static>, String> {
    if let Ok(sig) = repo.signature() {
        return Ok(sig.to_owned());
    }
    match who {
        Some(id) => Signature::now(&id.name, &id.email).map_err(err),
        None => Err("提交需要你的名字與 Email：請先到設定的 Git 頁「用 GitHub 登入」".into()),
    }
}

/// 提交工作區資料夾內的所有變更（工作區是儲存庫的子資料夾時，只提交那個子資料夾）。
pub fn commit_at(dir: &Path, message: &str, who: Option<&Identity>) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("請輸入提交說明".into());
    }
    let repo = open(dir)?;
    require_clean_state(&repo)?;
    let root = workdir(&repo)?;
    let dir = dunce::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let scope = match dir.strip_prefix(&root) {
        Ok(rel) if !rel.as_os_str().is_empty() => rel.to_string_lossy().replace('\\', "/"),
        _ => "*".to_string(),
    };
    let mut index = repo.index().map_err(err)?;
    index
        .add_all([scope.as_str()], IndexAddOption::DEFAULT, None)
        .map_err(err)?;
    // add_all 不會記錄刪除的檔案。
    index.update_all([scope.as_str()], None).map_err(err)?;
    index.write().map_err(err)?;
    let tree_id = index.write_tree().map_err(err)?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let unchanged = match &parent {
        Some(p) => p.tree_id() == tree_id,
        None => index.is_empty(),
    };
    if unchanged {
        return Err("沒有需要提交的變更".into());
    }
    let sig = signature(&repo, who)?;
    let tree = repo.find_tree(tree_id).map_err(err)?;
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(|e| format!("提交失敗：{}", e.message()))?;
    let first = message.lines().next().unwrap_or_default();
    Ok(format!("{} {first}", &oid.to_string()[..7]))
}

// ---- 遠端 -------------------------------------------------------------------

fn is_github(url: &str) -> bool {
    url.to_ascii_lowercase().starts_with("https://github.com/")
}

fn require_https(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") || Path::new(url).exists() {
        Ok(())
    } else {
        Err(format!(
            "目前只支援 HTTPS 的遠端網址（例如 https://github.com/…）。這個儲存庫的遠端是：{url}"
        ))
    }
}

/// 連線到遠端時的認證與 Proxy。`refused` 記錄是不是因為沒有可用的帳號而失敗。
struct Session<'a> {
    auth: &'a Auth,
    tries: Cell<u32>,
    refused: Cell<bool>,
}

impl<'a> Session<'a> {
    fn new(auth: &'a Auth) -> Self {
        Self {
            auth,
            tries: Cell::new(0),
            refused: Cell::new(false),
        }
    }

    fn callbacks(&self) -> RemoteCallbacks<'_> {
        let mut cb = RemoteCallbacks::new();
        cb.credentials(move |url, username, allowed| {
            // 帳號密碼錯誤時 libgit2 會一直重問，只試一次。
            self.tries.set(self.tries.get() + 1);
            if self.tries.get() > 1 || !allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
                self.refused.set(true);
                return Err(git2::Error::from_str("需要登入"));
            }
            if is_github(url) {
                if let Some(token) = &self.auth.github_token {
                    return Cred::userpass_plaintext("x-access-token", token);
                }
            } else if let Ok(cfg) = git2::Config::open_default() {
                // 只讀使用者自己的全域設定，不讀儲存庫裡的（避免執行來路不明的程式）。
                if let Ok(cred) = Cred::credential_helper(&cfg, url, username) {
                    return Ok(cred);
                }
            }
            self.refused.set(true);
            Err(git2::Error::from_str("需要登入"))
        });
        cb
    }

    fn fetch_options(&self) -> FetchOptions<'_> {
        let mut fo = FetchOptions::new();
        fo.remote_callbacks(self.callbacks());
        fo.proxy_options(proxy());
        fo
    }

    /// 連線失敗時給使用者看的說明。
    fn describe(&self, e: &git2::Error, url: &str, what: &str) -> String {
        if self.refused.get() || e.code() == ErrorCode::Auth {
            if is_github(url) && self.auth.github_token.is_none() {
                format!("{what}失敗：需要登入 GitHub。請到設定的 Git 頁按「用 GitHub 登入」。")
            } else if is_github(url) {
                format!("{what}失敗：GitHub 拒絕存取。可能沒有這個儲存庫的權限，或登入已過期，請重新登入 GitHub。")
            } else {
                format!("{what}失敗：需要登入遠端儲存庫（{url}）。")
            }
        } else if matches!(
            e.class(),
            ErrorClass::Net | ErrorClass::Http | ErrorClass::Ssl
        ) {
            format!("{what}失敗：無法連線到遠端儲存庫（{}）", e.message())
        } else {
            format!("{what}失敗：{}", e.message())
        }
    }
}

fn proxy() -> ProxyOptions<'static> {
    let mut p = ProxyOptions::new();
    p.auto();
    p
}

/// 分支名稱、遠端名稱，以及遠端那邊的分支（`refs/heads/…`）。
fn tracking(repo: &Repository) -> Result<(String, String, String), String> {
    let head = repo.head().ok();
    let branch = match &head {
        Some(h) if h.is_branch() => h.shorthand().unwrap_or("main").to_string(),
        Some(_) => return Err("目前不在任何分支上（detached HEAD），請先切換到分支".into()),
        None => branch_of(repo).name,
    };
    let cfg = repo.config().map_err(err)?;
    let remote = cfg
        .get_string(&format!("branch.{branch}.remote"))
        .ok()
        .or_else(|| {
            repo.find_remote("origin")
                .ok()
                .map(|_| "origin".to_string())
        })
        .ok_or_else(|| "這個資料夾還沒有連到 GitHub 或其他遠端儲存庫".to_string())?;
    let merge = cfg
        .get_string(&format!("branch.{branch}.merge"))
        .unwrap_or_else(|_| format!("refs/heads/{branch}"));
    Ok((branch, remote, merge))
}

fn remote_url(repo: &Repository, name: &str) -> Result<String, String> {
    let url = repo
        .find_remote(name)
        .map_err(err)?
        .url()
        .unwrap_or_default()
        .to_string();
    require_https(&url)?;
    Ok(url)
}

fn count_between(repo: &Repository, from: Option<Oid>, to: Oid) -> usize {
    let Ok(mut walk) = repo.revwalk() else {
        return 0;
    };
    if walk.push(to).is_err() {
        return 0;
    }
    if let Some(f) = from {
        let _ = walk.hide(f);
    }
    walk.count()
}

/// 拉取遠端的新提交。有未提交的變更時不做；遇到衝突時放棄，不動任何檔案。
pub fn pull_at(dir: &Path, auth: &Auth, who: Option<&Identity>) -> Result<String, String> {
    let repo = open(dir)?;
    require_clean_state(&repo)?;
    if has_changes(&repo)? {
        return Err("還有未提交的變更，請先提交再拉取".into());
    }
    let (branch, remote_name, merge) = tracking(&repo)?;
    let url = remote_url(&repo, &remote_name)?;
    let session = Session::new(auth);
    repo.find_remote(&remote_name)
        .map_err(err)?
        .fetch::<&str>(&[], Some(&mut session.fetch_options()), None)
        .map_err(|e| session.describe(&e, &url, "拉取"))?;

    let short = merge.trim_start_matches("refs/heads/");
    let Ok(theirs_id) = repo.refname_to_id(&format!("refs/remotes/{remote_name}/{short}")) else {
        return Ok("遠端還沒有這個分支，不需要拉取".into());
    };
    let theirs = repo.find_annotated_commit(theirs_id).map_err(err)?;
    let (analysis, _) = repo.merge_analysis(&[&theirs]).map_err(err)?;
    if analysis.is_up_to_date() {
        return Ok("已經是最新的".into());
    }
    let local_ref = format!("refs/heads/{branch}");
    let before = repo.head().ok().and_then(|h| h.target());
    let count = count_between(&repo, before, theirs_id);

    if analysis.is_fast_forward() || analysis.is_unborn() {
        let target = repo.find_commit(theirs_id).map_err(err)?;
        repo.checkout_tree(target.as_object(), Some(CheckoutBuilder::new().safe()))
            .map_err(|e| format!("拉取失敗：{}", e.message()))?;
        match repo.find_reference(&local_ref) {
            Ok(mut r) => {
                r.set_target(theirs_id, "pull: fast-forward").map_err(err)?;
            }
            Err(_) => {
                repo.reference(&local_ref, theirs_id, true, "pull: fast-forward")
                    .map_err(err)?;
            }
        }
        repo.set_head(&local_ref).map_err(err)?;
        return Ok(format!("已拉取 {count} 個新的提交"));
    }

    // 兩邊都有新提交：先在記憶體裡合併，沒有衝突才寫到磁碟。
    let ours = repo
        .find_commit(before.ok_or("找不到目前的提交")?)
        .map_err(err)?;
    let theirs_commit = repo.find_commit(theirs_id).map_err(err)?;
    let mut merged = repo
        .merge_commits(&ours, &theirs_commit, None)
        .map_err(err)?;
    if merged.has_conflicts() {
        return Err("遠端和本機改到了同樣的地方，發生衝突。已經取消拉取，檔案都維持原樣；請用其他 Git 工具處理衝突。".into());
    }
    let tree_id = merged.write_tree_to(&repo).map_err(err)?;
    let tree = repo.find_tree(tree_id).map_err(err)?;
    let sig = signature(&repo, who)?;
    let oid = repo
        .commit(
            None,
            &sig,
            &sig,
            &format!("合併 {remote_name}/{short} 的變更"),
            &tree,
            &[&ours, &theirs_commit],
        )
        .map_err(err)?;
    repo.checkout_tree(tree.as_object(), Some(CheckoutBuilder::new().safe()))
        .map_err(|e| format!("拉取失敗：{}", e.message()))?;
    repo.find_reference(&local_ref)
        .map_err(err)?
        .set_target(oid, "pull: merge")
        .map_err(err)?;
    Ok(format!("已拉取 {count} 個新的提交，並和本機的提交合併"))
}

/// 推送目前的分支。第一次推送時會記住對應的遠端分支。
pub fn push_at(dir: &Path, auth: &Auth) -> Result<String, String> {
    let repo = open(dir)?;
    let (branch, remote_name, merge) = tracking(&repo)?;
    let url = remote_url(&repo, &remote_name)?;
    let local = format!("refs/heads/{branch}");
    if repo.refname_to_id(&local).is_err() {
        return Err("還沒有任何提交，請先提交再推送".into());
    }
    let session = Session::new(auth);
    let rejected = RefCell::new(None::<String>);
    let mut cb = session.callbacks();
    cb.push_update_reference(|_, status| {
        if let Some(msg) = status {
            *rejected.borrow_mut() = Some(msg.to_string());
        }
        Ok(())
    });
    let mut po = PushOptions::new();
    po.remote_callbacks(cb);
    po.proxy_options(proxy());
    let behind = "遠端有你還沒拉取的提交，請先拉取再推送".to_string();
    repo.find_remote(&remote_name)
        .map_err(err)?
        .push(&[format!("{local}:{merge}")], Some(&mut po))
        .map_err(|e| {
            if e.code() == ErrorCode::NotFastForward {
                behind.clone()
            } else {
                session.describe(&e, &url, "推送")
            }
        })?;
    drop(po);
    if let Some(msg) = rejected.into_inner() {
        return Err(
            if msg.contains("fast-forward") || msg.contains("fetch first") {
                behind
            } else {
                format!("推送被遠端拒絕：{msg}")
            },
        );
    }
    if repo.branch_upstream_name(&local).is_err() {
        if let Ok(mut b) = repo.find_branch(&branch, BranchType::Local) {
            let _ = b.set_upstream(Some(&format!(
                "{remote_name}/{}",
                merge.trim_start_matches("refs/heads/")
            )));
        }
    }
    Ok("已推送".into())
}

/// 下載遠端儲存庫到 `dest`（不能已經存在檔案）。
pub fn clone_to(url: &str, dest: &Path, auth: &Auth) -> Result<(), String> {
    require_https(url)?;
    let session = Session::new(auth);
    let mut builder = git2::build::RepoBuilder::new();
    builder.fetch_options(session.fetch_options());
    let result = builder.clone(url, dest).map(|_| ());
    drop(builder);
    result.map_err(|e| session.describe(&e, url, "下載"))
}

/// 把資料夾變成連到 `url` 的儲存庫並上傳：還不是儲存庫就建立，設定遠端 origin，
/// 有變更就提交一次，再推送目前的分支。
pub fn publish_at(
    dir: &Path,
    url: &str,
    auth: &Auth,
    who: Option<&Identity>,
) -> Result<(), String> {
    let repo = match Repository::discover(dir) {
        Ok(r) => r,
        Err(_) => {
            let mut opts = git2::RepositoryInitOptions::new();
            opts.initial_head("main");
            Repository::init_opts(dir, &opts)
                .map_err(|e| format!("無法建立 Git 儲存庫：{}", e.message()))?
        }
    };
    match repo.find_remote("origin") {
        Ok(_) => repo.remote_set_url("origin", url).map_err(err)?,
        Err(_) => {
            repo.remote("origin", url).map_err(err)?;
        }
    }
    drop(repo);
    match commit_at(dir, "初始版本", who) {
        Ok(_) => {}
        Err(e) if e == "沒有需要提交的變更" => {}
        Err(e) => return Err(e),
    }
    push_at(dir, auth).map(|_| ())
}

// ---- 前端呼叫 ----------------------------------------------------------------

fn workspace_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.state::<Workspace>()
        .root()
        .ok_or_else(|| "還沒有開啟資料夾".to_string())
}

#[tauri::command]
pub async fn git_status(app: AppHandle) -> Result<Status, String> {
    let dir = workspace_root(&app)?;
    crate::io::blocking(move || Ok(status_at(&dir))).await
}

#[tauri::command]
pub async fn git_commit(app: AppHandle, message: String) -> Result<String, String> {
    let dir = workspace_root(&app)?;
    let who = crate::github::identity(&app);
    crate::io::blocking(move || commit_at(&dir, &message, who.as_ref())).await
}

#[tauri::command]
pub async fn git_pull(app: AppHandle) -> Result<String, String> {
    let dir = workspace_root(&app)?;
    let auth = crate::github::auth(&app);
    let who = crate::github::identity(&app);
    crate::io::blocking_for(NETWORK_TIMEOUT, move || pull_at(&dir, &auth, who.as_ref())).await
}

#[tauri::command]
pub async fn git_push(app: AppHandle) -> Result<String, String> {
    let dir = workspace_root(&app)?;
    let auth = crate::github::auth(&app);
    crate::io::blocking_for(NETWORK_TIMEOUT, move || push_at(&dir, &auth)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("md-git-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(&dir).unwrap()
    }

    fn me() -> Identity {
        Identity {
            name: "測試".into(),
            email: "test@example.com".into(),
        }
    }

    fn init(dir: &Path) {
        let mut opts = git2::RepositoryInitOptions::new();
        opts.initial_head("main");
        Repository::init_opts(dir, &opts).unwrap();
    }

    fn clone(remote: &Path, dir: &Path) {
        clone_to(remote.to_str().unwrap(), dir, &Auth::default()).unwrap();
    }

    #[test]
    fn status_of_plain_folder_and_new_repo() {
        let dir = temp("plain");
        let s = status_at(&dir);
        assert!(s.available && !s.repo);

        init(&dir);
        fs::create_dir_all(dir.join("筆記")).unwrap();
        fs::write(dir.join("筆記/週報.md"), "# 週報\n").unwrap();
        let s = status_at(&dir.join("筆記"));
        assert!(s.repo && s.trusted);
        assert_eq!(s.branch.unwrap().name, "main");
        assert_eq!(s.changes.len(), 1);
        assert_eq!(s.changes[0].status, FileStatus::Untracked);
        assert_eq!(
            s.changes[0].path,
            path_string(&dir.join("筆記").join("週報.md"))
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn commit_detects_changes_and_deletions() {
        let dir = temp("commit");
        init(&dir);
        assert_eq!(
            commit_at(&dir, "  ", Some(&me())).unwrap_err(),
            "請輸入提交說明"
        );
        assert_eq!(
            commit_at(&dir, "空的", Some(&me())).unwrap_err(),
            "沒有需要提交的變更"
        );
        fs::write(dir.join("a.md"), "a\n").unwrap();
        fs::write(dir.join("b.md"), "b\n").unwrap();
        // 沒有 Git 設定也沒有登入：提示登入。
        if Repository::open(&dir).unwrap().signature().is_err() {
            assert!(commit_at(&dir, "第一版", None)
                .unwrap_err()
                .contains("登入"));
        }
        assert!(commit_at(&dir, "第一版", Some(&me()))
            .unwrap()
            .ends_with(" 第一版"));
        assert!(status_at(&dir).changes.is_empty());
        fs::remove_file(dir.join("b.md")).unwrap();
        let s = status_at(&dir);
        assert_eq!(s.changes.len(), 1);
        assert_eq!(s.changes[0].status, FileStatus::Deleted);
        commit_at(&dir, "刪掉 b", Some(&me())).unwrap();
        assert!(status_at(&dir).changes.is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_ssh_remotes() {
        assert!(require_https("git@github.com:a/b.git")
            .unwrap_err()
            .contains("HTTPS"));
        assert!(require_https("https://github.com/a/b.git").is_ok());
        assert!(is_github("https://GitHub.com/a/b"));
        assert!(!is_github("https://gitlab.com/a/b"));
    }

    #[test]
    fn commit_pull_push_round_trip() {
        let remote = temp("remote");
        let mut opts = git2::RepositoryInitOptions::new();
        opts.initial_head("main").bare(true);
        Repository::init_opts(&remote, &opts).unwrap();
        let none = Auth::default();

        // a：新資料夾上傳到遠端（建立儲存庫、提交、推送、記住遠端分支）。
        let a = temp("a");
        fs::write(a.join("週報.md"), "# 週報\n").unwrap();
        publish_at(&a, remote.to_str().unwrap(), &none, Some(&me())).unwrap();
        let s = status_at(&a);
        let b0 = s.branch.unwrap();
        assert_eq!(b0.upstream.as_deref(), Some("origin/main"));
        assert_eq!((b0.ahead, b0.behind), (0, 0));

        // b：從遠端下載，修改後推送；a 拉取（快轉）。
        let b = temp("b");
        fs::remove_dir_all(&b).unwrap();
        clone(&remote, &b);
        fs::write(b.join("週報.md"), "# 週報\n\nb 的修改\n").unwrap();
        commit_at(&b, "b 的修改", Some(&me())).unwrap();
        assert_eq!(push_at(&b, &none).unwrap(), "已推送");
        assert_eq!(
            pull_at(&a, &none, Some(&me())).unwrap(),
            "已拉取 1 個新的提交"
        );
        assert_eq!(
            fs::read_to_string(a.join("週報.md")).unwrap(),
            "# 週報\n\nb 的修改\n"
        );
        assert_eq!(pull_at(&a, &none, Some(&me())).unwrap(), "已經是最新的");

        // 有未提交的變更時不拉取。
        fs::write(a.join("週報.md"), "未提交\n").unwrap();
        assert!(pull_at(&a, &none, Some(&me()))
            .unwrap_err()
            .contains("未提交"));
        fs::write(a.join("週報.md"), "# 週報\n\nb 的修改\n").unwrap();

        // 兩邊改同一行：推送被拒、拉取時衝突 → 取消，檔案維持原樣。
        fs::write(b.join("週報.md"), "# 週報\n\nb 又改了\n").unwrap();
        commit_at(&b, "b 第二次", Some(&me())).unwrap();
        push_at(&b, &none).unwrap();
        fs::write(a.join("週報.md"), "# 週報\n\na 也改了\n").unwrap();
        commit_at(&a, "a 的修改", Some(&me())).unwrap();
        assert!(push_at(&a, &none).unwrap_err().contains("先拉取"));
        assert!(pull_at(&a, &none, Some(&me()))
            .unwrap_err()
            .contains("衝突"));
        assert_eq!(
            fs::read_to_string(a.join("週報.md")).unwrap(),
            "# 週報\n\na 也改了\n"
        );
        assert!(status_at(&a).changes.is_empty());

        // 改不同檔案：合併後推送。
        let c = temp("c");
        fs::remove_dir_all(&c).unwrap();
        clone(&remote, &c);
        fs::write(c.join("另一份.md"), "c\n").unwrap();
        commit_at(&c, "c 新增檔案", Some(&me())).unwrap();
        fs::write(b.join("週報.md"), "# 週報\n\nb 第三次\n").unwrap();
        commit_at(&b, "b 第三次", Some(&me())).unwrap();
        push_at(&b, &none).unwrap();
        assert!(pull_at(&c, &none, Some(&me())).unwrap().contains("合併"));
        assert_eq!(push_at(&c, &none).unwrap(), "已推送");
        assert_eq!(
            fs::read_to_string(c.join("週報.md")).unwrap(),
            "# 週報\n\nb 第三次\n"
        );
        assert!(c.join("另一份.md").exists());

        for d in [remote, a, b, c] {
            let _ = fs::remove_dir_all(d);
        }
    }
}
