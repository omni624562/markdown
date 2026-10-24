//! 檔案搬移或改名後，更新文件中指向它們的連結（`[[文件]]` 與相對路徑的 Markdown 連結）。
//!
//! 路徑規則和前端的 `web/src/paths.ts`、`links.ts` 相同：Windows 用 `\`、其他系統用 `/`，兩種都接受；
//! `[[週報]]` 和 Obsidian 一樣用檔名找（不分大小寫、不用寫 .md），同名時優先找同一個資料夾的。

use serde::Deserialize;

use crate::doc_info::{fence_at, has_scheme, md_link, wiki_link};
use crate::scan::{code_spans, percent_decode, trim};

#[derive(Deserialize, Debug, Clone)]
pub struct FileRef {
    pub path: String,
    /// 相對於資料夾、以 `/` 分隔的路徑。
    pub rel: String,
}

fn is_sep(c: char) -> bool {
    c == '/' || c == '\\'
}

fn separator(path: &str) -> char {
    if path.contains('\\') {
        '\\'
    } else {
        '/'
    }
}

fn windows_path(p: &str) -> bool {
    let b = p.as_bytes();
    (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
        || p.starts_with("\\\\")
        || p.contains('\\')
}

/// 同一個檔案（分隔符號不同、Windows 不分大小寫也算）。
pub fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        let s = p.replace('\\', "/");
        let s = s.trim_end_matches('/');
        if windows_path(p) {
            s.to_lowercase()
        } else {
            s.to_owned()
        }
    };
    norm(a) == norm(b)
}

/// 路徑所在的資料夾；沒有上層時回傳空字串。
pub fn dirname(path: &str) -> &str {
    let Some(i) = path.rfind(is_sep) else {
        return "";
    };
    // 保留根目錄本身的分隔符號（`/`、`C:\`）。
    if i == 0 || (i == 2 && path.as_bytes()[1] == b':') {
        &path[..=i]
    } else {
        &path[..i]
    }
}

pub fn basename(path: &str) -> &str {
    path.rfind(is_sep).map_or(path, |i| &path[i + 1..])
}

/// `path` 是 `dir` 本身或位於其中。
fn is_inside(path: &str, dir: &str) -> bool {
    if path == dir {
        return true;
    }
    let sep = separator(dir);
    if dir.ends_with(sep) {
        path.starts_with(dir)
    } else {
        path.strip_prefix(dir)
            .is_some_and(|rest| rest.starts_with(sep))
    }
}

/// 把 `path` 開頭的 `from` 換成 `to`（資料夾改名後更新底下檔案的路徑）。
pub fn rebase(path: &str, from: &str, to: &str) -> Option<String> {
    is_inside(path, from).then(|| format!("{to}{}", &path[from.len()..]))
}

/// 以 `dir` 為起點解析相對路徑（可含 `./`、`../`，分隔符號可用 `/` 或 `\`）。
pub fn resolve_path(dir: &str, relative: &str) -> String {
    let sep = separator(dir);
    let mut parts: Vec<&str> = dir.split(is_sep).collect();
    if parts.len() > 1 && parts.last() == Some(&"") {
        parts.pop();
    }
    for seg in relative.split(is_sep) {
        match seg {
            "" | "." => {}
            // 不要退到根目錄（`/` 或 `C:`）之外。
            ".." => {
                if parts.len() > 1 {
                    parts.pop();
                }
            }
            _ => parts.push(seg),
        }
    }
    let joined = parts.join(&sep.to_string());
    if parts.len() == 1 {
        format!("{joined}{sep}")
    } else {
        joined
    }
}

/// 從資料夾 `from_dir` 到檔案 `to` 的相對路徑，一律用 `/` 分隔（Markdown 連結用）。
/// Windows 路徑不分大小寫；不在同一個磁碟機時回傳 `None`。
pub fn relative_path(from_dir: &str, to: &str) -> Option<String> {
    let windows = windows_path(from_dir);
    let split = |p: &'_ str| -> Vec<String> {
        p.split(is_sep)
            .enumerate()
            .filter(|(i, seg)| !seg.is_empty() || *i == 0)
            .map(|(_, seg)| seg.to_owned())
            .collect()
    };
    let (a, b) = (split(from_dir), split(to));
    let same = |x: &str, y: &str| {
        if windows {
            x.to_lowercase() == y.to_lowercase()
        } else {
            x == y
        }
    };
    if a.is_empty() || b.is_empty() || !same(&a[0], &b[0]) {
        return None;
    }
    let mut common = 0;
    while common < a.len() && common + 1 < b.len() && same(&a[common], &b[common]) {
        common += 1;
    }
    let up = std::iter::repeat_n("..".to_owned(), a.len() - common);
    Some(
        up.chain(b[common..].iter().cloned())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

/// 結尾是 `.md` 或 `.markdown`（不分大小寫）時，副檔名從哪裡開始。
fn md_ext(s: &str) -> Option<usize> {
    let lower = s.to_ascii_lowercase();
    [".md", ".markdown"]
        .iter()
        .find(|ext| lower.ends_with(*ext))
        .map(|ext| s.len() - ext.len())
}

fn is_md(s: &str) -> bool {
    md_ext(s).is_some()
}

fn strip_md(s: &str) -> &str {
    md_ext(s).map_or(s, |i| &s[..i])
}

/// 小寫、不含副檔名的相對路徑。
fn stem_of(rel: &str) -> String {
    strip_md(&rel.to_lowercase()).to_owned()
}

/// `[[target]]` 對應的檔案路徑；找不到時回傳 `None`。
pub fn resolve_wiki<'a>(
    target: &str,
    files: &'a [FileRef],
    from_dir: Option<&str>,
) -> Option<&'a str> {
    let t = trim(target).replace('\\', "/");
    let mut t = t.strip_prefix("./").unwrap_or(&t).to_owned();
    if t.is_empty() {
        return None;
    }
    if !is_md(&t) {
        t.push_str(".md");
    }
    let want = stem_of(&t);
    // 寫了資料夾（[[筆記/想法]]）要完全符合；只寫檔名時找所有同名的檔案。.md 與 .markdown 都算。
    let full = want.contains('/');
    let pool: Vec<&FileRef> = files
        .iter()
        .filter(|f| {
            let stem = stem_of(&f.rel);
            if full {
                stem == want
            } else {
                stem[stem.rfind('/').map_or(0, |i| i + 1)..] == want
            }
        })
        .collect();
    if let Some(dir) = from_dir.filter(|d| !d.is_empty()) {
        if let Some(near) = pool.iter().find(|f| same_path(dirname(&f.path), dir)) {
            return Some(&near.path);
        }
    }
    pool.into_iter()
        .min_by_key(|f| (f.rel.split('/').count(), f.rel.len()))
        .map(|f| f.path.as_str())
}

/// 連結的種類。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LinkKind {
    Wiki,
    Markdown,
}

/// 改寫文件中的連結目標（程式碼裡的不動）。`f` 收到連結，回傳新的目標；回傳 `None` 表示不改。
/// Markdown 連結的目標是原始寫法（可能是 %XX 編碼），`[[ ]]` 的是 `#` 與 `|` 前面的部分。
pub fn rewrite_links(text: &str, mut f: impl FnMut(LinkKind, &str) -> Option<String>) -> String {
    let mut fence: Option<(char, usize)> = None;
    let mut lines = Vec::new();
    for line in text.split('\n') {
        let fm = fence_at(line);
        if let Some((open, len)) = fence {
            if fm.is_some_and(|m| m.starts_with(open) && m.len() >= len) {
                fence = None;
            }
            lines.push(line.to_owned());
            continue;
        }
        if let Some(m) = fm {
            fence = m.chars().next().map(|c| (c, m.len()));
            lines.push(line.to_owned());
            continue;
        }
        // 行內程式碼的位置（和前端一樣，第二輪的位置也用原本那一行的）。
        let code = code_spans(line);
        let in_code = |i: usize| code.iter().any(|&(a, b)| i >= a && i < b);
        let mut wiki = String::with_capacity(line.len());
        let mut done = 0;
        let mut at = 0;
        while let Some(p) = line[at..].find("[[") {
            let start = at + p;
            let Some((end, target)) = wiki_link(line, start) else {
                at = start + 1;
                continue;
            };
            at = end;
            if in_code(start) {
                continue;
            }
            if let Some(next) = f(LinkKind::Wiki, target) {
                let rest = &line[start + 2 + target.len()..end - 2];
                wiki.push_str(&line[done..start]);
                wiki.push_str(&format!("[[{next}{rest}]]"));
                done = end;
            }
        }
        wiki.push_str(&line[done..]);
        let line = wiki;
        let mut out = String::with_capacity(line.len());
        let mut done = 0;
        let mut last = 0;
        let mut at = 0;
        while let Some(p) = line[at..].find('[') {
            let open = at + p;
            let Some((end, href)) = md_link(&line, open) else {
                at = open + 1;
                continue;
            };
            // 圖片的 `!` 也算在連結裡（和正規表示式找到的起點一樣）。
            let start = if open > last && line.as_bytes()[open - 1] == b'!' {
                open - 1
            } else {
                open
            };
            at = end;
            last = end;
            if in_code(start) || has_scheme(href) || href.starts_with('#') {
                continue;
            }
            if let Some(next) = f(LinkKind::Markdown, href) {
                let href_at = href.as_ptr() as usize - line.as_ptr() as usize;
                out.push_str(&line[done..href_at]);
                out.push_str(&next);
                done = href_at + href.len();
            }
        }
        out.push_str(&line[done..]);
        lines.push(out);
    }
    lines.join("\n")
}

/// 和 JavaScript 的 `encodeURI` 相同。
fn encode_uri(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || b";,/?:@&=+$-_.!~*'()#".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// 檔案的新位置相對於資料夾的路徑（資料夾根目錄 = 舊路徑去掉 `old_rel` 的部分）。
fn rebase_rel(old_rel: &str, old_path: &str, new_path: &str) -> String {
    let root = old_path.split(is_sep).count() as isize - old_rel.split('/').count() as isize;
    let parts: Vec<&str> = new_path.split(is_sep).collect();
    let skip = if root < 0 {
        (parts.len() as isize + root).max(0) as usize
    } else {
        root as usize
    };
    parts[skip.min(parts.len())..].join("/")
}

/// 檔案搬移或改名後（`moved` 回傳檔案的新路徑，沒動的回傳 `None`），更新 `doc_path` 這份文件中指向它們的連結。
/// `files` 是改名前資料夾中的檔案。沒有要改的時候回傳 `None`。
pub fn rename_links(
    text: &str,
    doc_path: &str,
    files: &[FileRef],
    moved: impl Fn(&str) -> Option<String>,
) -> Option<String> {
    let dir = dirname(doc_path);
    let next = rewrite_links(text, |kind, target| {
        if kind == LinkKind::Wiki {
            let old = resolve_wiki(target, files, Some(dir))?;
            let to = moved(old)?;
            let name = basename(&to);
            let keep_ext = is_md(trim(target));
            // 原本寫了資料夾（[[筆記/想法]]）就寫新的相對路徑，否則只寫檔名。
            if target.contains('/') {
                let rel = match files.iter().find(|f| same_path(&f.path, old)) {
                    Some(r) => rebase_rel(&r.rel, old, &to),
                    None => name.to_owned(),
                };
                return Some(if keep_ext {
                    rel
                } else {
                    strip_md(&rel).to_owned()
                });
            }
            return Some(if keep_ext { name } else { strip_md(name) }.to_owned());
        }
        let raw = target.split('#').next().unwrap_or("");
        let hash = &target[raw.len()..];
        let encoded = raw
            .as_bytes()
            .windows(3)
            .any(|w| w[0] == b'%' && w[1].is_ascii_hexdigit() && w[2].is_ascii_hexdigit());
        let decoded = percent_decode(raw).unwrap_or_else(|| raw.to_owned());
        if !is_md(&decoded) {
            return None;
        }
        let to = moved(&resolve_path(dir, &decoded))?;
        let rel = relative_path(dir, &to)?;
        let out = if encoded { encode_uri(&rel) } else { rel };
        let out = if out.contains(|c: char| crate::scan::is_ws(c) || "()<>".contains(c)) {
            encode_uri(&out)
        } else {
            out
        };
        Some(out + hash)
    });
    (next != text).then_some(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(list: &[(&str, &str)]) -> Vec<FileRef> {
        list.iter()
            .map(|&(path, rel)| FileRef {
                path: path.into(),
                rel: rel.into(),
            })
            .collect()
    }

    fn ws() -> Vec<FileRef> {
        files(&[
            ("/ws/週報.md", "週報.md"),
            ("/ws/筆記/想法.md", "筆記/想法.md"),
            ("/ws/封存/週報.md", "封存/週報.md"),
            ("/ws/README.markdown", "README.markdown"),
        ])
    }

    #[test]
    fn paths() {
        assert_eq!(dirname("/a/b.md"), "/a");
        assert_eq!(dirname("/b.md"), "/");
        assert_eq!(dirname("C:\\b.md"), "C:\\");
        assert_eq!(dirname("b.md"), "");
        assert_eq!(basename("C:\\a\\b.md"), "b.md");
        assert_eq!(resolve_path("/ws/筆記", "../a/./b.md"), "/ws/a/b.md");
        assert_eq!(resolve_path("C:\\ws", "a/b.md"), "C:\\ws\\a\\b.md");
        assert_eq!(resolve_path("/", "../../a.md"), "/a.md");
        assert_eq!(
            relative_path("/ws/a", "/ws/b/c.md").as_deref(),
            Some("../b/c.md")
        );
        assert_eq!(
            relative_path("C:\\ws", "c:\\WS\\x.md").as_deref(),
            Some("x.md")
        );
        assert_eq!(relative_path("C:\\ws", "D:\\x.md"), None);
        assert!(same_path("C:\\筆記\\週報.md", "c:/筆記/週報.md"));
        assert!(!same_path("/a/B.md", "/a/b.md"));
        assert_eq!(
            rebase("/ws/a/b.md", "/ws/a", "/ws/c").as_deref(),
            Some("/ws/c/b.md")
        );
        assert_eq!(rebase("/ws/ab.md", "/ws/a", "/ws/c"), None);
        assert_eq!(encode_uri("點 (1)%.md"), "%E9%BB%9E%20(1)%25.md");
    }

    #[test]
    fn resolves_wiki_links() {
        let f = ws();
        assert_eq!(resolve_wiki("週報", &f, Some("/ws")), Some("/ws/週報.md"));
        assert_eq!(
            resolve_wiki("週報", &f, Some("/ws/封存")),
            Some("/ws/封存/週報.md")
        );
        assert_eq!(
            resolve_wiki("想法", &f, Some("/ws")),
            Some("/ws/筆記/想法.md")
        );
        assert_eq!(
            resolve_wiki("筆記/想法.md", &f, None),
            Some("/ws/筆記/想法.md")
        );
        assert_eq!(
            resolve_wiki("readme", &f, None),
            Some("/ws/README.markdown")
        );
        assert_eq!(resolve_wiki("不存在", &f, Some("/ws")), None);
        let win = files(&[("C:\\ws\\筆記\\想法.md", "筆記/想法.md")]);
        assert_eq!(
            resolve_wiki("想法", &win, Some("C:\\ws")),
            Some("C:\\ws\\筆記\\想法.md")
        );
    }

    #[test]
    fn skips_code() {
        let text = "[[a]] `[[a]]`\n```\n[[a]]\n```\n[x](a.md) ![y](a.md) `[z](a.md)`";
        let out = rewrite_links(text, |kind, t| match (kind, t) {
            (LinkKind::Wiki, "a") => Some("b".into()),
            (LinkKind::Markdown, "a.md") => Some("b.md".into()),
            _ => None,
        });
        assert_eq!(
            out,
            "[[b]] `[[a]]`\n```\n[[a]]\n```\n[x](b.md) ![y](b.md) `[z](a.md)`"
        );
    }

    #[test]
    fn renamed_file() {
        let f = ws();
        let moved =
            |p: &str| same_path(p, "/ws/筆記/想法.md").then(|| "/ws/筆記/點子 清單.md".to_owned());
        let text =
            "[[想法]]、[[想法#第一段|看這裡]]、[[筆記/想法]]、[說明](筆記/想法.md#a)、[[週報]]";
        assert_eq!(
            rename_links(text, "/ws/週報.md", &f, moved).as_deref(),
            Some("[[點子 清單]]、[[點子 清單#第一段|看這裡]]、[[筆記/點子 清單]]、[說明](%E7%AD%86%E8%A8%98/%E9%BB%9E%E5%AD%90%20%E6%B8%85%E5%96%AE.md#a)、[[週報]]")
        );
        assert_eq!(rename_links("[[週報]]", "/ws/x.md", &f, moved), None);
    }

    #[test]
    fn renamed_folder() {
        let f = ws();
        let moved = |p: &str| rebase(p, "/ws/筆記", "/ws/靈感");
        assert_eq!(
            rename_links(
                "[[筆記/想法]] [a](筆記/想法.md) [[想法]]",
                "/ws/週報.md",
                &f,
                moved
            )
            .as_deref(),
            Some("[[靈感/想法]] [a](靈感/想法.md) [[想法]]")
        );
    }

    #[test]
    fn windows_paths() {
        let f = files(&[("C:\\ws\\筆記\\想法.md", "筆記/想法.md")]);
        let moved = |p: &str| {
            same_path(p, "C:\\ws\\筆記\\想法.md").then(|| "C:\\ws\\筆記\\新.md".to_owned())
        };
        assert_eq!(
            rename_links("[a](筆記/想法.md)", "C:\\ws\\週報.md", &f, moved).as_deref(),
            Some("[a](筆記/新.md)")
        );
    }
}
