//! 儲存庫的提交歷史（畫線圖用）、單一提交的內容與差異，以及在歷史上的操作：
//! 建立分支與標籤、合併分支、撤銷（revert）、挑選提交（cherry-pick）、
//! 退回到某個版本（保留檔案內容）、修改最後一次提交的說明、復原上一個操作。
//!
//! 安全原則：已經推送的歷史不改寫（不做 rebase、強制推送）；會動到檔案的操作要求沒有未提交的變更；
//! 撤銷與挑選提交先在記憶體裡合併，有衝突就不做，不會留下處理到一半的狀態。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use git2::build::CheckoutBuilder;
use git2::{
    BranchType, Commit, Delta, DiffOptions, ObjectType, Oid, Reference, Repository, ResetType,
    Sort, Tree,
};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::git::{err, has_changes, open, require_clean_state, signature, workdir, Identity};
use crate::git_flow::{collect_conflicts, require_clean, set_merge_message, Conflict};
use crate::workspace::Workspace;

/// 一次最多回傳幾個提交；搜尋時最多往回找幾個提交（很大的儲存庫不會卡住）。
const PAGE_MAX: usize = 500;
const MAX_SCAN: usize = 100_000;
/// 一次提交最多列出幾個檔案的差異。
const MAX_FILES: usize = 1000;
/// 「未推送／未拉取」最多標示幾個提交。
const MAX_MARKS: usize = 5000;
/// 統計最多讀幾個提交。
const MAX_STATS: usize = 50_000;

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RefKind {
    /// 目前所在的分支。
    Head,
    Branch,
    Remote,
    Tag,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct RefLabel {
    name: String,
    kind: RefKind,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LogCommit {
    id: String,
    parents: Vec<String>,
    summary: String,
    author: String,
    email: String,
    /// Unix 秒。
    time: i64,
    refs: Vec<RefLabel>,
    /// 只在本機、還沒推送。
    unpushed: bool,
    /// 遠端有、本機還沒拉取。
    unpulled: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    commits: Vec<LogCommit>,
    /// 後面還有更多。
    more: bool,
    /// 目前所在的提交。
    head: Option<String>,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileChange {
    Added,
    Deleted,
    Modified,
    Renamed,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// 儲存庫裡的相對路徑（用 `/` 分隔）。
    path: String,
    /// 改名前的路徑。
    old_path: Option<String>,
    status: FileChange,
    additions: usize,
    deletions: usize,
    binary: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChangeList {
    files: Vec<ChangedFile>,
    /// 檔案太多，只列出前面一部分。
    truncated: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    id: String,
    parents: Vec<String>,
    message: String,
    author: String,
    email: String,
    time: i64,
    committer: String,
    commit_time: i64,
    changes: ChangeList,
}

/// 檔案在兩個版本的內容；沒有這個檔案時是 null。不是文字檔時 `note` 說明原因。
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct FilePair {
    before: Option<String>,
    after: Option<String>,
    note: Option<String>,
}

/// 會改變目前位置的操作完成後，回傳操作前的提交，讓前端提供「復原」。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    message: String,
    before: Option<String>,
    after: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    message: String,
    before: Option<String>,
    /// 有衝突時：逐段處理，處理完在原始碼控制面板按「完成合併」。
    conflicts: Vec<Conflict>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StatCommit {
    author: String,
    time: i64,
    /// 時區（分鐘），讓前端用提交當地的日期分組。
    offset: i32,
}

// ---- 讀取 -------------------------------------------------------------------

fn text_of(s: Result<&str, git2::Error>) -> String {
    s.unwrap_or_default().to_string()
}

fn summary_of(c: &Commit) -> String {
    c.summary().ok().flatten().unwrap_or_default().to_string()
}

fn head_oid(repo: &Repository) -> Option<Oid> {
    repo.head().ok().and_then(|h| h.target())
}

/// 目前分支追蹤的遠端分支的提交。
fn upstream_oid(repo: &Repository) -> Option<Oid> {
    let head = repo.head().ok()?;
    if !head.is_branch() {
        return None;
    }
    let up = repo.branch_upstream_name(head.name().ok()?).ok()?;
    repo.refname_to_id(up.as_str().ok()?).ok()
}

/// 每個提交上的分支與標籤名稱。
fn refs_by_commit(repo: &Repository) -> HashMap<Oid, Vec<RefLabel>> {
    let current = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.name().ok().map(str::to_string));
    let mut map: HashMap<Oid, Vec<RefLabel>> = HashMap::new();
    let Ok(refs) = repo.references() else {
        return map;
    };
    for r in refs.filter_map(Result::ok) {
        let Ok(full) = r.name().map(str::to_string) else {
            continue;
        };
        let kind = if r.is_branch() {
            if current.as_deref() == Some(full.as_str()) {
                RefKind::Head
            } else {
                RefKind::Branch
            }
        } else if r.is_remote() {
            // origin/HEAD 只是指向預設分支，不另外顯示。
            if full.ends_with("/HEAD") {
                continue;
            }
            RefKind::Remote
        } else if r.is_tag() {
            RefKind::Tag
        } else {
            continue;
        };
        let Ok(commit) = r.peel_to_commit() else {
            continue;
        };
        let name = r.shorthand().unwrap_or(&full).to_string();
        map.entry(commit.id())
            .or_default()
            .push(RefLabel { name, kind });
    }
    // 目前的分支排最前面，其次是其他分支、遠端、標籤。
    for list in map.values_mut() {
        list.sort_by_key(|l| l.kind as u8);
    }
    map
}

/// `from` 可以到、`hide` 到不了的提交（例如還沒推送的提交）。
fn only_in(repo: &Repository, from: Oid, hide: Oid) -> HashSet<Oid> {
    let Ok(mut walk) = repo.revwalk() else {
        return HashSet::new();
    };
    if walk.push(from).is_err() || walk.hide(hide).is_err() {
        return HashSet::new();
    }
    walk.filter_map(Result::ok).take(MAX_MARKS).collect()
}

/// 有沒有改到 `path`（檔案或資料夾，和第一個上層提交比較）。
fn touches(commit: &Commit, path: &str) -> bool {
    let id = |c: &Commit| -> Option<Oid> {
        c.tree()
            .ok()?
            .get_path(Path::new(path))
            .ok()
            .map(|e| e.id())
    };
    let now = id(commit);
    match commit.parent(0) {
        Ok(p) => now != id(&p),
        Err(_) => now.is_some(),
    }
}

fn matches_text(commit: &Commit, needle: &str) -> bool {
    let hay = format!(
        "{}\n{}\n{}\n{}",
        commit.message().unwrap_or_default(),
        commit.author().name().unwrap_or_default(),
        commit.author().email().unwrap_or_default(),
        commit.id()
    )
    .to_lowercase();
    hay.contains(needle)
}

/// 提交歷史的一頁。`all` 時包含所有分支與標籤；`path`（儲存庫內的相對路徑）、`text`
/// （說明、作者、提交編號）用來篩選。
pub fn log_at(
    dir: &Path,
    skip: usize,
    limit: usize,
    all: bool,
    path: Option<&str>,
    text: Option<&str>,
) -> Result<LogPage, String> {
    let repo = open(dir)?;
    let head = head_oid(&repo);
    let mut walk = repo.revwalk().map_err(err)?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
        .map_err(err)?;
    if all {
        for glob in ["refs/heads", "refs/remotes", "refs/tags"] {
            let _ = walk.push_glob(glob);
        }
    }
    // 不在任何分支上（detached HEAD）時也要看得到目前的位置。
    if let Some(h) = head {
        let _ = walk.push(h);
    }
    let refs = refs_by_commit(&repo);
    let (unpushed, unpulled) = match (head, upstream_oid(&repo)) {
        (Some(h), Some(up)) => (only_in(&repo, h, up), only_in(&repo, up, h)),
        _ => (HashSet::new(), HashSet::new()),
    };
    let needle = text
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty());
    let path = path.map(|p| p.trim_matches('/')).filter(|p| !p.is_empty());
    let filtered = needle.is_some() || path.is_some();
    let limit = limit.clamp(1, PAGE_MAX);
    let mut commits = Vec::new();
    let mut seen = 0usize;
    let mut more = false;
    for oid in walk
        .filter_map(Result::ok)
        .take(if filtered { MAX_SCAN } else { usize::MAX })
    {
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };
        if needle.as_deref().is_some_and(|n| !matches_text(&commit, n))
            || path.is_some_and(|p| !touches(&commit, p))
        {
            continue;
        }
        seen += 1;
        if seen <= skip {
            continue;
        }
        if commits.len() >= limit {
            more = true;
            break;
        }
        let author = commit.author();
        commits.push(LogCommit {
            id: oid.to_string(),
            parents: commit.parent_ids().map(|p| p.to_string()).collect(),
            summary: summary_of(&commit),
            author: text_of(author.name()),
            email: text_of(author.email()),
            time: commit.time().seconds(),
            refs: refs.get(&oid).cloned().unwrap_or_default(),
            unpushed: unpushed.contains(&oid),
            unpulled: unpulled.contains(&oid),
        });
    }
    Ok(LogPage {
        commits,
        more,
        head: head.map(|h| h.to_string()),
    })
}

fn find_commit<'r>(repo: &'r Repository, id: &str) -> Result<Commit<'r>, String> {
    let oid = Oid::from_str(id).map_err(|_| tr!("提交編號不正確"))?;
    repo.find_commit(oid).map_err(|_| tr!("找不到這個提交"))
}

fn path_text(p: Option<&Path>) -> Option<String> {
    p.map(|p| p.to_string_lossy().replace('\\', "/"))
}

/// 兩個版本之間改了哪些檔案（`new` 是 None 時和工作目錄比較）。
fn changes_between(
    repo: &Repository,
    old: Option<&Tree>,
    new: Option<&Tree>,
) -> Result<ChangeList, String> {
    let mut opts = DiffOptions::new();
    opts.ignore_submodules(true);
    let mut diff = match new {
        Some(tree) => repo.diff_tree_to_tree(old, Some(tree), Some(&mut opts)),
        None => {
            opts.include_untracked(true).recurse_untracked_dirs(true);
            repo.diff_tree_to_workdir_with_index(old, Some(&mut opts))
        }
    }
    .map_err(err)?;
    diff.find_similar(None).map_err(err)?;
    let total = diff.deltas().len();
    let mut files = Vec::new();
    for i in 0..total.min(MAX_FILES) {
        let delta = diff.get_delta(i).ok_or_else(|| tr!("讀取差異失敗"))?;
        let status = match delta.status() {
            Delta::Added | Delta::Untracked | Delta::Copied => FileChange::Added,
            Delta::Deleted => FileChange::Deleted,
            Delta::Renamed => FileChange::Renamed,
            _ => FileChange::Modified,
        };
        let new_path = path_text(delta.new_file().path());
        let old_path = path_text(delta.old_file().path());
        let path = if status == FileChange::Deleted {
            old_path.clone()
        } else {
            new_path.clone()
        }
        .unwrap_or_default();
        let (mut additions, mut deletions, mut binary) = (0, 0, delta.flags().is_binary());
        if let Ok(Some(patch)) = git2::Patch::from_diff(&diff, i) {
            binary |= patch.delta().flags().is_binary();
            if let Ok((_, a, d)) = patch.line_stats() {
                additions = a;
                deletions = d;
            }
        }
        files.push(ChangedFile {
            old_path: (status == FileChange::Renamed)
                .then_some(old_path)
                .flatten(),
            path,
            status,
            additions,
            deletions,
            binary,
        });
    }
    Ok(ChangeList {
        files,
        truncated: total > MAX_FILES,
    })
}

/// 一個提交的完整說明與改了哪些檔案（和第一個上層提交比較）。
pub fn detail_at(dir: &Path, id: &str) -> Result<CommitDetail, String> {
    let repo = open(dir)?;
    let commit = find_commit(&repo, id)?;
    let tree = commit.tree().map_err(err)?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let changes = changes_between(&repo, parent_tree.as_ref(), Some(&tree))?;
    let author = commit.author();
    let committer = commit.committer();
    Ok(CommitDetail {
        id: commit.id().to_string(),
        parents: commit.parent_ids().map(|p| p.to_string()).collect(),
        message: commit.message().unwrap_or_default().trim_end().to_string(),
        author: text_of(author.name()),
        email: text_of(author.email()),
        time: commit.time().seconds(),
        committer: text_of(committer.name()),
        commit_time: committer.when().seconds(),
        changes,
    })
}

/// 兩個提交之間改了哪些檔案（`from` 是比較舊的那個）。
pub fn compare_at(dir: &Path, from: &str, to: &str) -> Result<ChangeList, String> {
    let repo = open(dir)?;
    let a = find_commit(&repo, from)?.tree().map_err(err)?;
    let b = find_commit(&repo, to)?.tree().map_err(err)?;
    changes_between(&repo, Some(&a), Some(&b))
}

/// 還沒提交的變更（和目前的提交比較，包含新檔案）。
pub fn worktree_changes_at(dir: &Path) -> Result<ChangeList, String> {
    let repo = open(dir)?;
    let tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    changes_between(&repo, tree.as_ref(), None)
}

fn blob_text(repo: &Repository, tree: Option<&Tree>, rel: &str) -> Result<Option<String>, String> {
    let Some(entry) = tree.and_then(|t| t.get_path(Path::new(rel)).ok()) else {
        return Ok(None);
    };
    let blob = repo.find_blob(entry.id()).map_err(err)?;
    if let Some(why) = crate::files::not_text_reason(blob.content()) {
        return Err(why);
    }
    Ok(Some(crate::files::decode(blob.content()).0))
}

/// 一個檔案在兩個版本的內容。`to` 是 None 時是工作目錄裡的檔案；`from` 是 None 時是 `to`
/// 的第一個上層提交（`to` 也是 None 時是目前的提交）。
pub fn file_pair_at(
    dir: &Path,
    from: Option<&str>,
    to: Option<&str>,
    path: &str,
    old_path: Option<&str>,
) -> Result<FilePair, String> {
    let repo = open(dir)?;
    let to_commit = to.map(|id| find_commit(&repo, id)).transpose()?;
    let from_tree = match (from, &to_commit) {
        (Some(id), _) => Some(find_commit(&repo, id)?.tree().map_err(err)?),
        (None, Some(c)) => c.parent(0).ok().and_then(|p| p.tree().ok()),
        (None, None) => repo.head().ok().and_then(|h| h.peel_to_tree().ok()),
    };
    let old = old_path.unwrap_or(path);
    let before = blob_text(&repo, from_tree.as_ref(), old);
    let after = match &to_commit {
        Some(c) => blob_text(&repo, c.tree().ok().as_ref(), path),
        None => {
            let file = workdir(&repo)?.join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
            match std::fs::read(&file) {
                Ok(bytes) => match crate::files::not_text_reason(&bytes) {
                    Some(why) => Err(why),
                    None => Ok(Some(crate::files::decode(&bytes).0)),
                },
                Err(_) => Ok(None),
            }
        }
    };
    match (before, after) {
        (Ok(before), Ok(after)) => Ok(FilePair {
            before,
            after,
            note: None,
        }),
        (Err(why), _) | (_, Err(why)) => Ok(FilePair {
            note: Some(tr!("這個檔案{why}，不顯示內容的差異", why = why)),
            ..FilePair::default()
        }),
    }
}

/// 最近一年的提交（作者與時間），給統計圖用。
pub fn stats_at(dir: &Path, now: i64) -> Result<Vec<StatCommit>, String> {
    let repo = open(dir)?;
    let mut walk = repo.revwalk().map_err(err)?;
    walk.set_sorting(Sort::TIME).map_err(err)?;
    if walk.push_head().is_err() {
        return Ok(vec![]);
    }
    let since = now - 371 * 24 * 3600;
    let mut out = Vec::new();
    for oid in walk.filter_map(Result::ok).take(MAX_STATS) {
        let Ok(c) = repo.find_commit(oid) else {
            continue;
        };
        let when = c.author().when();
        if when.seconds() < since {
            break;
        }
        out.push(StatCommit {
            author: text_of(c.author().name()),
            time: when.seconds(),
            offset: when.offset_minutes(),
        });
    }
    Ok(out)
}

// ---- 操作 -------------------------------------------------------------------

fn valid_branch_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if !git2::Branch::name_is_valid(name).unwrap_or(false) || name.starts_with('-') {
        return Err(tr!("分支名稱不正確：不能有空白與 ~ ^ : ? * [ \\ 等符號"));
    }
    Ok(name)
}

/// 目前的提交是否已經推送（在遠端分支上）。
fn is_pushed(repo: &Repository, commit: Oid) -> bool {
    match upstream_oid(repo) {
        Some(up) => up == commit || repo.graph_descendant_of(up, commit).unwrap_or(false),
        None => false,
    }
}

/// 從某個提交建立分支；`checkout` 時同時切換過去（需要沒有未提交的變更）。
pub fn branch_at(dir: &Path, id: &str, name: &str, checkout: bool) -> Result<OpResult, String> {
    let name = valid_branch_name(name)?;
    let repo = open(dir)?;
    require_clean_state(&repo)?;
    if repo.find_branch(name, BranchType::Local).is_ok() {
        return Err(tr!("已經有「{name}」這個分支", name = name));
    }
    let commit = find_commit(&repo, id)?;
    if checkout {
        require_clean(&repo)?;
    }
    let before = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().ok().map(str::to_string));
    repo.branch(name, &commit, false).map_err(err)?;
    if !checkout {
        return Ok(OpResult {
            message: tr!("已建立分支「{name}」", name = name),
            before: None,
            after: None,
        });
    }
    repo.checkout_tree(commit.as_object(), Some(CheckoutBuilder::new().safe()))
        .map_err(|e| tr!("切換分支失敗：{e}", e = e.message()))?;
    repo.set_head(&format!("refs/heads/{name}")).map_err(err)?;
    Ok(OpResult {
        message: tr!("已建立並切換到「{name}」", name = name),
        // 復原時切回原本的分支。
        before,
        after: Some(name.to_string()),
    })
}

/// 刪除本機分支（不能刪除目前所在的分支）。
pub fn delete_branch_at(dir: &Path, name: &str) -> Result<String, String> {
    let repo = open(dir)?;
    let mut branch = repo
        .find_branch(name, BranchType::Local)
        .map_err(|_| tr!("找不到分支「{name}」", name = name))?;
    if branch.is_head() {
        return Err(tr!("不能刪除目前所在的分支，請先切換到其他分支"));
    }
    branch.delete().map_err(err)?;
    Ok(tr!("已刪除分支「{name}」", name = name))
}

/// 在某個提交加上標籤；有說明時建立附註標籤（記錄作者與時間）。
pub fn tag_at(
    dir: &Path,
    id: &str,
    name: &str,
    message: &str,
    who: Option<&Identity>,
) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('-') || !git2::Tag::is_valid_name(name) {
        return Err(tr!("標籤名稱不正確：不能有空白與 ~ ^ : ? * [ \\ 等符號"));
    }
    let repo = open(dir)?;
    if repo.refname_to_id(&format!("refs/tags/{name}")).is_ok() {
        return Err(tr!("已經有「{name}」這個標籤", name = name));
    }
    let commit = find_commit(&repo, id)?;
    let message = message.trim();
    if message.is_empty() {
        repo.tag_lightweight(name, commit.as_object(), false)
            .map_err(err)?;
    } else {
        let sig = signature(&repo, who)?;
        repo.tag(name, commit.as_object(), &sig, message, false)
            .map_err(err)?;
    }
    Ok(tr!("已加上標籤「{name}」", name = name))
}

pub fn delete_tag_at(dir: &Path, name: &str) -> Result<String, String> {
    let repo = open(dir)?;
    repo.tag_delete(name).map_err(err)?;
    Ok(tr!("已刪除標籤「{name}」", name = name))
}

/// 要合併的分支（本機分支，或 `origin/…` 遠端分支）指向的提交。
fn branch_target(repo: &Repository, name: &str) -> Result<Oid, String> {
    let r: Reference = repo
        .find_branch(name, BranchType::Local)
        .or_else(|_| repo.find_branch(name, BranchType::Remote))
        .map_err(|_| tr!("找不到分支「{name}」", name = name))?
        .into_reference();
    r.peel_to_commit().map(|c| c.id()).map_err(err)
}

/// 把另一個分支合併進目前的分支：能快轉就快轉；沒有衝突就直接建立合併提交；
/// 有衝突時回傳衝突的檔案，讓使用者逐段處理後在原始碼控制面板按「完成合併」。
pub fn merge_branch_at(
    dir: &Path,
    name: &str,
    who: Option<&Identity>,
) -> Result<MergeOutcome, String> {
    // 沒有衝突時，離開這個區塊（釋放儲存庫）後再完成合併。
    let (current, before) = {
        let repo = open(dir)?;
        require_clean(&repo)?;
        let head = repo
            .head()
            .ok()
            .filter(|h| h.is_branch())
            .ok_or_else(|| tr!("目前不在任何分支上（detached HEAD），請先切換到分支"))?;
        let current = head.shorthand().unwrap_or("HEAD").to_string();
        let ours = head.peel_to_commit().map_err(err)?;
        let theirs_id = branch_target(&repo, name)?;
        let before = Some(ours.id().to_string());
        let annotated = repo.find_annotated_commit(theirs_id).map_err(err)?;
        let (analysis, _) = repo.merge_analysis(&[&annotated]).map_err(err)?;
        if analysis.is_up_to_date() {
            return Ok(MergeOutcome {
                message: tr!(
                    "「{current}」已經包含「{name}」的所有提交",
                    current = current,
                    name = name
                ),
                before: None,
                conflicts: vec![],
            });
        }
        if analysis.is_fast_forward() {
            let target = repo
                .find_object(theirs_id, Some(ObjectType::Commit))
                .map_err(err)?;
            repo.checkout_tree(&target, Some(CheckoutBuilder::new().safe()))
                .map_err(|e| tr!("合併失敗：{e}", e = e.message()))?;
            let mut head = repo.head().map_err(err)?;
            head.set_target(theirs_id, &format!("merge {name}: fast-forward"))
                .map_err(err)?;
            return Ok(MergeOutcome {
                message: tr!(
                    "已把「{name}」合併進「{current}」（快轉）",
                    name = name,
                    current = current
                ),
                before,
                conflicts: vec![],
            });
        }
        let mut checkout = CheckoutBuilder::new();
        checkout
            .safe()
            .allow_conflicts(true)
            .conflict_style_merge(true);
        repo.merge(&[&annotated], None, Some(&mut checkout))
            .map_err(|e| tr!("合併失敗：{e}", e = e.message()))?;
        set_merge_message(
            &repo,
            &tr!(
                "合併分支「{name}」到「{current}」",
                name = name,
                current = current
            ),
        );
        if repo.index().map_err(err)?.has_conflicts() {
            return Ok(MergeOutcome {
                message: tr!("兩邊改到同一個地方，請逐段處理後按「完成合併」"),
                before,
                conflicts: collect_conflicts(&repo)?,
            });
        }
        (current, before)
    };
    crate::git_flow::merge_finish_at(dir, who)?;
    Ok(MergeOutcome {
        message: tr!(
            "已把「{name}」合併進「{current}」",
            name = name,
            current = current
        ),
        before,
        conflicts: vec![],
    })
}

/// 在記憶體裡算好的結果建立提交，再把工作目錄更新成新的提交（工作目錄沒有未提交的變更）。
fn commit_index(
    repo: &Repository,
    mut index: git2::Index,
    author: &git2::Signature,
    committer: &git2::Signature,
    message: &str,
    head: &Commit,
) -> Result<Oid, String> {
    let tree_id = index.write_tree_to(repo).map_err(err)?;
    if tree_id == head.tree_id() {
        return Err(tr!("目前的分支已經有一樣的內容，沒有需要套用的修改"));
    }
    let tree = repo.find_tree(tree_id).map_err(err)?;
    let oid = repo
        .commit(Some("HEAD"), author, committer, message, &tree, &[head])
        .map_err(err)?;
    repo.checkout_head(Some(CheckoutBuilder::new().force()))
        .map_err(err)?;
    Ok(oid)
}

fn head_commit(repo: &Repository) -> Result<Commit<'_>, String> {
    repo.head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|_| tr!("還沒有任何提交"))
}

/// 撤銷一個提交：建立一個內容相反的新提交（不改寫歷史，已推送的提交也可以撤銷）。
pub fn revert_at(dir: &Path, id: &str, who: Option<&Identity>) -> Result<OpResult, String> {
    let repo = open(dir)?;
    require_clean(&repo)?;
    let head = head_commit(&repo)?;
    let commit = find_commit(&repo, id)?;
    let mainline = if commit.parent_count() > 1 { 1 } else { 0 };
    let index = repo
        .revert_commit(&commit, &head, mainline, None)
        .map_err(err)?;
    if index.has_conflicts() {
        return Err(tr!(
            "無法自動撤銷：之後的提交又改了同一個地方。可以在這個提交的檔案上按「和目前的檔案比較」逐段還原"
        ));
    }
    let sig = signature(&repo, who)?;
    let summary = summary_of(&commit);
    let message = tr!(
        "撤銷「{summary}」\n\n撤銷提交 {id}。",
        summary = summary,
        id = commit.id()
    );
    commit_index(&repo, index, &sig, &sig, &message, &head)?;
    Ok(OpResult {
        message: tr!("已撤銷「{summary}」", summary = summary),
        before: Some(head.id().to_string()),
        after: None,
    })
}

/// 挑選提交：把另一個分支上某個提交的修改，套用到目前的分支（保留原本的作者與說明）。
pub fn cherry_pick_at(dir: &Path, id: &str, who: Option<&Identity>) -> Result<OpResult, String> {
    let repo = open(dir)?;
    require_clean(&repo)?;
    let head = head_commit(&repo)?;
    let commit = find_commit(&repo, id)?;
    if head.id() == commit.id()
        || repo
            .graph_descendant_of(head.id(), commit.id())
            .unwrap_or(false)
    {
        return Err(tr!("目前的分支已經包含這個提交"));
    }
    let mainline = if commit.parent_count() > 1 { 1 } else { 0 };
    let index = repo
        .cherrypick_commit(&commit, &head, mainline, None)
        .map_err(err)?;
    if index.has_conflicts() {
        return Err(tr!("無法自動套用：目前的分支也改了同一個地方"));
    }
    let committer = signature(&repo, who)?;
    let message = commit.message().unwrap_or_default().to_string();
    commit_index(&repo, index, &commit.author(), &committer, &message, &head)?;
    Ok(OpResult {
        message: tr!("已套用「{summary}」", summary = summary_of(&commit)),
        before: Some(head.id().to_string()),
        after: None,
    })
}

/// 退回到某個版本：目前分支指到那個提交，之後的提交拿掉，但檔案內容保留成未提交的變更。
/// 拿掉的提交如果已經推送就不做（不改寫別人已經拿到的歷史）。
pub fn reset_at(dir: &Path, id: &str) -> Result<OpResult, String> {
    let repo = open(dir)?;
    require_clean_state(&repo)?;
    let head = head_commit(&repo)?;
    let target = find_commit(&repo, id)?;
    if head.id() == target.id() {
        return Err(tr!("已經在這個版本"));
    }
    if !repo
        .graph_descendant_of(head.id(), target.id())
        .unwrap_or(false)
    {
        return Err(tr!("只能退回到目前分支上比較早的版本"));
    }
    if let Some(up) = upstream_oid(&repo) {
        let base = repo.merge_base(head.id(), up).ok();
        let safe = base.is_none_or(|b| {
            b == target.id() || repo.graph_descendant_of(target.id(), b).unwrap_or(false)
        });
        if !safe {
            return Err(tr!(
                "要拿掉的提交已經推送到遠端，退回會改寫別人已經拿到的歷史。可以改用「撤銷這個提交」"
            ));
        }
    }
    repo.reset(target.as_object(), ResetType::Mixed, None)
        .map_err(err)?;
    Ok(OpResult {
        message: tr!(
            "已退回到「{summary}」，之後的修改保留成未提交的變更",
            summary = summary_of(&target)
        ),
        before: Some(head.id().to_string()),
        after: Some(target.id().to_string()),
    })
}

/// 修改最後一次提交的說明（還沒推送才可以）。
pub fn amend_message_at(dir: &Path, message: &str) -> Result<OpResult, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err(tr!("請輸入提交說明"));
    }
    let repo = open(dir)?;
    require_clean_state(&repo)?;
    let head = head_commit(&repo)?;
    if is_pushed(&repo, head.id()) {
        return Err(tr!("這個提交已經推送到遠端，不能再修改說明"));
    }
    head.amend(Some("HEAD"), None, None, None, Some(message), None)
        .map_err(err)?;
    Ok(OpResult {
        message: tr!("已修改提交說明"),
        before: Some(head.id().to_string()),
        after: None,
    })
}

/// 復原上一個操作：目前分支回到 `to`。`expect` 是操作後的提交，歷史在那之後又變了就不做。
/// `keep_files` 時保留檔案內容（復原「退回版本」用），否則工作目錄也回到 `to`
/// （這時不能有未提交的變更）。
pub fn undo_at(dir: &Path, to: &str, expect: &str, keep_files: bool) -> Result<String, String> {
    let repo = open(dir)?;
    require_clean_state(&repo)?;
    let head = head_commit(&repo)?;
    if head.id().to_string() != expect {
        return Err(tr!("之後又有新的提交，不能復原"));
    }
    let target = find_commit(&repo, to)?;
    if keep_files {
        repo.reset(target.as_object(), ResetType::Mixed, None)
            .map_err(err)?;
    } else {
        if has_changes(&repo)? {
            return Err(tr!("還有未提交的變更，不能復原"));
        }
        repo.reset(target.as_object(), ResetType::Hard, None)
            .map_err(err)?;
    }
    Ok(tr!("已復原"))
}

// ---- 前端呼叫 ----------------------------------------------------------------

fn root(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.state::<Workspace>()
        .root()
        .ok_or_else(|| tr!("還沒有開啟資料夾"))
}

/// 前端傳來的檔案絕對路徑，換成儲存庫裡的相對路徑。
fn repo_rel(dir: &Path, path: &str) -> Result<String, String> {
    let repo = open(dir)?;
    crate::git_files::rel_path(&repo, Path::new(path))
}

#[tauri::command]
pub async fn git_log(
    app: AppHandle,
    skip: usize,
    limit: usize,
    all: bool,
    path: Option<String>,
    text: Option<String>,
) -> Result<LogPage, String> {
    let dir = root(&app)?;
    crate::io::blocking(move || {
        let rel = path.map(|p| repo_rel(&dir, &p)).transpose()?;
        log_at(&dir, skip, limit, all, rel.as_deref(), text.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn git_commit_detail(app: AppHandle, id: String) -> Result<CommitDetail, String> {
    let dir = root(&app)?;
    crate::io::blocking(move || detail_at(&dir, &id)).await
}

#[tauri::command]
pub async fn git_compare(app: AppHandle, from: String, to: String) -> Result<ChangeList, String> {
    let dir = root(&app)?;
    crate::io::blocking(move || compare_at(&dir, &from, &to)).await
}

#[tauri::command]
pub async fn git_worktree_changes(app: AppHandle) -> Result<ChangeList, String> {
    let dir = root(&app)?;
    crate::io::blocking(move || worktree_changes_at(&dir)).await
}

#[tauri::command]
pub async fn git_file_pair(
    app: AppHandle,
    from: Option<String>,
    to: Option<String>,
    path: String,
    old_path: Option<String>,
) -> Result<FilePair, String> {
    let dir = root(&app)?;
    crate::io::blocking(move || {
        file_pair_at(
            &dir,
            from.as_deref(),
            to.as_deref(),
            &path,
            old_path.as_deref(),
        )
    })
    .await
}

/// 儲存庫裡的相對路徑換成磁碟上的絕對路徑（在編輯器開啟檔案用）。
#[tauri::command]
pub async fn git_abs_path(app: AppHandle, path: String) -> Result<String, String> {
    let dir = root(&app)?;
    crate::io::blocking(move || {
        let repo = open(&dir)?;
        let abs = workdir(&repo)?.join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
        Ok(crate::files::path_string(&abs))
    })
    .await
}

#[tauri::command]
pub async fn git_stats(app: AppHandle) -> Result<Vec<StatCommit>, String> {
    let dir = root(&app)?;
    let now = chrono::Utc::now().timestamp();
    crate::io::blocking(move || stats_at(&dir, now)).await
}

#[tauri::command]
pub async fn git_branch_at(
    app: AppHandle,
    id: String,
    name: String,
    checkout: bool,
) -> Result<OpResult, String> {
    let dir = root(&app)?;
    crate::io::blocking(move || branch_at(&dir, &id, &name, checkout)).await
}

#[tauri::command]
pub async fn git_delete_branch(app: AppHandle, name: String) -> Result<String, String> {
    let dir = root(&app)?;
    crate::io::blocking(move || delete_branch_at(&dir, &name)).await
}

#[tauri::command]
pub async fn git_tag(
    app: AppHandle,
    id: String,
    name: String,
    message: String,
) -> Result<String, String> {
    let dir = root(&app)?;
    let who = crate::git::identity_for(&app, &dir);
    crate::io::blocking(move || tag_at(&dir, &id, &name, &message, who.as_ref())).await
}

#[tauri::command]
pub async fn git_delete_tag(app: AppHandle, name: String) -> Result<String, String> {
    let dir = root(&app)?;
    crate::io::blocking(move || delete_tag_at(&dir, &name)).await
}

#[tauri::command]
pub async fn git_merge_branch(app: AppHandle, name: String) -> Result<MergeOutcome, String> {
    let dir = root(&app)?;
    let who = crate::git::identity_for(&app, &dir);
    crate::io::blocking(move || merge_branch_at(&dir, &name, who.as_ref())).await
}

#[tauri::command]
pub async fn git_revert(app: AppHandle, id: String) -> Result<OpResult, String> {
    let dir = root(&app)?;
    let who = crate::git::identity_for(&app, &dir);
    crate::io::blocking(move || revert_at(&dir, &id, who.as_ref())).await
}

#[tauri::command]
pub async fn git_cherry_pick(app: AppHandle, id: String) -> Result<OpResult, String> {
    let dir = root(&app)?;
    let who = crate::git::identity_for(&app, &dir);
    crate::io::blocking(move || cherry_pick_at(&dir, &id, who.as_ref())).await
}

#[tauri::command]
pub async fn git_reset(app: AppHandle, id: String) -> Result<OpResult, String> {
    let dir = root(&app)?;
    crate::io::blocking(move || reset_at(&dir, &id)).await
}

#[tauri::command]
pub async fn git_amend_message(app: AppHandle, message: String) -> Result<OpResult, String> {
    let dir = root(&app)?;
    crate::io::blocking(move || amend_message_at(&dir, &message)).await
}

#[tauri::command]
pub async fn git_undo(
    app: AppHandle,
    to: String,
    expect: String,
    keep_files: bool,
) -> Result<String, String> {
    let dir = root(&app)?;
    crate::io::blocking(move || undo_at(&dir, &to, &expect, keep_files)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn me() -> Identity {
        Identity {
            name: "測試".into(),
            email: "t@example.com".into(),
        }
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("md-log-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(&dir).unwrap()
    }

    fn init(dir: &Path) -> Repository {
        let mut opts = git2::RepositoryInitOptions::new();
        opts.initial_head("main");
        Repository::init_opts(dir, &opts).unwrap()
    }

    fn write_commit(dir: &Path, file: &str, text: &str, msg: &str) -> String {
        fs::write(dir.join(file), text).unwrap();
        crate::git::commit_at(dir, msg, Some(&me())).unwrap();
        head_oid(&Repository::open(dir).unwrap())
            .unwrap()
            .to_string()
    }

    fn read(path: std::path::PathBuf) -> String {
        fs::read_to_string(path).unwrap().replace("\r\n", "\n")
    }

    /// main：初始 → 第二版；草稿分支從初始分出來，改了另一個檔案。
    fn branched(name: &str) -> (std::path::PathBuf, String) {
        let dir = temp(name);
        init(&dir);
        write_commit(&dir, "a.md", "一\n", "初始");
        crate::git_flow::create_branch_at(&dir, "草稿").unwrap();
        let draft = write_commit(&dir, "b.md", "草稿\n", "草稿內容");
        crate::git_flow::checkout_at(&dir, "main").unwrap();
        write_commit(&dir, "a.md", "一\n二\n", "第二版");
        (dir, draft)
    }

    #[test]
    fn lists_all_branches_with_parents_and_refs() {
        let (dir, draft) = branched("list");
        let page = log_at(&dir, 0, 50, true, None, None).unwrap();
        assert_eq!(page.commits.len(), 3);
        assert!(!page.more);
        let top = &page.commits[0];
        assert_eq!(page.head.as_deref(), Some(top.id.as_str()));
        assert!(top
            .refs
            .iter()
            .any(|r| r.kind == RefKind::Head && r.name == "main"));
        let d = page.commits.iter().find(|c| c.id == draft).unwrap();
        assert!(d
            .refs
            .iter()
            .any(|r| r.kind == RefKind::Branch && r.name == "草稿"));
        // 只看目前分支時沒有草稿的提交。
        let only = log_at(&dir, 0, 50, false, None, None).unwrap();
        assert_eq!(only.commits.len(), 2);
        // 分頁。
        let first = log_at(&dir, 0, 1, true, None, None).unwrap();
        assert!(first.more);
        let second = log_at(&dir, 1, 1, true, None, None).unwrap();
        assert_ne!(first.commits[0].id, second.commits[0].id);
        // 篩選。
        assert_eq!(
            log_at(&dir, 0, 50, true, Some("b.md"), None)
                .unwrap()
                .commits
                .len(),
            1
        );
        assert_eq!(
            log_at(&dir, 0, 50, true, None, Some("第二"))
                .unwrap()
                .commits
                .len(),
            1
        );
    }

    #[test]
    fn shows_details_and_file_versions() {
        let (dir, _) = branched("detail");
        let head = log_at(&dir, 0, 1, false, None, None)
            .unwrap()
            .commits
            .remove(0);
        let d = detail_at(&dir, &head.id).unwrap();
        assert_eq!(d.message, "第二版");
        assert_eq!(d.changes.files.len(), 1);
        let f = &d.changes.files[0];
        assert_eq!(
            (f.path.as_str(), f.status, f.additions, f.deletions),
            ("a.md", FileChange::Modified, 1, 0)
        );
        let pair = file_pair_at(&dir, None, Some(&head.id), "a.md", None).unwrap();
        assert_eq!(
            pair.before.as_deref().map(|s| s.replace("\r\n", "\n")),
            Some("一\n".into())
        );
        assert_eq!(
            pair.after.as_deref().map(|s| s.replace("\r\n", "\n")),
            Some("一\n二\n".into())
        );
        fs::write(dir.join("c.md"), "新\n").unwrap();
        let w = worktree_changes_at(&dir).unwrap();
        assert_eq!(w.files[0].status, FileChange::Added);
        let pair = file_pair_at(&dir, None, None, "c.md", None).unwrap();
        assert_eq!((pair.before, pair.after.as_deref()), (None, Some("新\n")));
        assert_eq!(
            stats_at(&dir, chrono::Utc::now().timestamp())
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn merges_branches_and_undoes() {
        let (dir, _) = branched("merge");
        let out = merge_branch_at(&dir, "草稿", Some(&me())).unwrap();
        assert!(out.conflicts.is_empty());
        assert!(dir.join("b.md").exists());
        let repo = Repository::open(&dir).unwrap();
        let head = head_commit(&repo).unwrap();
        assert_eq!(head.parent_count(), 2);
        assert_eq!(head.message().unwrap().trim(), "合併分支「草稿」到「main」");
        let after = head.id().to_string();
        drop(head);
        drop(repo);
        undo_at(&dir, out.before.as_deref().unwrap(), &after, false).unwrap();
        assert!(!dir.join("b.md").exists());
        // 從比較早的提交建立分支，再合併 main：快轉。
        let first = log_at(&dir, 0, 10, false, None, None)
            .unwrap()
            .commits
            .pop()
            .unwrap()
            .id;
        branch_at(&dir, &first, "舊", true).unwrap();
        let ff = merge_branch_at(&dir, "main", Some(&me())).unwrap();
        assert!(ff.message.contains("快轉"));
        assert_eq!(read(dir.join("a.md")), "一\n二\n");
        let again = merge_branch_at(&dir, "main", Some(&me())).unwrap();
        assert!(again.before.is_none());
    }

    #[test]
    fn reverts_cherry_picks_and_resets_safely() {
        let (dir, draft) = branched("ops");
        let second = log_at(&dir, 0, 1, false, None, None)
            .unwrap()
            .commits
            .remove(0)
            .id;
        revert_at(&dir, &second, Some(&me())).unwrap();
        assert_eq!(read(dir.join("a.md")), "一\n");
        cherry_pick_at(&dir, &draft, Some(&me())).unwrap();
        assert_eq!(read(dir.join("b.md")), "草稿\n");
        assert!(cherry_pick_at(&dir, &draft, Some(&me())).is_err());
        // 退回到第二版：之後的兩個提交拿掉，檔案內容保留。
        let out = reset_at(&dir, &second).unwrap();
        assert_eq!(read(dir.join("b.md")), "草稿\n");
        let repo = Repository::open(&dir).unwrap();
        assert_eq!(head_oid(&repo).unwrap().to_string(), second);
        assert!(has_changes(&repo).unwrap());
        drop(repo);
        undo_at(&dir, out.before.as_deref().unwrap(), &second, true).unwrap();
        assert!(!has_changes(&Repository::open(&dir).unwrap()).unwrap());
        // 修改最後一次的說明。
        amend_message_at(&dir, "改過的說明").unwrap();
        let repo = Repository::open(&dir).unwrap();
        assert_eq!(head_commit(&repo).unwrap().message().unwrap(), "改過的說明");
    }

    #[test]
    fn refuses_to_rewrite_pushed_history() {
        let origin = temp("pushed-origin");
        init(&origin);
        let first = write_commit(&origin, "a.md", "一\n", "初始");
        write_commit(&origin, "a.md", "一\n二\n", "第二版");
        let local = temp("pushed-local");
        let _ = fs::remove_dir_all(&local);
        Repository::clone(origin.to_str().unwrap(), &local).unwrap();
        assert!(reset_at(&local, &first).is_err());
        assert!(amend_message_at(&local, "改").is_err());
        // 本機新的提交還沒推送：可以退回、可以改說明。
        write_commit(&local, "a.md", "一\n二\n三\n", "本機");
        assert!(amend_message_at(&local, "改").is_ok());
        let page = log_at(&local, 0, 10, true, None, None).unwrap();
        assert!(page.commits[0].unpushed);
        assert!(page.commits[0].refs.iter().any(|r| r.kind == RefKind::Head));
        assert!(page.commits[1]
            .refs
            .iter()
            .any(|r| r.kind == RefKind::Remote && r.name == "origin/main"));
    }

    #[test]
    fn creates_branches_and_tags() {
        let (dir, draft) = branched("refs");
        let out = branch_at(&dir, &draft, "新分支", true).unwrap();
        assert_eq!(out.before.as_deref(), Some("main"));
        assert!(dir.join("b.md").exists());
        assert!(branch_at(&dir, &draft, "新分支", false).is_err());
        assert!(delete_branch_at(&dir, "新分支").is_err());
        crate::git_flow::checkout_at(&dir, "main").unwrap();
        delete_branch_at(&dir, "新分支").unwrap();
        tag_at(&dir, &draft, "v1.0", "", Some(&me())).unwrap();
        tag_at(&dir, &draft, "v1.1", "第一版", Some(&me())).unwrap();
        assert!(tag_at(&dir, &draft, "v1.0", "", Some(&me())).is_err());
        let page = log_at(&dir, 0, 10, true, None, None).unwrap();
        let d = page.commits.iter().find(|c| c.id == draft).unwrap();
        assert_eq!(d.refs.iter().filter(|r| r.kind == RefKind::Tag).count(), 2);
        delete_tag_at(&dir, "v1.0").unwrap();
    }
}
