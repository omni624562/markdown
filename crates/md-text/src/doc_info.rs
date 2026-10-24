//! 從 Markdown 文件中找出待辦事項、標籤與連結（資料夾索引、待辦清單、反向連結用）。
//!
//! 規則原本是前端的正規表示式，這裡逐字掃描、結果相同（`tests/doc-index.cases.json` 的測試資料）：
//! 空白是 JavaScript 的 `\s`，數字只算 0–9。

use std::collections::HashSet;
use std::ops::Range;

use serde::Serialize;

use crate::scan::{before, blank_code, is_ws, percent_decode, run, trim};

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    /// 第幾行（從 1 開始）。
    pub line: usize,
    pub done: bool,
    /// 勾選框後面的文字（原始 Markdown）。
    pub text: String,
    pub owners: Vec<String>,
    /// 截止日（YYYY-MM-DD）。
    pub due: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkRef {
    pub line: usize,
    pub target: String,
    /// `wiki` 或 `markdown`。
    pub kind: &'static str,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DocInfo {
    pub tasks: Vec<Task>,
    pub tags: Vec<String>,
    pub links: Vec<LinkRef>,
}

/// 標籤、負責人前面可以接的標點（另外是行首與空白）。
const TAG_AFTER: &str = "，、。；：（「『【";
const OWNER_AFTER: &str = "，、：:（(";

/// 解析整份文件。`year` 是今年（截止日沒寫年份時用）。
pub fn parse_doc(text: &str, year: i32) -> DocInfo {
    let mut info = DocInfo::default();
    let mut tags = HashSet::<String>::new();
    // 程式碼區塊的圍欄：字元與長度。
    let mut fence: Option<(char, usize)> = None;
    let mut comment = false;
    for (i, raw) in text.split('\n').enumerate() {
        let f = fence_at(raw);
        if let Some((open, len)) = fence {
            if let Some(f) = f {
                if f.starts_with(open) && f.len() >= len && trim(raw).len() == f.len() {
                    fence = None;
                }
            }
            continue;
        }
        if let Some(f) = f {
            fence = f.chars().next().map(|c| (c, f.len()));
            continue;
        }
        let mut line = blank_code(raw);
        // HTML 註解（可以跨行）
        if comment {
            let Some(end) = line.find("-->") else {
                continue;
            };
            comment = false;
            line.replace_range(..end + 3, &" ".repeat(end + 3));
        }
        while let Some(start) = line.find("<!--") {
            match line[start + 4..].find("-->") {
                Some(len) => {
                    let end = start + 4 + len + 3;
                    line.replace_range(start..end, &" ".repeat(end - start));
                }
                None => {
                    comment = true;
                    line.truncate(start);
                    break;
                }
            }
        }
        if let Some((done, body)) = task(&line) {
            // 位置和原本那一行一樣（行內程式碼換成等長的空白）；後面接著註解時只取到註解前。
            // 負責人與截止日不算程式碼與註解裡的。
            let plain = &line[body.clone()];
            info.tasks.push(Task {
                line: i + 1,
                done,
                text: raw.get(body).unwrap_or("").to_owned(),
                owners: owners(plain),
                due: parse_due(plain, year),
            });
        }
        for tag in words(&line, '#', is_tag_char, TAG_AFTER) {
            let tag = tag.trim_end_matches(['/', '-']);
            if !tag.is_empty()
                && !tag.bytes().all(|c| c.is_ascii_digit())
                && tags.insert(tag.to_owned())
            {
                info.tags.push(tag.to_owned());
            }
        }
        let mut at = 0;
        while let Some(p) = line[at..].find("[[") {
            match wiki_link(&line, at + p) {
                Some((end, target)) => {
                    info.links.push(LinkRef {
                        line: i + 1,
                        target: trim(target).to_owned(),
                        kind: "wiki",
                    });
                    at = end;
                }
                None => at += p + 1,
            }
        }
        let mut at = 0;
        while let Some(p) = line[at..].find('[') {
            let Some((end, href)) = md_link(&line, at + p) else {
                at += p + 1;
                continue;
            };
            at = end;
            if has_scheme(href) || href.starts_with('#') || href.starts_with("//") {
                continue;
            }
            let target = href.split('#').next().unwrap_or("");
            let target = percent_decode(target).unwrap_or_else(|| target.to_owned());
            if !target.is_empty() {
                info.links.push(LinkRef {
                    line: i + 1,
                    target,
                    kind: "markdown",
                });
            }
        }
    }
    info
}

/// 程式碼區塊的圍欄：最多三個空白，接著三個以上的 `` ` `` 或 `~`（回傳那一段）。
pub(crate) fn fence_at(line: &str) -> Option<&str> {
    let lead = run(line, 0, is_ws);
    if line[..lead].chars().count() > 3 {
        return None;
    }
    let rest = &line[lead..];
    let c = rest.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    let n = run(rest, 0, |x| x == c);
    (n >= 3).then(|| &rest[..n])
}

/// 待辦那一行（`- [ ] 文字`、`1. [x] 文字`）：是否完成，以及勾選框後面文字的位置。
fn task(line: &str) -> Option<(bool, Range<usize>)> {
    let b = line.as_bytes();
    let mut i = run(line, 0, is_ws);
    match b.get(i)? {
        b'-' | b'*' | b'+' => i += 1,
        b'0'..=b'9' => {
            i += run(line, i, |c| c.is_ascii_digit());
            if !matches!(b.get(i), Some(b'.' | b')')) {
                return None;
            }
            i += 1;
        }
        _ => return None,
    }
    let ws = run(line, i, is_ws);
    if ws == 0 || b.get(i + ws) != Some(&b'[') {
        return None;
    }
    i += ws + 1;
    let done = match b.get(i)? {
        b' ' => false,
        b'x' | b'X' => true,
        _ => return None,
    };
    if b.get(i + 1) != Some(&b']') {
        return None;
    }
    i += 2;
    let ws = run(line, i, is_ws);
    // JavaScript 的 `.` 不含 \r、U+2028、U+2029。
    if ws == 0 || line[i + ws..].contains(['\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some((done, i + ws..line.len()))
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '/' | '-')
}

fn is_owner_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-')
}

/// `mark` 開頭、後面接著一段 `keep` 字元的詞（`#標籤`、`@負責人`）；`mark` 前面必須是行首、空白或 `after` 裡的標點。
fn words<'a>(text: &'a str, mark: char, keep: fn(char) -> bool, after: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(p) = text[i..].find(mark) {
        let at = i + p;
        let start = at + mark.len_utf8();
        let n = run(text, start, keep);
        i = start + n;
        if n > 0 && before(text, at).is_none_or(|c| is_ws(c) || after.contains(c)) {
            out.push(&text[start..start + n]);
        }
    }
    out
}

/// `@名字` 標記的負責人（不重複，去掉結尾的 `-`、`_`）。
fn owners(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for name in words(text, '@', is_owner_char, OWNER_AFTER) {
        let name = name.trim_end_matches(['-', '_']);
        if !name.is_empty() && seen.insert(name) {
            out.push(name.to_owned());
        }
    }
    out
}

/// `[[目標#標題|顯示文字]]`：結束位置與目標。
pub(crate) fn wiki_link(line: &str, at: usize) -> Option<(usize, &str)> {
    let mut i = at + 2;
    let n = run(line, i, |c| !matches!(c, '[' | ']' | '|' | '#' | '\n'));
    if n == 0 {
        return None;
    }
    let target = &line[i..i + n];
    i += n;
    if line[i..].starts_with('#') {
        i += 1 + run(line, i + 1, |c| !matches!(c, '[' | ']' | '|' | '\n'));
    }
    if line[i..].starts_with('|') {
        i += 1 + run(line, i + 1, |c| !matches!(c, '[' | ']' | '\n'));
    }
    line[i..].starts_with("]]").then_some((i + 2, target))
}

/// `[文字](網址 "標題")`（前面可以有 `!`）：結束位置與網址。
pub(crate) fn md_link(line: &str, at: usize) -> Option<(usize, &str)> {
    let close = at + 1 + line[at + 1..].find([']', '\n'])?;
    if !line[close..].starts_with("](") {
        return None;
    }
    let i = close + 2 + run(line, close + 2, is_ws);
    // 網址可以用角括號包起來；當成角括號不成立時，`<` 就是網址的一部分。
    if line[i..].starts_with('<') {
        if let Some(found) = link_dest(line, i + 1) {
            return Some(found);
        }
    }
    link_dest(line, i)
}

fn link_dest(line: &str, at: usize) -> Option<(usize, &str)> {
    let n = run(line, at, |c| !(c == ')' || c == '>' || is_ws(c)));
    if n == 0 {
        return None;
    }
    let href = &line[at..at + n];
    let mut i = at + n;
    if line[i..].starts_with('>') {
        i += 1;
    }
    let closing = |from: usize| {
        let end = from + run(line, from, is_ws);
        line[end..].starts_with(')').then_some((end + 1, href))
    };
    // 標題（`"…"`）可有可無
    let ws = run(line, i, is_ws);
    if ws > 0 && line[i + ws..].starts_with('"') {
        let start = i + ws + 1;
        if let Some(q) = line[start..].find(['"', '\n']) {
            if line[start + q..].starts_with('"') {
                if let Some(found) = closing(start + q + 1) {
                    return Some(found);
                }
            }
        }
    }
    closing(i)
}

/// 開頭是 `http:`、`mailto:` 這類網址的協定。
pub(crate) fn has_scheme(href: &str) -> bool {
    let mut chars = href.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    let rest = chars.as_str();
    let n = run(rest, 0, |c| {
        c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')
    });
    rest[n..].starts_with(':')
}

fn digit(b: &[u8], i: usize) -> bool {
    b.get(i).is_some_and(u8::is_ascii_digit)
}

fn number(b: &[u8], from: usize, len: usize) -> Option<u32> {
    let s = b.get(from..from + len)?;
    s.iter()
        .all(u8::is_ascii_digit)
        .then(|| s.iter().fold(0, |n, d| n * 10 + u32::from(d - b'0')))
}

fn valid(y: i32, m: u32, d: u32) -> Option<String> {
    // JavaScript 的 `new Date(y, …)` 把 0–99 年當成 1900 年代，所以這些年份都不算。
    if y < 100 {
        return None;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    (1..=days)
        .contains(&d)
        .then(|| format!("{y}-{m:02}-{d:02}"))
}

/// 一位或兩位數字（先試兩位）；`ok(值, 結束位置)` 決定要不要。
fn one_or_two(b: &[u8], at: usize, mut ok: impl FnMut(u32, usize) -> bool) -> Option<(u32, usize)> {
    [2, 1].into_iter().find_map(|len| {
        let n = number(b, at, len)?;
        ok(n, at + len).then_some((n, at + len))
    })
}

/// `2026-10-25`、`2026/10/25`、`2026.10.25`（前後不能再接數字）。
fn full_date(b: &[u8]) -> Option<(u32, u32, u32)> {
    let sep = |i: usize| matches!(b.get(i), Some(b'-' | b'/' | b'.'));
    (0..b.len()).find_map(|i| {
        if (i > 0 && digit(b, i - 1)) || !sep(i + 4) {
            return None;
        }
        let y = number(b, i, 4)?;
        let mut day = None;
        let (m, _) = one_or_two(b, i + 5, |_, end| {
            if !sep(end) {
                return false;
            }
            day = one_or_two(b, end + 1, |_, e| !digit(b, e));
            day.is_some()
        })?;
        Some((y, m, day?.0))
    })
}

/// `10/25`（前後不能接數字或斜線）。
fn slash_date(b: &[u8]) -> Option<(u32, u32)> {
    let edge = |i: Option<&u8>| i.is_some_and(|c| c.is_ascii_digit() || *c == b'/');
    (0..b.len()).find_map(|i| {
        if i > 0 && edge(b.get(i - 1)) {
            return None;
        }
        let mut day = None;
        let (m, _) = one_or_two(b, i, |_, end| {
            if b.get(end) != Some(&b'/') {
                return false;
            }
            day = one_or_two(b, end + 1, |_, e| !edge(b.get(e)));
            day.is_some()
        })?;
        Some((m, day?.0))
    })
}

/// `10月25日`、`10月25號`。
fn chinese_date(b: &[u8]) -> Option<(u32, u32)> {
    let month = "月".as_bytes();
    let ends = ["日".as_bytes(), "號".as_bytes()];
    (0..b.len()).find_map(|i| {
        if i > 0 && digit(b, i - 1) {
            return None;
        }
        let mut day = None;
        let (m, _) = one_or_two(b, i, |_, end| {
            if !b[end..].starts_with(month) {
                return false;
            }
            day = one_or_two(b, end + month.len(), |_, e| {
                ends.iter().any(|x| b[e..].starts_with(x))
            });
            day.is_some()
        })?;
        Some((m, day?.0))
    })
}

/// 待辦的截止日（沒寫年份就是 `year` 年）。
fn parse_due(text: &str, year: i32) -> Option<String> {
    let b = text.as_bytes();
    if let Some((y, m, d)) = full_date(b) {
        return valid(y as i32, m, d);
    }
    let (m, d) = slash_date(b).or_else(|| chinese_date(b))?;
    valid(year, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn due_dates() {
        let due = |s: &str| parse_due(s, 2026);
        assert_eq!(due("2026/1/5 前").as_deref(), Some("2026-01-05"));
        assert_eq!(due("12月31號").as_deref(), Some("2026-12-31"));
        assert_eq!(due("10/25").as_deref(), Some("2026-10-25"));
        assert_eq!(due("2/30"), None);
        assert_eq!(due("2028/2/29").as_deref(), Some("2028-02-29"));
        assert_eq!(due("2100/2/29"), None);
        assert_eq!(due("版本 1.2.3"), None);
        assert_eq!(due("比例 1/2/3"), None);
        assert_eq!(due("12026-10-25"), None);
        assert_eq!(due("2026-10-255"), None);
        assert_eq!(due("0099-01-01"), None);
        // 月份兩位數不合法時退回一位數
        assert_eq!(due("2026-1-5").as_deref(), Some("2026-01-05"));
    }

    #[test]
    fn owner_names() {
        assert_eq!(
            owners("@小明 和 @小華-、@小明 me@a.com (@Amy)"),
            ["小明", "小華", "Amy"]
        );
    }

    #[test]
    fn links() {
        let targets = |s: &str| -> Vec<String> {
            parse_doc(s, 2026)
                .links
                .into_iter()
                .map(|l| l.target)
                .collect()
        };
        assert_eq!(targets("[[[a]]"), ["a"]);
        assert_eq!(targets("[[ a #h|b]] [[|x]]"), ["a"]);
        assert_eq!(targets("[a](<b c>) [d](<e>)"), ["e"]);
        assert_eq!(
            targets("[a](<) ![p](x.png \"t\") [y](z \"q)"),
            ["<", "x.png"]
        );
        assert_eq!(
            targets("[a](http://x) [b](#h) [c](//h) [d](f.md#h) [e](%E6%9C%83.md)"),
            ["f.md", "會.md"]
        );
        assert_eq!(targets("[a [b](c)"), ["c"]);
    }

    #[test]
    fn fences_and_tasks() {
        let info = parse_doc(
            "    ```\n- [x] a\n~~~\n- [ ] b #t\n~~~~\n1) [ ]  c @甲、@乙",
            2026,
        );
        let tasks: Vec<_> = info
            .tasks
            .iter()
            .map(|t| (t.line, t.text.as_str()))
            .collect();
        assert_eq!(tasks, [(2, "a"), (6, "c @甲、@乙")]);
        assert_eq!(info.tasks[1].owners, ["甲", "乙"]);
        assert!(info.tags.is_empty());
    }
}
