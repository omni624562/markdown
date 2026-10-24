//! 從 Markdown 文件中找出待辦事項、標籤與連結（資料夾索引用）。
//!
//! 和前端的 `web/src/doc-index.ts` 結果一致（已開啟的分頁在前端解析）：兩邊共用
//! `web/src/doc-index.cases.json` 的測試資料。在這裡解析，資料夾裡所有文件的內容就不用整份傳到前端。
//! 正規表示式依 JavaScript 的規則寫：`\s` 是 JavaScript 的空白、`\d` 只算 0–9。

use std::collections::HashSet;
use std::sync::LazyLock;

use chrono::{Datelike, NaiveDate};
use regex::Regex;
use serde::Serialize;

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

/// JavaScript 的 `\s`（和 Unicode 的 White_Space 差在 U+FEFF 與 U+0085）。
const WS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

fn is_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\x0B' | '\x0C' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn re(pattern: &str) -> Regex {
    Regex::new(&pattern.replace("WS", WS)).expect("invalid regex")
}

static FENCE: LazyLock<Regex> = LazyLock::new(|| re(r"^[WS]{0,3}(`{3,}|~{3,})"));
// JavaScript 的 `.` 不含 \r、U+2028、U+2029。
static TASK: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^([WS]*(?:[-*+]|[0-9]+[.)])[WS]+\[)([ xX])(\][WS]+)([^\n\r\x{2028}\x{2029}]*)$")
});
static TAG: LazyLock<Regex> = LazyLock::new(|| re(r"#([\p{L}\p{N}_/-]+)"));
static OWNER: LazyLock<Regex> = LazyLock::new(|| re(r"@([\p{L}\p{N}_-]+)"));
static WIKI: LazyLock<Regex> =
    LazyLock::new(|| re(r"\[\[([^\[\]|#\n]+)(?:#[^\[\]|\n]*)?(?:\|[^\[\]\n]*)?\]\]"));
static MD_LINK: LazyLock<Regex> =
    LazyLock::new(|| re(r#"!?\[[^\]\n]*\]\([WS]*<?([^)WS>]+)>?(?:[WS]+"[^"\n]*")?[WS]*\)"#));
/// 標籤、負責人前面可以接的標點（另外是行首與空白）。
// i18n-ignore
const TAG_AFTER: &str = "，、。；：（「『【";
// i18n-ignore
const OWNER_AFTER: &str = "，、：:（(";
static SCHEME: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^[a-z][a-z0-9+.-]*:"));

/// 前一個字元（`at` 是位元組位置）。
fn before(text: &str, at: usize) -> Option<char> {
    text[..at].chars().next_back()
}

/// 把行內程式碼換成空白（位元組長度不變，位置才對得上）。
/// 和 `/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g` 相同：開頭的反引號一段，配上後面第一段一樣長的。
fn blank_code(line: &str) -> String {
    let b = line.as_bytes();
    let mut out = b.to_vec();
    let run = |from: usize| b[from..].iter().take_while(|&&c| c == b'`').count();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'`' {
            i += 1;
            continue;
        }
        let n = run(i);
        let mut j = i + n;
        let mut close = None;
        while j < b.len() {
            if b[j] == b'`' {
                let m = run(j);
                if m == n {
                    close = Some(j + m);
                    break;
                }
                j += m;
            } else {
                j += 1;
            }
        }
        match close {
            Some(end) => {
                out[i..end].fill(b' ');
                i = end;
            }
            // 配不到：從下一個位置再試（可能是這段反引號裡面）。
            None => i += 1,
        }
    }
    // 只把 ASCII 的反引號範圍換成空白，切在字元邊界上，結果一定是合法的 UTF-8。
    String::from_utf8(out).unwrap_or_else(|_| line.to_owned())
}

fn spaces(n: usize) -> String {
    " ".repeat(n)
}

/// 和 JavaScript 的 `String.prototype.trim` 相同。
fn js_trim(s: &str) -> &str {
    s.trim_matches(is_ws)
}

pub fn parse_doc(text: &str, today: NaiveDate) -> DocInfo {
    let mut info = DocInfo::default();
    let mut tags = HashSet::<String>::new();
    let mut fence: Option<String> = None;
    let mut comment = false;
    for (i, raw) in text.split('\n').enumerate() {
        let f = FENCE.captures(raw).map(|c| c[1].to_owned());
        if let Some(open) = &fence {
            if let Some(f) = &f {
                let rest = js_trim(raw).get(f.len()..).unwrap_or("");
                if f.as_bytes()[0] == open.as_bytes()[0] && f.len() >= open.len() && rest.is_empty()
                {
                    fence = None;
                }
            }
            continue;
        }
        if f.is_some() {
            fence = f;
            continue;
        }
        let mut line = blank_code(raw);
        // HTML 註解（可以跨行）
        if comment {
            let Some(end) = line.find("-->") else {
                continue;
            };
            comment = false;
            line = spaces(end + 3) + &line[end + 3..];
        }
        while let Some(start) = line.find("<!--") {
            match line[start + 4..].find("-->") {
                Some(len) => {
                    let end = start + 4 + len + 3;
                    line.replace_range(start..end, &spaces(end - start));
                }
                None => {
                    comment = true;
                    line.truncate(start);
                    break;
                }
            }
        }
        if let Some(t) = TASK.captures(&line) {
            // 位置和原本那一行一樣（行內程式碼換成等長的空白）；後面接著註解時只取到註解前。
            let body = t.get(4).and_then(|g| raw.get(g.range())).unwrap_or("");
            // 負責人與截止日不算程式碼與註解裡的。
            let plain = &t[4];
            info.tasks.push(Task {
                line: i + 1,
                done: &t[2] != " ",
                text: body.to_owned(),
                owners: owners(plain),
                due: parse_due(plain, today),
            });
        }
        for m in TAG.captures_iter(&line) {
            let at = m.get(0).unwrap().start();
            if !before(&line, at).is_none_or(|c| is_ws(c) || TAG_AFTER.contains(c)) {
                continue;
            }
            let tag = m[1].trim_end_matches(['/', '-']);
            if !tag.is_empty()
                && !tag.bytes().all(|c| c.is_ascii_digit())
                && tags.insert(tag.to_owned())
            {
                info.tags.push(tag.to_owned());
            }
        }
        for m in WIKI.captures_iter(&line) {
            info.links.push(LinkRef {
                line: i + 1,
                target: js_trim(&m[1]).to_owned(),
                kind: "wiki",
            });
        }
        for m in MD_LINK.captures_iter(&line) {
            let href = &m[1];
            if SCHEME.is_match(href) || href.starts_with('#') || href.starts_with("//") {
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

/// 和 `decodeURIComponent` 相同：編碼不合法時回傳 `None`。
fn percent_decode(s: &str) -> Option<String> {
    if !s.contains('%') {
        return Some(s.to_owned());
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `@名字` 標記的負責人（不重複，去掉結尾的 `-`、`_`）。
pub fn owners(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for m in OWNER.captures_iter(text) {
        let at = m.get(0).unwrap().start();
        if !before(text, at).is_none_or(|c| is_ws(c) || OWNER_AFTER.contains(c)) {
            continue;
        }
        let name = m.get(1).unwrap().as_str().trim_end_matches(['-', '_']);
        if !name.is_empty() && seen.insert(name) {
            out.push(name.to_owned());
        }
    }
    out
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

fn valid(y: u32, m: u32, d: u32) -> Option<String> {
    // JavaScript 的 `new Date(y, …)` 把 0–99 年當成 1900 年代，所以這些年份都不算。
    if y < 100 {
        return None;
    }
    NaiveDate::from_ymd_opt(y as i32, m, d).map(|_| format!("{y}-{m:02}-{d:02}"))
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
    // i18n-ignore
    let month = "月".as_bytes();
    // i18n-ignore
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

/// 待辦的截止日（沒寫年份就是今年）。
pub fn parse_due(text: &str, today: NaiveDate) -> Option<String> {
    let b = text.as_bytes();
    if let Some((y, m, d)) = full_date(b) {
        return valid(y, m, d);
    }
    let (m, d) = slash_date(b).or_else(|| chinese_date(b))?;
    valid(today.year() as u32, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Case {
        name: String,
        today: String,
        text: String,
        expect: serde_json::Value,
    }

    /// 和前端的 `doc-index.test.ts` 用同一份測試資料，確保兩邊解析的結果一樣。
    #[test]
    fn matches_the_frontend_parser() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../web/src/doc-index.cases.json")).unwrap();
        assert!(cases.len() > 10);
        for c in cases {
            let today = NaiveDate::parse_from_str(&c.today, "%Y-%m-%d").unwrap();
            let got = serde_json::to_value(parse_doc(&c.text, today)).unwrap();
            assert_eq!(got, c.expect, "{}", c.name);
        }
    }

    #[test]
    fn due_dates() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 21).unwrap();
        let due = |s: &str| parse_due(s, today);
        assert_eq!(due("2026/1/5 前").as_deref(), Some("2026-01-05"));
        assert_eq!(due("12月31號").as_deref(), Some("2026-12-31"));
        assert_eq!(due("10/25").as_deref(), Some("2026-10-25"));
        assert_eq!(due("2/30"), None);
        assert_eq!(due("版本 1.2.3"), None);
        assert_eq!(due("比例 1/2/3"), None);
        assert_eq!(due("12026-10-25"), None);
        assert_eq!(due("2026-10-255"), None);
        assert_eq!(due("0099-01-01"), None);
        // 月份兩位數不合法時退回一位數
        assert_eq!(due("2026-1-5").as_deref(), Some("2026-01-05"));
    }

    #[test]
    fn inline_code_is_blanked() {
        assert_eq!(blank_code("a `中` b"), "a       b");
        assert_eq!(blank_code("``a`"), "`   ");
        assert_eq!(blank_code("`` x ` y ``z"), "           z");
        assert_eq!(blank_code("`未關"), "`未關");
    }
}
