//! Git 整合：內建 libgit2（git2），不需要另外安裝 Git。
//!
//! 安全原則：
//! - 所有操作都在目前開啟的資料夾（工作區）所在的儲存庫進行。
//! - libgit2 不會執行儲存庫設定指定的外部程式（hooks、fsmonitor、filter 等），
//!   打開別人給的資料夾也不會被執行程式，所以不需要先「信任」資料夾。
//! - 拉取時有未提交的變更就不做；能快轉就快轉，否則在記憶體裡合併，有衝突就放棄，
//!   磁碟上的檔案完全不會被動到。
//! - 遠端認證：github.com 用「登入 GitHub」取得的權杖；連線的 Azure DevOps 伺服器用
//!   個人存取權杖，不行時改用目前登入 Windows 的帳號（只送到那台伺服器）；
//!   其他 HTTPS 遠端用使用者全域 Git 設定裡的認證小幫手（credential helper）。不支援 SSH 遠端。

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
    /// 正在逐段處理合併衝突（還沒按「完成合併」）。
    pub(crate) merging: bool,
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
    /// 連線的 Azure DevOps 伺服器（只用在這個網址底下的儲存庫）。
    pub ado: Option<AdoCred>,
}

#[derive(Clone)]
pub struct AdoCred {
    /// 集合或組織的網址。
    pub base: String,
    /// 個人存取權杖。
    pub pat: Option<String>,
}

/// 推送、拉取時用的認證：GitHub 與 Azure DevOps 都帶上。
pub fn auth(app: &AppHandle) -> Auth {
    Auth {
        github_token: crate::github::auth(app).github_token,
        ado: crate::ado::cred(app),
    }
}

/// 提交時的名字與 Email：遠端在 Azure DevOps 上就用 ADO 的帳號，否則用 GitHub 的。
pub(crate) fn identity_for(app: &AppHandle, dir: &Path) -> Option<Identity> {
    let on_ado = crate::ado::cred(app).is_some_and(|c| {
        open(dir)
            .ok()
            .and_then(|r| {
                let remote = r.find_remote("origin").ok()?;
                remote.url().ok().map(str::to_string)
            })
            .is_some_and(|url| crate::ado::starts_with_base(&url, &c.base))
    });
    if on_ado {
        crate::ado::identity(app).or_else(|| crate::github::identity(app))
    } else {
        crate::github::identity(app).or_else(|| crate::ado::identity(app))
    }
}

/// 連線時依序嘗試的認證方式。
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Plan {
    GitHubToken,
    AdoToken,
    /// Windows 整合式驗證（NTLM／Kerberos），用目前登入 Windows 的帳號。
    WindowsLogin,
    /// 使用者全域 Git 設定裡的認證小幫手。
    Helper,
}

fn plans(auth: &Auth, url: &str, allowed: CredentialType) -> Vec<Plan> {
    let user_pass = allowed.contains(CredentialType::USER_PASS_PLAINTEXT);
    let windows = allowed.contains(CredentialType::DEFAULT);
    let mut out = Vec::new();
    if is_github(url) {
        if user_pass && auth.github_token.is_some() {
            out.push(Plan::GitHubToken);
        }
    } else if let Some(ado) = auth
        .ado
        .as_ref()
        .filter(|a| crate::ado::starts_with_base(url, &a.base))
    {
        if user_pass && ado.pat.is_some() {
            out.push(Plan::AdoToken);
        }
    }
    // Windows 帳號只交給連線的 Azure DevOps 伺服器：別人給的儲存庫若把遠端指到其他網站，
    // 不會把 Windows 的登入資訊送過去。
    if windows
        && auth
            .ado
            .as_ref()
            .is_some_and(|a| crate::ado::same_server(url, &a.base))
    {
        out.push(Plan::WindowsLogin);
    }
    if user_pass {
        out.push(Plan::Helper);
    }
    out
}

fn is_ado(auth: &Auth, url: &str) -> bool {
    auth.ado
        .as_ref()
        .is_some_and(|a| crate::ado::starts_with_base(url, &a.base))
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

/// 找到 `dir` 所在的儲存庫（往上找 `.git`），並確認它不會把操作帶到資料夾以外：
/// - 儲存庫設定的工作目錄（`core.worktree`）必須就是 `.git` 所在的資料夾，
///   否則切換分支、合併時檔案會寫到別的地方（例如 Windows 的「啟動」資料夾）。
/// - `.git` 是檔案（`gitdir: …` 指標）時，不能指到網路位置（`\\主機\…`）：
///   光是讀取就會連過去，可能洩漏 Windows 登入的雜湊值。資料夾本身就在網路磁碟上時不限制。
///
/// 別人分享的資料夾可能帶著設計過的 `.git`，所以每次開啟都檢查。
pub(crate) fn open(dir: &Path) -> Result<Repository, String> {
    let not_repo = || tr!("這個資料夾不是 Git 儲存庫");
    let unsafe_repo = || {
        tr!("這個資料夾的 Git 設定會把檔案寫到資料夾以外的地方（core.worktree 或 gitdir），為了安全不使用。")
    };
    let base = dir
        .ancestors()
        .find(|d| d.join(".git").exists())
        .ok_or_else(not_repo)?;
    let on_network = crate::io::is_network_path(base);
    let dot_git = base.join(".git");
    if dot_git.is_file() {
        let text = std::fs::read_to_string(&dot_git).map_err(|_| not_repo())?;
        let target = text
            .lines()
            .find_map(|l| l.strip_prefix("gitdir:"))
            .map(str::trim)
            .ok_or_else(not_repo)?;
        if !on_network && looks_remote(target) {
            return Err(unsafe_repo());
        }
    }
    let repo = Repository::open(base).map_err(|_| not_repo())?;
    if !on_network && crate::io::is_network_path(repo.path()) {
        return Err(unsafe_repo());
    }
    if let Some(workdir) = repo.workdir() {
        let canon = |p: &Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        if canon(workdir) != canon(base) {
            return Err(unsafe_repo());
        }
    }
    Ok(repo)
}

/// 網路位置（UNC 路徑，或 `//主機/…`）。
fn looks_remote(path: &str) -> bool {
    path.starts_with("\\\\")
        || path.starts_with("//")
        || crate::io::is_network_path(Path::new(path))
}

pub(crate) fn workdir(repo: &Repository) -> Result<PathBuf, String> {
    let dir = repo
        .workdir()
        .ok_or_else(|| tr!("這個儲存庫沒有工作目錄（bare）"))?;
    Ok(dunce::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf()))
}

pub(crate) fn err(e: git2::Error) -> String {
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

pub(crate) fn has_changes(repo: &Repository) -> Result<bool, String> {
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
        merging: false,
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
            merging: repo.state() == RepositoryState::Merge,
        },
        Err(_) => empty(true),
    }
}

pub(crate) fn require_clean_state(repo: &Repository) -> Result<(), String> {
    if repo.state() == RepositoryState::Clean {
        Ok(())
    } else {
        Err(tr!(
            "這個儲存庫正在合併：請先在原始碼控制面板處理完衝突並按「完成合併」，或按「放棄合併」"
        ))
    }
}

pub(crate) fn signature(
    repo: &Repository,
    who: Option<&Identity>,
) -> Result<Signature<'static>, String> {
    if let Ok(sig) = repo.signature() {
        return Ok(sig.to_owned());
    }
    match who {
        Some(id) => Signature::now(&id.name, &id.email).map_err(err),
        None => Err(tr!(
            "提交需要你的名字與 Email：請先到設定的 Git 頁「用 GitHub 登入」或連線到 Azure DevOps"
        )),
    }
}

/// 提交工作區資料夾內的所有變更（工作區是儲存庫的子資料夾時，只提交那個子資料夾）。
pub fn commit_at(dir: &Path, message: &str, who: Option<&Identity>) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err(tr!("請輸入提交說明"));
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
        return Err(tr!("沒有需要提交的變更"));
    }
    let sig = signature(&repo, who)?;
    let tree = repo.find_tree(tree_id).map_err(err)?;
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(|e| tr!("提交失敗：{e}", e = e.message()))?;
    let first = message.lines().next().unwrap_or_default();
    Ok(format!("{} {first}", &oid.to_string()[..7]))
}

// ---- 遠端 -------------------------------------------------------------------

fn is_github(url: &str) -> bool {
    url.to_ascii_lowercase().starts_with("https://github.com/")
}

/// 遠端網址只接受 HTTPS；不加密的 HTTP 只限區域網路的位址；本機的儲存庫路徑不能是網路位置
/// （別人給的儲存庫可能把遠端設成 `\\主機\…`，光是檢查路徑存不存在就會連過去）。
fn require_https(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    let local = || !looks_remote(url) && !lower.contains("://") && Path::new(url).exists();
    if lower.starts_with("https://") || local() {
        Ok(())
    } else if lower.starts_with("http://") {
        let host = crate::dav::host_of(url);
        if !host.is_empty() && crate::dav::is_private_host(&host) && !url.contains(['?', '#']) {
            Ok(())
        } else {
            Err(tr!(
                "遠端網址用的是沒有加密的 HTTP，密碼和內容可能被看到，只能用在區域網路。請改用 HTTPS 的網址：{url}",
                url = url
            ))
        }
    } else {
        Err(tr!(
            "目前只支援 HTTPS 的遠端網址（例如 https://github.com/…）。這個儲存庫的遠端是：{url}",
            url = url
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
            // 認證被拒絕時 libgit2 會一直重問：每一種方式只試一次，依序換下一種。
            let list = plans(self.auth, url, allowed);
            while let Some(&plan) = list.get(self.tries.get() as usize) {
                self.tries.set(self.tries.get() + 1);
                let cred = match plan {
                    Plan::GitHubToken => self
                        .auth
                        .github_token
                        .as_deref()
                        .map(|t| Cred::userpass_plaintext("x-access-token", t)),
                    Plan::AdoToken => self
                        .auth
                        .ado
                        .as_ref()
                        .and_then(|a| a.pat.as_deref())
                        .map(|t| Cred::userpass_plaintext("omarker", t)),
                    Plan::WindowsLogin => Some(Cred::default()),
                    // 沿用電腦上 Git 已經存好的帳號（例如 Git Credential Manager）。
                    // 只讀使用者自己的全域設定，不讀儲存庫裡的（避免執行來路不明的程式）。
                    Plan::Helper => git2::Config::open_default()
                        .ok()
                        .map(|cfg| Cred::credential_helper(&cfg, url, username)),
                };
                if let Some(Ok(cred)) = cred {
                    return Ok(cred);
                }
            }
            self.refused.set(true);
            Err(git2::Error::from_str(&tr!("需要登入")))
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
            if is_ado(self.auth, url) {
                let has_token = self.auth.ado.as_ref().is_some_and(|a| a.pat.is_some());
                if has_token {
                    tr!("{what}失敗：Azure DevOps 拒絕存取。可能沒有這個儲存庫的權限，或個人存取權杖已過期，請到設定的 Git 頁重新連線。", what = what)
                } else {
                    tr!("{what}失敗：需要登入 Azure DevOps。請到設定的 Git 頁輸入個人存取權杖並連線。", what = what)
                }
            } else if is_github(url) && self.auth.github_token.is_none() {
                tr!(
                    "{what}失敗：需要登入 GitHub。請到設定的 Git 頁按「用 GitHub 登入」。",
                    what = what
                )
            } else if is_github(url) {
                tr!("{what}失敗：GitHub 拒絕存取。可能沒有這個儲存庫的權限，或登入已過期，請重新登入 GitHub。", what = what)
            } else {
                tr!(
                    "{what}失敗：需要登入遠端儲存庫（{url}）。",
                    what = what,
                    url = url
                )
            }
        } else if matches!(
            e.class(),
            ErrorClass::Net | ErrorClass::Http | ErrorClass::Ssl
        ) {
            tr!(
                "{what}失敗：無法連線到遠端儲存庫（{e}）",
                what = what,
                e = e.message()
            )
        } else {
            tr!("{what}失敗：{e}", what = what, e = e.message())
        }
    }
}

fn proxy() -> ProxyOptions<'static> {
    let mut p = ProxyOptions::new();
    p.auto();
    p
}

/// 分支名稱、遠端名稱，以及遠端那邊的分支（`refs/heads/…`）。
pub(crate) fn tracking(repo: &Repository) -> Result<(String, String, String), String> {
    let head = repo.head().ok();
    let branch = match &head {
        Some(h) if h.is_branch() => h.shorthand().unwrap_or("main").to_string(),
        Some(_) => return Err(tr!("目前不在任何分支上（detached HEAD），請先切換到分支")),
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
        .ok_or_else(|| tr!("這個資料夾還沒有連到 GitHub 或其他遠端儲存庫"))?;
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

/// 拉取遇到衝突時的訊息（前端看到這段文字會提供「逐段處理」）。
pub fn conflict_message() -> String {
    tr!("遠端和本機改到了同樣的地方。已經取消拉取，檔案都維持原樣；可以按「逐段處理」決定每一段要用哪一邊。")
}

/// 拉取遠端的新提交。有未提交的變更時不做；遇到衝突時放棄，不動任何檔案。
pub fn pull_at(dir: &Path, auth: &Auth, who: Option<&Identity>) -> Result<String, String> {
    let repo = open(dir)?;
    require_clean_state(&repo)?;
    if has_changes(&repo)? {
        return Err(tr!("還有未提交的變更，請先提交再拉取"));
    }
    let (branch, remote_name, merge) = tracking(&repo)?;
    let url = remote_url(&repo, &remote_name)?;
    let session = Session::new(auth);
    repo.find_remote(&remote_name)
        .map_err(err)?
        .fetch::<&str>(&[], Some(&mut session.fetch_options()), None)
        .map_err(|e| session.describe(&e, &url, &tr!("拉取")))?;

    let short = merge.trim_start_matches("refs/heads/");
    let Ok(theirs_id) = repo.refname_to_id(&format!("refs/remotes/{remote_name}/{short}")) else {
        return Ok(tr!("遠端還沒有這個分支，不需要拉取"));
    };
    let theirs = repo.find_annotated_commit(theirs_id).map_err(err)?;
    let (analysis, _) = repo.merge_analysis(&[&theirs]).map_err(err)?;
    if analysis.is_up_to_date() {
        return Ok(tr!("已經是最新的"));
    }
    let local_ref = format!("refs/heads/{branch}");
    let before = repo.head().ok().and_then(|h| h.target());
    let count = count_between(&repo, before, theirs_id);

    if analysis.is_fast_forward() || analysis.is_unborn() {
        let target = repo.find_commit(theirs_id).map_err(err)?;
        repo.checkout_tree(target.as_object(), Some(CheckoutBuilder::new().safe()))
            .map_err(|e| tr!("拉取失敗：{e}", e = e.message()))?;
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
        return Ok(tr!("已拉取 {count} 個新的提交", count = count));
    }

    // 兩邊都有新提交：先在記憶體裡合併，沒有衝突才寫到磁碟。
    let ours = repo
        .find_commit(before.ok_or_else(|| tr!("找不到目前的提交"))?)
        .map_err(err)?;
    let theirs_commit = repo.find_commit(theirs_id).map_err(err)?;
    let mut merged = repo
        .merge_commits(&ours, &theirs_commit, None)
        .map_err(err)?;
    if merged.has_conflicts() {
        return Err(conflict_message());
    }
    let tree_id = merged.write_tree_to(&repo).map_err(err)?;
    let tree = repo.find_tree(tree_id).map_err(err)?;
    let sig = signature(&repo, who)?;
    let oid = repo
        .commit(
            None,
            &sig,
            &sig,
            &tr!(
                "合併 {remote_name}/{short} 的變更",
                remote_name = remote_name,
                short = short
            ),
            &tree,
            &[&ours, &theirs_commit],
        )
        .map_err(err)?;
    repo.checkout_tree(tree.as_object(), Some(CheckoutBuilder::new().safe()))
        .map_err(|e| tr!("拉取失敗：{e}", e = e.message()))?;
    repo.find_reference(&local_ref)
        .map_err(err)?
        .set_target(oid, "pull: merge")
        .map_err(err)?;
    Ok(tr!(
        "已拉取 {count} 個新的提交，並和本機的提交合併",
        count = count
    ))
}

/// 推送目前的分支。第一次推送時會記住對應的遠端分支。
pub fn push_at(dir: &Path, auth: &Auth) -> Result<String, String> {
    let repo = open(dir)?;
    let (branch, remote_name, merge) = tracking(&repo)?;
    let url = remote_url(&repo, &remote_name)?;
    let local = format!("refs/heads/{branch}");
    if repo.refname_to_id(&local).is_err() {
        return Err(tr!("還沒有任何提交，請先提交再推送"));
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
    let behind = tr!("遠端有你還沒拉取的提交，請先拉取再推送");
    repo.find_remote(&remote_name)
        .map_err(err)?
        .push(&[format!("{local}:{merge}")], Some(&mut po))
        .map_err(|e| {
            if e.code() == ErrorCode::NotFastForward {
                behind.clone()
            } else {
                session.describe(&e, &url, &tr!("推送"))
            }
        })?;
    drop(po);
    if let Some(msg) = rejected.into_inner() {
        return Err(
            if msg.contains("fast-forward") || msg.contains("fetch first") {
                behind
            } else {
                tr!("推送被遠端拒絕：{msg}", msg = msg)
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
    Ok(tr!("已推送"))
}

/// 下載遠端儲存庫到 `dest`（不能已經存在檔案）。
pub fn clone_to(url: &str, dest: &Path, auth: &Auth) -> Result<(), String> {
    require_https(url)?;
    let session = Session::new(auth);
    let mut builder = git2::build::RepoBuilder::new();
    builder.fetch_options(session.fetch_options());
    let result = builder.clone(url, dest).map(|_| ());
    drop(builder);
    result.map_err(|e| session.describe(&e, url, &tr!("下載")))
}

/// 把資料夾變成連到 `url` 的儲存庫並上傳：還不是儲存庫就建立，設定遠端 origin，
/// 有變更就提交一次，再推送目前的分支。
pub fn publish_at(
    dir: &Path,
    url: &str,
    auth: &Auth,
    who: Option<&Identity>,
) -> Result<(), String> {
    let repo = match open(dir) {
        Ok(r) => r,
        // 有 `.git` 但不安全：回報錯誤，不要在裡面另外建立儲存庫。
        Err(e) if dir.ancestors().any(|d| d.join(".git").exists()) => return Err(e),
        Err(_) => {
            let mut opts = git2::RepositoryInitOptions::new();
            opts.initial_head("main");
            Repository::init_opts(dir, &opts)
                .map_err(|e| tr!("無法建立 Git 儲存庫：{e}", e = e.message()))?
        }
    };
    match repo.find_remote("origin") {
        Ok(_) => repo.remote_set_url("origin", url).map_err(err)?,
        Err(_) => {
            repo.remote("origin", url).map_err(err)?;
        }
    }
    drop(repo);
    match commit_at(dir, &tr!("初始版本"), who) {
        Ok(_) => {}
        Err(e) if e == tr!("沒有需要提交的變更") => {}
        Err(e) => return Err(e),
    }
    push_at(dir, auth).map(|_| ())
}

// ---- 前端呼叫 ----------------------------------------------------------------

fn workspace_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.state::<Workspace>()
        .root()
        .ok_or_else(|| tr!("還沒有開啟資料夾"))
}

#[tauri::command]
pub async fn git_status(app: AppHandle) -> Result<Status, String> {
    let dir = workspace_root(&app)?;
    crate::io::blocking(move || Ok(status_at(&dir))).await
}

#[tauri::command]
pub async fn git_commit(app: AppHandle, message: String) -> Result<String, String> {
    let dir = workspace_root(&app)?;
    let who = identity_for(&app, &dir);
    crate::io::blocking(move || commit_at(&dir, &message, who.as_ref())).await
}

#[tauri::command]
pub async fn git_pull(app: AppHandle) -> Result<String, String> {
    let dir = workspace_root(&app)?;
    let auth = auth(&app);
    let who = identity_for(&app, &dir);
    crate::io::blocking_for(NETWORK_TIMEOUT, move || pull_at(&dir, &auth, who.as_ref())).await
}

#[tauri::command]
pub async fn git_push(app: AppHandle) -> Result<String, String> {
    let dir = workspace_root(&app)?;
    let auth = auth(&app);
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

    #[test]
    fn refuses_repos_that_point_outside_the_folder() {
        // 一般的儲存庫：從子資料夾也找得到。
        let ok = temp("open-ok");
        Repository::init(&ok).unwrap();
        fs::create_dir_all(ok.join("筆記")).unwrap();
        assert!(open(&ok.join("筆記")).is_ok());
        // core.worktree 指到別的地方：不使用。
        let evil = temp("open-worktree");
        let elsewhere = temp("open-elsewhere");
        let repo = Repository::init(&evil).unwrap();
        repo.config()
            .unwrap()
            .set_str("core.worktree", elsewhere.to_str().unwrap())
            .unwrap();
        assert!(open(&evil).err().unwrap().contains("core.worktree"));
        // `.git` 檔案指到網路位置：不讀取。
        let pointer = temp("open-gitdir");
        fs::write(pointer.join(".git"), "gitdir: //attacker/share/repo\n").unwrap();
        assert!(open(&pointer).err().unwrap().contains("gitdir"));
        fs::write(pointer.join(".git"), "gitdir: \\\\attacker\\share\n").unwrap();
        assert!(open(&pointer).err().unwrap().contains("gitdir"));
        assert!(open(&temp("open-none")).is_err());
        for d in [ok, evil, elsewhere, pointer] {
            let _ = fs::remove_dir_all(d);
        }
    }

    #[test]
    fn tries_ado_token_then_windows_login() {
        let auth = Auth {
            github_token: Some("gh".into()),
            ado: Some(AdoCred {
                base: "https://tfs.corp.com/tfs/DC".into(),
                pat: Some("pat".into()),
            }),
        };
        let both = CredentialType::USER_PASS_PLAINTEXT | CredentialType::DEFAULT;
        assert_eq!(
            plans(&auth, "https://tfs.corp.com/tfs/DC/P/_git/r", both),
            [Plan::AdoToken, Plan::WindowsLogin, Plan::Helper]
        );
        // 權杖只送給 GitHub 與連線的 ADO 伺服器，其他網站不會拿到。
        assert_eq!(
            plans(&auth, "https://other.com/x.git", both),
            [Plan::Helper]
        );
        // 同一台伺服器的其他集合：權杖不送，但可以用 Windows 帳號。
        assert_eq!(
            plans(&auth, "https://tfs.corp.com/tfs/Other/P/_git/r", both),
            [Plan::WindowsLogin, Plan::Helper]
        );
        assert_eq!(
            plans(&auth, "https://github.com/a/b.git", both),
            [Plan::GitHubToken, Plan::Helper]
        );
        let no_pat = Auth {
            ado: Some(AdoCred {
                base: "https://tfs.corp.com/tfs/DC".into(),
                pat: None,
            }),
            ..Auth::default()
        };
        assert_eq!(
            plans(
                &no_pat,
                "https://tfs.corp.com/tfs/DC/P/_git/r",
                CredentialType::DEFAULT
            ),
            [Plan::WindowsLogin]
        );
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

    /// Windows 的 Git 預設 core.autocrlf=true，取出的檔案是 CRLF：比對內容時統一成 LF。
    fn read(path: PathBuf) -> std::io::Result<String> {
        fs::read_to_string(path).map(|s| s.replace("\r\n", "\n"))
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
        assert!(require_https("http://192.168.1.5/git/notes.git").is_ok());
        assert!(require_https("http://example.com/a.git").is_err());
        assert!(require_https("http://example.com#@10.0.0.1/a.git").is_err());
        assert!(require_https("\\\\attacker\\share\\r").is_err());
        assert!(require_https("//attacker/share/r").is_err());
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
        assert_eq!(read(a.join("週報.md")).unwrap(), "# 週報\n\nb 的修改\n");
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
        assert_eq!(
            pull_at(&a, &none, Some(&me())).unwrap_err(),
            conflict_message()
        );
        assert_eq!(read(a.join("週報.md")).unwrap(), "# 週報\n\na 也改了\n");
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
        assert_eq!(read(c.join("週報.md")).unwrap(), "# 週報\n\nb 第三次\n");
        assert!(c.join("另一份.md").exists());

        for d in [remote, a, b, c] {
            let _ = fs::remove_dir_all(d);
        }
    }
}
