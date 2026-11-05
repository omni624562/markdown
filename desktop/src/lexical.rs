//! 只看字串的路徑判斷（不碰檔案系統）。
//!
//! Windows 上光是檢查 `\\主機\共用\a.md` 存不存在，就會連到那台主機、送出 Windows 登入的雜湊值。
//! 前端傳來的路徑要先用這裡的函式確認寫法（在工作區資料夾底下，或是本機磁碟上的路徑），
//! 通過之後才碰檔案系統。規則依 `windows` 參數決定，在 Linux 上也能測試 Windows 的各種寫法。

use std::path::Path;

/// 開頭兩個字元都是分隔符號：`\\主機`、`//主機`、`\/主機`、`/\主機`、`\\?\`、`\\.\`。
/// Windows（包括 Rust 標準函式庫的路徑解析）把這些都當成網路或裝置路徑。
fn double_separator(path: &str) -> bool {
    let mut chars = path.chars();
    matches!(
        (chars.next(), chars.next()),
        (Some('\\' | '/'), Some('\\' | '/'))
    )
}

/// 磁碟機代號（`C:`）。
pub fn is_drive(segment: &str) -> bool {
    let b = segment.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// `C:\…` 或 `C:/…`：磁碟機上的絕對路徑。
fn drive_absolute(path: &str) -> bool {
    path.get(..2).is_some_and(is_drive) && path[2..].starts_with(['\\', '/'])
}

/// `\\?\C:\…`：不經過正規化、但一樣是本機磁碟機上的路徑。
fn verbatim_disk(path: &str) -> bool {
    path.strip_prefix(r"\\?\")
        .is_some_and(|rest| rest.get(..2).is_some_and(is_drive) && rest[2..].starts_with('\\'))
}

/// 本機磁碟上的絕對路徑：Windows 只接受 `C:\…`（以及 `\\?\C:\…`）；其他平台是 `/` 開頭（`//` 除外）。
/// 網路路徑（`\\主機\…`、`\/主機/…`、`\\?\UNC\…`）、裝置路徑（`\\.\…`）、`C:相對路徑` 與相對路徑都不算。
pub fn is_local_absolute_as(path: &str, windows: bool) -> bool {
    if windows {
        drive_absolute(path) || verbatim_disk(path)
    } else {
        path.starts_with('/') && !double_separator(path)
    }
}

/// 可能連到網路或裝置的寫法（相對路徑不算：`.git` 檔案裡的 `gitdir: ../.git/worktrees/a` 很常見）。
/// Windows：以分隔符號開頭、又不是 `\\?\C:\` 的都算（UNC、`\\?\UNC\`、`\\.\`、`\??\`…）；
/// 其他平台：開頭兩個字元都是分隔符號。
pub fn looks_remote_as(path: &str, windows: bool) -> bool {
    if windows {
        path.starts_with(['\\', '/']) && !verbatim_disk(path)
    } else {
        double_separator(path)
    }
}

/// 這台電腦的本機絕對路徑（見 [`is_local_absolute_as`]）。Windows 上再用標準函式庫的路徑解析確認開頭是磁碟機。
pub fn is_local_absolute(path: &str) -> bool {
    let p = Path::new(path);
    is_local_absolute_as(path, cfg!(windows)) && native_disk(p, false) && p.is_absolute()
}

/// 這台電腦上可能連到網路或裝置的寫法（見 [`looks_remote_as`]）。
pub fn looks_remote(path: &str) -> bool {
    looks_remote_as(path, cfg!(windows)) || !native_disk(Path::new(path), true)
}

/// Windows：開頭是磁碟機（`C:`、`\\?\C:`），或 `relative_ok` 時完全沒有開頭的相對路徑。其他平台一律成立。
#[cfg(windows)]
fn native_disk(path: &Path, relative_ok: bool) -> bool {
    use std::path::{Component, Prefix};
    match path.components().next() {
        Some(Component::Prefix(p)) => matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)),
        Some(Component::RootDir) => false,
        _ => relative_ok,
    }
}

#[cfg(not(windows))]
fn native_disk(_path: &Path, _relative_ok: bool) -> bool {
    true
}

/// Windows 保留的裝置名稱（`con.png` 在舊版 Windows 上指的是主控台，不是檔案）。
pub fn is_device_name(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ');
    let stem = stem.to_ascii_lowercase();
    matches!(
        stem.as_str(),
        "con" | "prn" | "aux" | "nul" | "conin$" | "conout$"
    ) || ((stem.starts_with("com") || stem.starts_with("lpt"))
        && stem.len() == 4
        && stem.as_bytes()[3].is_ascii_digit())
}

/// 路徑中可疑的一段：`.`、`..`；Windows 上還有結尾是點或空白的（Windows 會去掉，`.. ` 等於 `..`、
/// `.git.` 等於 `.git`）、含 `:` 的（替代資料流；磁碟機代號由呼叫端另外處理）、萬用字元與裝置名稱。
pub fn odd_segment(segment: &str, windows: bool) -> bool {
    segment == "."
        || segment == ".."
        || (windows
            && (segment.ends_with(['.', ' '])
                || segment.contains([':', '*', '?', '<', '>', '|', '"'])
                || is_device_name(segment)))
}

/// 統一寫法：Windows 不分大小寫、`/` 換成 `\`；去掉結尾多餘的分隔符號（`C:\`、`/` 保留）。
fn normalize(s: &str, windows: bool) -> String {
    let sep = if windows { '\\' } else { '/' };
    let mut s = if windows {
        s.replace('/', "\\").to_lowercase()
    } else {
        s.to_string()
    };
    while s.chars().count() > 1 && s.ends_with(sep) && !s.ends_with(":\\") {
        s.pop();
    }
    s
}

/// `path` 寫在 `root` 底下時，`root` 之後的部分（`path` 就是 `root` 時是空字串）。
fn rest_after(path: &str, root: &str, windows: bool) -> Option<String> {
    let sep = if windows { '\\' } else { '/' };
    let (p, r) = (normalize(path, windows), normalize(root, windows));
    if r.is_empty() || !p.starts_with(&r) {
        return None;
    }
    let rest = &p[r.len()..];
    if rest.is_empty() || r.ends_with(sep) {
        Some(rest.to_string())
    } else {
        rest.strip_prefix(sep).map(str::to_string)
    }
}

/// 只用字串判斷 `path` 是否在 `root` 之內（`root` 本身不算）。
/// `windows` 時不分大小寫，`/` 和 `\` 視為相同。
pub fn lexically_inside(path: &str, root: &str, windows: bool) -> bool {
    rest_after(path, root, windows).is_some_and(|rest| !rest.is_empty())
}

/// `path` 就是 `root`，或寫在 `root` 底下，而且多出來的每一段都沒有可疑的寫法（見 [`odd_segment`]）。
/// 只看字串：`root` 是 UNC（`\\NAS\共用`）時，同一個共用裡的路徑才會通過；其他網路、裝置路徑一律不通過。
pub fn within(path: &str, root: &str, windows: bool) -> bool {
    let sep = if windows { '\\' } else { '/' };
    rest_after(path, root, windows)
        .is_some_and(|rest| !rest.split(sep).any(|seg| odd_segment(seg, windows)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_drive_paths_are_local_on_windows() {
        let local = |p: &str| is_local_absolute_as(p, true);
        assert!(local(r"C:\Users\me\產品\a.png"));
        assert!(local("c:/Users/me/a.png"));
        assert!(local(r"\\?\C:\Users\me\a.png"));
        for p in [
            r"\\h\s\a.png",
            "//h/s/a.png",
            r"\/h/s/a.png",
            r"/\h\s\a.png",
            r"\\?\UNC\h\s\a.png",
            r"\\.\pipe\x",
            r"\\.\C:\a.png",
            r"\??\UNC\h\s\a.png",
            r"\\?\GLOBALROOT\Device\Mup\h\s",
            r"\\?\C:/a.png",
            "C:rel",
            r"C:rel\a.png",
            r"\Users\me\a.png",
            "images/a.png",
            "https://example.com/a.png",
            "",
        ] {
            assert!(!local(p), "{p}");
        }
    }

    #[test]
    fn unix_local_paths() {
        assert!(is_local_absolute_as("/home/me/a.png", false));
        assert!(!is_local_absolute_as("//h/s/a.png", false));
        assert!(!is_local_absolute_as(r"/\h\s\a.png", false));
        assert!(!is_local_absolute_as(r"\\h\s\a.png", false));
        assert!(!is_local_absolute_as("images/a.png", false));
    }

    #[test]
    fn recognizes_remote_spellings() {
        for p in [
            r"\\h\s",
            "//h/s",
            r"\/h/s",
            r"/\h\s",
            r"\\?\UNC\h\s",
            r"\\.\pipe\x",
            r"\??\UNC\h\s",
            r"\repo\.git",
        ] {
            assert!(looks_remote_as(p, true), "{p}");
        }
        for p in [
            r"C:\repo\.git",
            "C:/repo/.git",
            "C:rel",
            r"\\?\C:\repo\.git",
            "../.git/worktrees/a",
            r"..\.git\modules\b",
        ] {
            assert!(!looks_remote_as(p, true), "{p}");
        }
        assert!(looks_remote_as("//h/s", false));
        assert!(looks_remote_as(r"\\h\s", false));
        assert!(looks_remote_as(r"/\h\s", false));
        assert!(!looks_remote_as("/home/me/repo/.git", false));
        assert!(!looks_remote_as("../.git/worktrees/a", false));
    }

    /// 在 Windows 上，標準函式庫的路徑解析也要得到一樣的結論。
    #[cfg(windows)]
    #[test]
    fn native_parser_agrees_on_windows() {
        for p in [
            r"\\h\s\a.png",
            "//h/s/a.png",
            r"\/h/s/a.png",
            r"/\h\s\a.png",
            r"\\?\UNC\h\s\a.png",
            r"\\.\pipe\x",
            "C:rel",
            r"\??\UNC\h\s\a.png",
        ] {
            assert!(!is_local_absolute(p), "{p}");
            assert!(looks_remote(p) || p == "C:rel", "{p}");
        }
        assert!(is_local_absolute(r"C:\Users\me\a.png"));
        assert!(is_local_absolute(r"\\?\C:\Users\me\a.png"));
        assert!(!looks_remote(r"..\.git\worktrees\a"));
    }

    #[test]
    fn lexical_containment() {
        assert!(lexically_inside(r"C:\a\b.png", r"C:\a\", true));
        assert!(lexically_inside(r"C:\a\b.png", r"C:\", true));
        assert!(!lexically_inside(r"C:\ab.png", r"C:\a", true));
        assert!(!lexically_inside(r"C:\a", r"C:\a", true));
        assert!(lexically_inside("/a/b.png", "/a/", false));
        assert!(!lexically_inside("/A/b.png", "/a", false));
    }

    #[test]
    fn within_the_workspace_by_spelling() {
        let root = r"C:\Users\me\產品";
        let ok = |p: &str| within(p, root, true);
        assert!(ok(r"C:\Users\me\產品"));
        assert!(ok(r"C:\Users\me\產品\"));
        assert!(ok(r"C:\Users\me\產品\第2章\a.md"));
        assert!(ok("c:/users/me/產品/A.md"));
        // 8.3 短檔名只看字串認不出來，由解析實際位置的檢查處理。
        assert!(ok(r"C:\Users\me\產品\GIT~1\config.md"));
        for p in [
            r"C:\Users\me\產品2\a.md",
            r"C:\Users\me",
            r"\\h\s\a.md",
            "//h/s/a.md",
            r"\/h/s/a.md",
            r"/\h\s\a.md",
            r"\\?\C:\Users\me\產品\a.md",
            r"\\?\UNC\h\s\a.md",
            r"\\.\pipe\x",
            r"C:\Users\me\產品\..\x.md",
            r"C:\Users\me\產品\.. \x.md",
            r"C:\Users\me\產品\...",
            r"C:\Users\me\產品\.\a.md",
            r"C:\Users\me\產品\.git.\config.md",
            r"C:\Users\me\產品\.git::$INDEX_ALLOCATION\config.md",
            r"C:\Users\me\產品\a.md:stream",
            r"C:\Users\me\產品\con",
            r"C:\Users\me\產品\*.md",
            "C:Users\\me\\產品\\a.md",
            "相對路徑.md",
        ] {
            assert!(!ok(p), "{p}");
        }
        // 工作區本身在網路共用上時，同一個共用裡的檔案可以。
        let nas = r"\\NAS\共用\筆記";
        assert!(within(r"\\nas\共用\筆記\a.md", nas, true));
        assert!(within(r"\\NAS\共用\筆記", nas, true));
        assert!(!within(r"\\nas\共用\別的\a.md", nas, true));
        assert!(!within(r"\\attacker\共用\筆記\a.md", nas, true));
        // 其他平台：大小寫不同就是別的資料夾，反斜線只是檔名的一部分。
        assert!(within("/home/me/產品/a.md", "/home/me/產品", false));
        assert!(within("/home/me/產品/a.md:x", "/home/me/產品", false));
        assert!(!within("/home/me/產品/../x.md", "/home/me/產品", false));
        assert!(!within("/home/me/產品2/a.md", "/home/me/產品", false));
        assert!(!within("/HOME/me/產品/a.md", "/home/me/產品", false));
        assert!(within("/a.md", "/", false));
    }

    #[test]
    fn odd_segments() {
        for s in [
            ".", "..", "...", ".. ", ".git.", "a:b", "con", "nul.md", "COM1", "*.md",
        ] {
            assert!(odd_segment(s, true), "{s}");
        }
        for s in ["a.md", ".git", "第2章", "GIT~1", "", "console.md"] {
            assert!(!odd_segment(s, true), "{s}");
        }
        assert!(!odd_segment("...", false));
        assert!(!odd_segment("a:b", false));
        assert!(odd_segment("..", false));
    }
}
