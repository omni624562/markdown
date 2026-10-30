//! 下載（clone）儲存庫並開成工作區：GitHub 與 Azure DevOps 共用。
//! 選擇放在哪個資料夾、已經下載過同一個儲存庫時直接開啟、下載後加進專案清單。

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager, Window};

use crate::files::path_string;
use crate::git::Auth;
use crate::workspace::FolderInfo;

/// 選擇下載到哪個資料夾：回傳「選的資料夾／名稱」；使用者取消時回傳 None。
pub(crate) async fn pick_clone_dest(
    app: &AppHandle,
    window: &Window,
    name: &str,
    url: &str,
) -> Result<Option<CloneDest>, String> {
    if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\', ':']) {
        return Err(tr!("儲存庫名稱不正確"));
    }
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_parent(window)
        .set_title(tr!("選擇要把「{name}」放在哪個資料夾", name = name));
    if let Ok(docs) = app.path().document_dir() {
        dialog = dialog.set_directory(docs);
    }
    let Some(parent) = dialog.pick_folder().await else {
        return Ok(None);
    };
    let dest = parent.path().join(name);
    if dest.exists()
        && fs::read_dir(&dest)
            .map(|mut d| d.next().is_some())
            .unwrap_or(true)
    {
        // 之前已經下載到這裡：直接開啟，不用再下載一次。
        if origin_url(&dest).is_some_and(|u| same_repo(&u, url)) {
            return Ok(Some(CloneDest::Existing(dest)));
        }
        return Err(tr!(
            "「{path}」已經存在而且不是空的，請換一個位置",
            path = path_string(&dest)
        ));
    }
    Ok(Some(CloneDest::New(dest)))
}

/// 下載儲存庫的位置：新的資料夾，或之前已經下載過的同一個儲存庫。
pub(crate) enum CloneDest {
    New(PathBuf),
    Existing(PathBuf),
}

/// 下載（或開啟已經下載過的）儲存庫的結果。
#[derive(Serialize)]
pub struct Cloned {
    #[serde(flatten)]
    pub folder: FolderInfo,
    /// 之前已經下載過，這次只是開啟。
    pub existing: bool,
}

/// 下載到 `dest`（已經下載過就直接開啟），把資料夾開成工作區。
pub(crate) async fn clone_and_open(
    app: &AppHandle,
    dest: CloneDest,
    url: String,
    auth: Auth,
    group: &str,
) -> Result<Cloned, String> {
    let (dest, existing) = match dest {
        CloneDest::Existing(path) => (path, true),
        CloneDest::New(path) => {
            let target = path.clone();
            crate::io::blocking_for(crate::git::NETWORK_TIMEOUT, move || {
                crate::git::clone_to(&url, &target, &auth)
            })
            .await?;
            (path, false)
        }
    };
    let folder = crate::workspace::open_folder_from_cli(app, dest.clone());
    app.state::<crate::trust::Trust>()
        .set_default_group(app, &dest, group);
    Ok(Cloned { folder, existing })
}

fn origin_url(dir: &std::path::Path) -> Option<String> {
    let repo = git2::Repository::open(dir).ok()?;
    let remote = repo.find_remote("origin").ok()?;
    remote.url().ok().map(str::to_owned)
}

/// 兩個網址是不是同一個儲存庫（不分大小寫，忽略帳號、結尾的 `/` 與 `.git`）。
fn same_repo(a: &str, b: &str) -> bool {
    fn norm(u: &str) -> String {
        let u = u.trim().to_ascii_lowercase();
        let (scheme, rest) = u.split_once("://").unwrap_or(("", &u));
        let rest = match rest.split_once('@') {
            Some((user, host)) if !user.contains('/') => host,
            _ => rest,
        };
        let rest = rest.trim_end_matches('/');
        let rest = rest.strip_suffix(".git").unwrap_or(rest);
        format!("{scheme}://{rest}")
    }
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_the_same_repository() {
        assert!(same_repo(
            "https://github.com/O/R.git",
            "https://github.com/o/r"
        ));
        assert!(same_repo(
            "https://org@dev.azure.com/org/proj/_git/repo",
            "https://dev.azure.com/org/proj/_git/repo/"
        ));
        assert!(!same_repo(
            "https://github.com/o/r",
            "https://github.com/o/r2"
        ));
        assert!(!same_repo(
            "https://tfs.example.com/c/p/_git/a",
            "http://tfs.example.com/c/p/_git/a"
        ));
    }
}
