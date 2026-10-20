//! Git 整合：呼叫系統安裝的 `git`（沿用使用者既有的帳號與認證設定）。找不到 git 時整個功能隱藏。
//!
//! 安全原則：
//! - 所有操作都在目前開啟的資料夾（工作區）裡進行，參數直接傳給 git，不經過殼層。
//! - 拉取時有未提交的變更就不做；能快轉就快轉，否則改用 rebase，遇到衝突立刻取消（`rebase --abort`），
//!   不會自動合併掉任何內容。
//! - 關閉終端機提示（`GIT_TERMINAL_PROMPT=0`），需要密碼時不會卡住。

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::files::path_string;
use crate::workspace::Workspace;

/// 拉取、推送可能需要等使用者在認證視窗登入。
const NETWORK_TIMEOUT: Duration = Duration::from_secs(300);

fn git_command(dir: &Path) -> Result<Command, String> {
    let exe = which::which("git")
        .map_err(|_| "找不到 Git。請先安裝 Git（https://git-scm.com）。".to_string())?;
    let mut cmd = Command::new(exe);
    cmd.current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        // 輸出固定用英文，方便解析；給使用者看的訊息由這裡翻譯。
        .env("LC_ALL", "C")
        .env("LANG", "C");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    Ok(cmd)
}

fn run(dir: &Path, args: &[&str]) -> Result<Output, String> {
    git_command(dir)?
        .args(args)
        .output()
        .map_err(|e| format!("無法執行 git：{e}"))
}

/// 執行 git，失敗時回傳 git 的錯誤訊息。
fn run_ok(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = run(dir, args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = err.trim();
        Err(if msg.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            msg.to_string()
        })
    }
}

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
    /// 電腦上有沒有 git。
    available: bool,
    /// 工作區是不是 Git 儲存庫。
    repo: bool,
    branch: Option<Branch>,
    changes: Vec<Change>,
}

/// 由 `XY` 狀態碼判斷檔案狀態（已暫存與未暫存合併來看）。
fn classify(xy: &str) -> FileStatus {
    let (x, y) = (
        xy.chars().next().unwrap_or('.'),
        xy.chars().nth(1).unwrap_or('.'),
    );
    if x == 'D' || y == 'D' {
        FileStatus::Deleted
    } else if x == 'A' {
        FileStatus::Added
    } else if x == 'R' || x == 'C' {
        FileStatus::Renamed
    } else {
        FileStatus::Modified
    }
}

/// 解析 `git status --porcelain=v2 --branch -z`。路徑是相對於儲存庫根目錄的。
fn parse_status(out: &str, repo_root: &Path) -> (Branch, Vec<Change>) {
    let mut branch = Branch::default();
    let mut changes = Vec::new();
    let mut fields = out.split('\0').peekable();
    let abs =
        |rel: &str| path_string(&repo_root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR)));
    while let Some(entry) = fields.next() {
        if let Some(header) = entry.strip_prefix("# ") {
            if let Some(name) = header.strip_prefix("branch.head ") {
                branch.name = name.to_string();
            } else if let Some(up) = header.strip_prefix("branch.upstream ") {
                branch.upstream = Some(up.to_string());
            } else if let Some(ab) = header.strip_prefix("branch.ab ") {
                let mut it = ab.split(' ');
                branch.ahead = it
                    .next()
                    .and_then(|a| a.trim_start_matches('+').parse().ok())
                    .unwrap_or(0);
                branch.behind = it
                    .next()
                    .and_then(|b| b.trim_start_matches('-').parse().ok())
                    .unwrap_or(0);
            }
            continue;
        }
        let mut parts = entry.splitn(2, ' ');
        let kind = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");
        match kind {
            // 1 XY sub mH mI mW hH hI path
            "1" => {
                let f: Vec<&str> = rest.splitn(8, ' ').collect();
                if f.len() == 8 {
                    changes.push(Change {
                        path: abs(f[7]),
                        status: classify(f[0]),
                    });
                }
            }
            // 2 XY sub mH mI mW hH hI Xscore path，接著一個 NUL 分隔的原路徑
            "2" => {
                let f: Vec<&str> = rest.splitn(9, ' ').collect();
                fields.next(); // 原路徑
                if f.len() == 9 {
                    changes.push(Change {
                        path: abs(f[8]),
                        status: FileStatus::Renamed,
                    });
                }
            }
            // u XY sub m1 m2 m3 mW h1 h2 h3 path
            "u" => {
                if let Some(path) = rest.splitn(10, ' ').nth(9) {
                    changes.push(Change {
                        path: abs(path),
                        status: FileStatus::Conflicted,
                    });
                }
            }
            "?" => changes.push(Change {
                path: abs(rest),
                status: FileStatus::Untracked,
            }),
            _ => {}
        }
    }
    (branch, changes)
}

fn repo_root(dir: &Path) -> Option<PathBuf> {
    let out = run_ok(dir, &["rev-parse", "--show-toplevel"]).ok()?;
    let root = PathBuf::from(out.trim());
    Some(dunce::canonicalize(&root).unwrap_or(root))
}

fn workspace_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.state::<Workspace>()
        .root()
        .ok_or_else(|| "還沒有開啟資料夾".to_string())
}

pub fn status_at(dir: &Path) -> Status {
    if which::which("git").is_err() {
        return Status {
            available: false,
            repo: false,
            branch: None,
            changes: vec![],
        };
    }
    let Some(root) = repo_root(dir) else {
        return Status {
            available: true,
            repo: false,
            branch: None,
            changes: vec![],
        };
    };
    match run_ok(
        dir,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
    ) {
        Ok(out) => {
            let (branch, changes) = parse_status(&out, &root);
            Status {
                available: true,
                repo: true,
                branch: Some(branch),
                changes,
            }
        }
        Err(_) => Status {
            available: true,
            repo: true,
            branch: None,
            changes: vec![],
        },
    }
}

#[tauri::command]
pub async fn git_status(app: AppHandle) -> Result<Status, String> {
    let dir = workspace_root(&app)?;
    crate::io::blocking(move || Ok(status_at(&dir))).await
}

/// 提交工作區資料夾內的所有變更。
pub fn commit_at(dir: &Path, message: &str) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("請輸入提交說明".into());
    }
    run_ok(dir, &["add", "--all", "--", "."])?;
    if run_ok(dir, &["diff", "--cached", "--quiet"]).is_ok() {
        return Err("沒有需要提交的變更".into());
    }
    run_ok(dir, &["commit", "--quiet", "-m", message]).map_err(|e| {
        if e.contains("Please tell me who you are") || e.contains("user.email") {
            "Git 還不知道你的名字與 Email，請先在終端機執行：git config --global user.name \"你的名字\" 與 git config --global user.email \"你的 Email\"".into()
        } else {
            format!("提交失敗：{e}")
        }
    })?;
    let summary = run_ok(dir, &["log", "-1", "--format=%h %s"])?;
    Ok(summary.trim().to_string())
}

#[tauri::command]
pub async fn git_commit(app: AppHandle, message: String) -> Result<String, String> {
    let dir = workspace_root(&app)?;
    crate::io::blocking(move || commit_at(&dir, &message)).await
}

fn rebase_in_progress(dir: &Path) -> bool {
    run_ok(dir, &["rev-parse", "--git-path", "rebase-merge"])
        .into_iter()
        .chain(run_ok(dir, &["rev-parse", "--git-path", "rebase-apply"]))
        .any(|p| {
            let p = PathBuf::from(p.trim());
            (if p.is_absolute() { p } else { dir.join(p) }).exists()
        })
}

/// 拉取遠端的新提交。有未提交的變更時不做；遇到衝突時取消，不留下半套的結果。
pub fn pull_at(dir: &Path) -> Result<String, String> {
    let dirty = run_ok(dir, &["status", "--porcelain"])?;
    if !dirty.trim().is_empty() {
        return Err("還有未提交的變更，請先提交再拉取".into());
    }
    let before = run_ok(dir, &["rev-parse", "HEAD"])?;
    if run_ok(dir, &["pull", "--ff-only", "--quiet"]).is_err() {
        // 兩邊都有新提交：改用 rebase 把本機的提交接在遠端之後；有衝突就取消。
        if let Err(e) = run_ok(dir, &["pull", "--rebase", "--quiet"]) {
            if rebase_in_progress(dir) {
                let _ = run_ok(dir, &["rebase", "--abort"]);
                return Err("遠端和本機改到了同樣的地方，發生衝突。已經取消拉取，檔案都維持原樣；請用其他 Git 工具處理衝突。".into());
            }
            return Err(network_message(&e, "拉取"));
        }
    }
    let after = run_ok(dir, &["rev-parse", "HEAD"])?;
    if before == after {
        Ok("已經是最新的".into())
    } else {
        let count = run_ok(
            dir,
            &[
                "rev-list",
                "--count",
                &format!("{}..{}", before.trim(), after.trim()),
            ],
        )
        .unwrap_or_default();
        Ok(format!("已拉取 {} 個新的提交", count.trim()))
    }
}

fn network_message(e: &str, what: &str) -> String {
    if e.contains("could not read Username")
        || e.contains("Authentication failed")
        || e.contains("terminal prompts disabled")
    {
        format!(
            "{what}失敗：需要登入遠端儲存庫。請先在終端機執行一次 git {}，完成登入後再試。",
            if what == "拉取" { "pull" } else { "push" }
        )
    } else if e.contains("no tracking information")
        || e.contains("has no upstream")
        || e.contains("No configured push destination")
    {
        format!("{what}失敗：這個分支還沒有設定遠端（upstream）。請先在終端機執行一次 git push -u origin 分支名稱。")
    } else if e.contains("Could not resolve host") || e.contains("unable to access") {
        format!("{what}失敗：無法連線到遠端儲存庫（{e}）")
    } else {
        format!("{what}失敗：{e}")
    }
}

pub fn push_at(dir: &Path) -> Result<String, String> {
    run_ok(dir, &["push", "--quiet"]).map_err(|e| {
        if e.contains("rejected") || e.contains("fetch first") || e.contains("non-fast-forward") {
            "遠端有你還沒拉取的提交，請先拉取再推送".into()
        } else {
            network_message(&e, "推送")
        }
    })?;
    Ok("已推送".into())
}

#[tauri::command]
pub async fn git_pull(app: AppHandle) -> Result<String, String> {
    let dir = workspace_root(&app)?;
    crate::io::blocking_for(NETWORK_TIMEOUT, move || pull_at(&dir)).await
}

#[tauri::command]
pub async fn git_push(app: AppHandle) -> Result<String, String> {
    let dir = workspace_root(&app)?;
    crate::io::blocking_for(NETWORK_TIMEOUT, move || push_at(&dir)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git(dir: &Path, args: &[&str]) {
        let out = git_command(dir).unwrap().args(args).output().unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("md-git-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(&dir).unwrap()
    }

    fn init(dir: &Path) {
        git(dir, &["init", "--quiet", "-b", "main"]);
        git(dir, &["config", "user.name", "測試"]);
        git(dir, &["config", "user.email", "test@example.com"]);
    }

    #[test]
    fn parses_porcelain_v2() {
        let root = Path::new("/repo");
        let out = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
                   1 .M N... 100644 100644 100644 a b 筆記/週報.md\0\
                   1 A. N... 000000 100644 100644 a b 新.md\0\
                   2 R. N... 100644 100644 100644 a b R100 新名.md\0舊名.md\0\
                   u UU N... 100644 100644 100644 100644 a b c 衝突.md\0\
                   ? 未追蹤 檔案.md\0";
        let (branch, changes) = parse_status(out, root);
        assert_eq!(
            branch,
            Branch {
                name: "main".into(),
                upstream: Some("origin/main".into()),
                ahead: 2,
                behind: 1
            }
        );
        let got: Vec<(String, FileStatus)> = changes
            .iter()
            .map(|c| (c.path.replace('\\', "/"), c.status))
            .collect();
        assert_eq!(
            got,
            vec![
                ("/repo/筆記/週報.md".into(), FileStatus::Modified),
                ("/repo/新.md".into(), FileStatus::Added),
                ("/repo/新名.md".into(), FileStatus::Renamed),
                ("/repo/衝突.md".into(), FileStatus::Conflicted),
                ("/repo/未追蹤 檔案.md".into(), FileStatus::Untracked),
            ]
        );
    }

    #[test]
    fn commit_pull_push_round_trip() {
        if which::which("git").is_err() {
            return;
        }
        let remote = temp("remote");
        git(&remote, &["init", "--quiet", "--bare", "-b", "main"]);
        let a = temp("a");
        init(&a);
        fs::write(a.join("週報.md"), "# 週報\n").unwrap();
        assert!(status_at(&a)
            .changes
            .iter()
            .any(|c| c.status == FileStatus::Untracked));
        assert_eq!(commit_at(&a, "  ").unwrap_err(), "請輸入提交說明");
        commit_at(&a, "第一版").unwrap();
        assert_eq!(commit_at(&a, "沒有變更").unwrap_err(), "沒有需要提交的變更");
        git(&a, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git(&a, &["push", "--quiet", "-u", "origin", "main"]);

        // 另一台電腦 b 推了一個新提交，a 拉取（快轉）。
        let b = temp("b");
        git(&b, &["clone", "--quiet", remote.to_str().unwrap(), "."]);
        init(&b);
        fs::write(b.join("週報.md"), "# 週報\n\nb 的修改\n").unwrap();
        commit_at(&b, "b 的修改").unwrap();
        push_at(&b).unwrap();
        assert_eq!(pull_at(&a).unwrap(), "已拉取 1 個新的提交");
        assert_eq!(pull_at(&a).unwrap(), "已經是最新的");

        // 有未提交的變更時不拉取。
        fs::write(a.join("週報.md"), "未提交\n").unwrap();
        assert!(pull_at(&a).unwrap_err().contains("未提交"));
        git(&a, &["checkout", "--quiet", "--", "."]);

        // 兩邊改同一行：拉取時衝突 → 取消，檔案維持原樣。
        fs::write(b.join("週報.md"), "# 週報\n\nb 又改了\n").unwrap();
        commit_at(&b, "b 第二次").unwrap();
        push_at(&b).unwrap();
        fs::write(a.join("週報.md"), "# 週報\n\na 也改了\n").unwrap();
        commit_at(&a, "a 的修改").unwrap();
        assert!(push_at(&a).unwrap_err().contains("先拉取"));
        assert!(pull_at(&a).unwrap_err().contains("衝突"));
        assert!(!rebase_in_progress(&a));
        assert_eq!(
            fs::read_to_string(a.join("週報.md")).unwrap(),
            "# 週報\n\na 也改了\n"
        );

        // 改不同檔案：rebase 成功，推送。
        git(&a, &["reset", "--quiet", "--hard", "origin/main"]);
        git(&a, &["pull", "--quiet", "--ff-only"]);
        fs::write(a.join("另一份.md"), "a\n").unwrap();
        commit_at(&a, "a 新增檔案").unwrap();
        fs::write(b.join("週報.md"), "# 週報\n\nb 第三次\n").unwrap();
        commit_at(&b, "b 第三次").unwrap();
        push_at(&b).unwrap();
        assert!(pull_at(&a).unwrap().starts_with("已拉取"));
        assert_eq!(push_at(&a).unwrap(), "已推送");

        for d in [remote, a, b] {
            let _ = fs::remove_dir_all(d);
        }
    }
}
