//! 單一檔案的 Git 功能：提交歷史、某次提交時的內容，以及在 GitHub／Azure DevOps 網頁上的網址。

use std::path::{Path, PathBuf};

use git2::{Oid, Repository, Sort};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::workspace::{resolve_inside, Workspace};

/// 最多列出幾個提交；最多往回找幾個提交（很大的儲存庫不會卡住）。
const MAX_RESULTS: usize = 200;
const MAX_SCAN: usize = 20_000;

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileCommit {
    id: String,
    short: String,
    summary: String,
    author: String,
    /// Unix 秒。
    time: i64,
}

fn open_for(file: &Path) -> Result<(Repository, String), String> {
    let dir = file.parent().ok_or_else(|| tr!("路徑不正確"))?;
    let repo = Repository::discover(dir).map_err(|_| tr!("這個檔案不在 Git 儲存庫裡"))?;
    let rel = rel_path(&repo, file)?;
    Ok((repo, rel))
}

/// 檔案在儲存庫裡的相對路徑（用 `/` 分隔）。
fn rel_path(repo: &Repository, file: &Path) -> Result<String, String> {
    let root = repo
        .workdir()
        .ok_or_else(|| tr!("這個儲存庫沒有工作目錄"))?;
    let root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    // 檔案可能已經被刪除：用資料夾解析實際位置再接上檔名。
    let file = match dunce::canonicalize(file) {
        Ok(p) => p,
        Err(_) => {
            let parent = file.parent().ok_or_else(|| tr!("路徑不正確"))?;
            dunce::canonicalize(parent)
                .map_err(|e| e.to_string())?
                .join(file.file_name().ok_or_else(|| tr!("路徑不正確"))?)
        }
    };
    let rel = file
        .strip_prefix(&root)
        .map_err(|_| tr!("這個檔案不在 Git 儲存庫裡"))?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

fn blob_at(commit: &git2::Commit, rel: &str) -> Option<Oid> {
    commit
        .tree()
        .ok()?
        .get_path(Path::new(rel))
        .ok()
        .map(|e| e.id())
}

/// 改過這個檔案的提交（最近的在前面）。
pub fn history_at(file: &Path) -> Result<Vec<FileCommit>, String> {
    let (repo, rel) = open_for(file)?;
    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    walk.set_sorting(Sort::TIME).ok();
    if walk.push_head().is_err() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for oid in walk.filter_map(Result::ok).take(MAX_SCAN) {
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };
        let now = blob_at(&commit, &rel);
        let before = commit.parent(0).ok().and_then(|p| blob_at(&p, &rel));
        if now == before {
            continue;
        }
        let id = oid.to_string();
        out.push(FileCommit {
            short: id[..7].to_string(),
            id,
            summary: commit
                .summary()
                .ok()
                .flatten()
                .unwrap_or_default()
                .to_string(),
            author: commit.author().name().unwrap_or_default().to_string(),
            time: commit.time().seconds(),
        });
        if out.len() >= MAX_RESULTS {
            break;
        }
    }
    Ok(out)
}

/// 檔案在某次提交時的內容。
pub fn file_at(file: &Path, id: &str) -> Result<String, String> {
    let (repo, rel) = open_for(file)?;
    let oid = Oid::from_str(id).map_err(|_| tr!("提交編號不正確"))?;
    let commit = repo.find_commit(oid).map_err(|_| tr!("找不到這個提交"))?;
    let blob = blob_at(&commit, &rel)
        .and_then(|b| repo.find_blob(b).ok())
        .ok_or_else(|| tr!("這個版本沒有這個檔案"))?;
    let bytes = blob.content();
    if let Some(why) = crate::files::not_text_reason(bytes) {
        return Err(tr!("這個版本的檔案{why}", why = why));
    }
    Ok(crate::files::decode(bytes).0)
}

// ---- 網頁上的網址 -----------------------------------------------------------

/// 網址的一段：保留英數字與 `-._~`，其餘轉成 %XX（路徑分隔的 `/` 另外處理）。
pub(crate) fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn encode_path(rel: &str) -> String {
    rel.split('/').map(encode).collect::<Vec<_>>().join("/")
}

/// 去掉網址裡的帳號密碼（`https://user:token@host/…`）與結尾的 `.git`、`/`。
fn clean_remote(url: &str) -> String {
    let url = url.trim().trim_end_matches('/');
    let url = url.strip_suffix(".git").unwrap_or(url);
    match url.split_once("://") {
        Some((scheme, rest)) => {
            let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
            let host = host.rsplit('@').next().unwrap_or(host);
            if path.is_empty() {
                format!("{scheme}://{host}")
            } else {
                format!("{scheme}://{host}/{path}")
            }
        }
        None => url.to_string(),
    }
}

/// GitHub 遠端的擁有者與儲存庫名稱。
pub fn github_repo(remote: &str) -> Option<(String, String)> {
    let clean = clean_remote(remote);
    let rest = clean
        .strip_prefix("https://github.com/")
        .or_else(|| clean.strip_prefix("http://github.com/"))?;
    let mut parts = rest.split('/');
    let owner = parts.next().filter(|s| !s.is_empty())?;
    let name = parts.next().filter(|s| !s.is_empty())?;
    Some((owner.to_string(), name.to_string()))
}

/// 檔案在網頁上的網址；`lines` 是要標示的行（從 1 開始）。
pub fn web_url(remote: &str, branch: &str, rel: &str, lines: Option<(u32, u32)>) -> Option<String> {
    if let Some((owner, name)) = github_repo(remote) {
        let anchor = match lines {
            Some((a, b)) if b > a => format!("#L{a}-L{b}"),
            Some((a, _)) => format!("#L{a}"),
            None => String::new(),
        };
        return Some(format!(
            "https://github.com/{owner}/{name}/blob/{}/{}{anchor}",
            encode_path(branch),
            encode_path(rel)
        ));
    }
    let clean = clean_remote(remote);
    // Azure DevOps：儲存庫的網址就是網頁的網址（…/專案/_git/儲存庫）。
    if clean.contains("/_git/") {
        let mut url = format!(
            "{clean}?path={}&version=GB{}&_a=contents",
            encode(&format!("/{rel}")),
            encode(branch)
        );
        if let Some((a, b)) = lines {
            url.push_str(&format!(
                "&line={a}&lineEnd={}&lineStartColumn=1&lineEndColumn=1&lineStyle=plain",
                b.max(a) + 1
            ));
        }
        return Some(url);
    }
    None
}

fn branch_name(repo: &Repository) -> String {
    repo.head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().ok().map(str::to_string))
        .unwrap_or_else(|| "main".into())
}

fn link_at(file: &Path, lines: Option<(u32, u32)>) -> Result<String, String> {
    let (repo, rel) = open_for(file)?;
    let remote = repo
        .find_remote("origin")
        .ok()
        .and_then(|r| r.url().ok().map(str::to_string))
        .ok_or_else(|| tr!("這個資料夾還沒有連到 GitHub 或 Azure DevOps"))?;
    web_url(&remote, &branch_name(&repo), &rel, lines)
        .ok_or_else(|| tr!("目前只支援 GitHub 與 Azure DevOps 上的儲存庫"))
}

// ---- 前端呼叫 ----------------------------------------------------------------

/// 只處理目前開啟的資料夾裡的檔案。
fn checked(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let root = app
        .state::<Workspace>()
        .root()
        .ok_or_else(|| tr!("請先開啟檔案所在的資料夾"))?;
    resolve_inside(&root, Path::new(path))
}

#[tauri::command]
pub async fn git_file_history(app: AppHandle, path: String) -> Result<Vec<FileCommit>, String> {
    let file = checked(&app, &path)?;
    crate::io::blocking(move || history_at(&file)).await
}

#[tauri::command]
pub async fn git_file_at(app: AppHandle, path: String, id: String) -> Result<String, String> {
    let file = checked(&app, &path)?;
    crate::io::blocking(move || file_at(&file, &id)).await
}

#[tauri::command]
pub async fn git_web_url(
    app: AppHandle,
    path: String,
    from: Option<u32>,
    to: Option<u32>,
) -> Result<String, String> {
    let file = checked(&app, &path)?;
    let lines = from.map(|a| (a, to.unwrap_or(a)));
    crate::io::blocking(move || link_at(&file, lines)).await
}

/// 目前開啟的資料夾連到的 GitHub 儲存庫（擁有者、名稱）。
pub fn workspace_github_repo(app: &AppHandle) -> Result<(String, String), String> {
    let root = app
        .state::<Workspace>()
        .root()
        .ok_or_else(|| tr!("請先開啟連到 GitHub 的資料夾"))?;
    let repo = Repository::discover(&root).map_err(|_| tr!("這個資料夾不是 Git 儲存庫"))?;
    let remote = repo
        .find_remote("origin")
        .ok()
        .and_then(|r| r.url().ok().map(str::to_string))
        .ok_or_else(|| tr!("這個資料夾還沒有連到 GitHub"))?;
    github_repo(&remote).ok_or_else(|| tr!("這個資料夾不是連到 GitHub 的儲存庫"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parses_github_remotes() {
        assert_eq!(
            github_repo("https://github.com/omni/notes.git"),
            Some(("omni".into(), "notes".into()))
        );
        assert_eq!(
            github_repo("https://x-access-token:abc@github.com/omni/notes/"),
            Some(("omni".into(), "notes".into()))
        );
        assert_eq!(github_repo("https://gitlab.com/a/b"), None);
    }

    #[test]
    fn builds_github_links_with_lines() {
        let r = "https://github.com/omni/notes.git";
        assert_eq!(
            web_url(r, "main", "筆記/週報.md", Some((3, 7))).unwrap(),
            "https://github.com/omni/notes/blob/main/%E7%AD%86%E8%A8%98/%E9%80%B1%E5%A0%B1.md#L3-L7"
        );
        assert_eq!(
            web_url(r, "main", "a b.md", Some((5, 5))).unwrap(),
            "https://github.com/omni/notes/blob/main/a%20b.md#L5"
        );
        assert!(web_url(r, "main", "a.md", None)
            .unwrap()
            .ends_with("/blob/main/a.md"));
    }

    #[test]
    fn builds_ado_links() {
        let url = web_url(
            "https://ming@tfs.corp.com/tfs/DC/產品/_git/web",
            "main",
            "docs/a.md",
            Some((2, 4)),
        )
        .unwrap();
        assert!(url.starts_with(
            "https://tfs.corp.com/tfs/DC/產品/_git/web?path=%2Fdocs%2Fa.md&version=GBmain"
        ));
        assert!(url.contains("&line=2&lineEnd=5"));
        assert_eq!(
            web_url("https://gitlab.com/a/b.git", "main", "a.md", None),
            None
        );
    }

    fn sig() -> git2::Signature<'static> {
        git2::Signature::now("測試", "t@example.com").unwrap()
    }

    fn commit_file(repo: &Repository, dir: &Path, name: &str, text: &str, msg: &str) {
        fs::write(dir.join(name), text).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(name)).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig(), &sig(), msg, &tree, &parents)
            .unwrap();
    }

    #[test]
    fn lists_only_commits_that_touched_the_file() {
        let dir = std::env::temp_dir().join(format!("md-git-files-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let dir = dunce::canonicalize(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();
        commit_file(&repo, &dir, "a.md", "一\n", "新增 a");
        commit_file(&repo, &dir, "b.md", "乙\n", "新增 b");
        commit_file(&repo, &dir, "a.md", "一\n二\n", "修改 a");
        let list = history_at(&dir.join("a.md")).unwrap();
        let summaries: Vec<_> = list.iter().map(|c| c.summary.as_str()).collect();
        assert_eq!(summaries, ["修改 a", "新增 a"]);
        assert_eq!(file_at(&dir.join("a.md"), &list[1].id).unwrap(), "一\n");
        assert!(file_at(&dir.join("b.md"), &list[1].id).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
