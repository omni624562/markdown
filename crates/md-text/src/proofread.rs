//! 兩國用語、錯別字與中文標點檢查：找出中國用語（建議台灣的說法）、台灣常見的錯別字，
//! 以及中文句子裡混進的半形標點。只比對詞語，不猜文意；同一個詞在台灣也有別的意思時標成「依文意」，
//! 不會在整份修正時自動換掉。
//!
//! 位置都是位元組位移（WebAssembly 綁定再換成 JavaScript 的 UTF-16 位移）。

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use serde::Serialize;

use crate::scan::{before, is_ws, run};

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Term {
    /// 在詞表（`terms()`）裡的位置。
    #[serde(skip)]
    pub id: usize,
    /// 要找的詞（標點是「不再提示」記下的名稱，例如 `半形標點 ,`）。
    pub word: String,
    /// 建議的寫法（第一個是預設）。半形括號是空的：建議是把括號換成全形、內容照舊（見 `suggestion`）。
    pub to: Vec<String>,
    /// `cn`（中國用語）、`typo`（錯字）或 `punct`（標點）。
    pub kind: &'static str,
    /// 依文意判斷：在台灣也有其他意思，整份修正時不自動換。
    pub context: bool,
    /// 說明（依文意的詞會寫什麼情況才要改）。
    pub note: Option<String>,
    /// 出現在這些詞裡時不算（例如「數據機」）。
    #[serde(skip)]
    pub except: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TermMatch {
    pub from: usize,
    pub to: usize,
    /// 詞在 `terms()` 裡的位置。
    pub id: usize,
}

impl TermMatch {
    pub fn term(&self) -> &'static Term {
        &terms()[self.id]
    }

    /// 建議的寫法（`text` 是檢查的那份文字）。
    pub fn suggestion(&self, text: &str) -> String {
        match self.term().to.first() {
            Some(to) => to.clone(),
            None => format!("（{}）", &text[self.from + 1..self.to - 1]),
        }
    }
}

fn parse(block: &'static str, kind: &'static str) -> impl Iterator<Item = Term> {
    block
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with("# "))
        .map(move |line| {
            let context = line.starts_with('?');
            let line = line.strip_prefix('?').unwrap_or(line);
            let (main, except) = line.split_once('~').unwrap_or((line, ""));
            let (pair, note) = match main.split_once('#') {
                Some((pair, note)) => (pair, Some(note.to_owned())),
                None => (main, None),
            };
            let (word, to) = pair.split_once('=').unwrap_or((pair, ""));
            Term {
                id: 0,
                word: word.to_owned(),
                to: to.split('/').map(str::to_owned).collect(),
                kind,
                context,
                note,
                except: except
                    .split(',')
                    .filter(|e| !e.is_empty())
                    .map(str::to_owned)
                    .collect(),
            }
        })
}

/// 半形標點與建議的全形標點；最後的括號另外處理。
const MARKS: [(&str, &str); 7] = [
    (",", "，"),
    (".", "。"),
    (";", "；"),
    (":", "："),
    ("!", "！"),
    ("?", "？"),
    ("()", ""),
];

/// 詞表：中國用語、錯別字，最後是半形標點。
pub fn terms() -> &'static [Term] {
    static TERMS: OnceLock<Vec<Term>> = OnceLock::new();
    TERMS.get_or_init(|| {
        let marks = MARKS.iter().map(|&(mark, full)| Term {
            id: 0,
            word: punct_key(mark),
            to: [full]
                .into_iter()
                .filter(|f| !f.is_empty())
                .map(str::to_owned)
                .collect(),
            kind: "punct",
            context: false,
            note: None,
            except: Vec::new(),
        });
        let mut list: Vec<Term> = parse(include_str!("../data/cn.txt"), "cn")
            .chain(parse(include_str!("../data/typo.txt"), "typo"))
            .chain(marks)
            .collect();
        for (i, t) in list.iter_mut().enumerate() {
            t.id = i;
        }
        list
    })
}

/// 半形標點在詞表裡的位置。
fn mark_id(mark: &str) -> usize {
    let first = terms().len() - MARKS.len();
    first
        + MARKS
            .iter()
            .position(|m| m.0 == mark)
            .unwrap_or(MARKS.len() - 1)
}

/// 依第一個字分組的詞表，長的詞排前面（「字符串」優先於「字符」）。
fn by_first_char() -> &'static HashMap<char, Vec<&'static Term>> {
    static INDEX: OnceLock<HashMap<char, Vec<&'static Term>>> = OnceLock::new();
    INDEX.get_or_init(|| {
        let mut index = HashMap::<char, Vec<&Term>>::new();
        for t in terms().iter().filter(|t| t.kind != "punct") {
            if let Some(c) = t.word.chars().next() {
                index.entry(c).or_default().push(t);
            }
        }
        for list in index.values_mut() {
            list.sort_by_key(|t| std::cmp::Reverse(t.word.chars().count()));
        }
        index
    })
}

/// 合併重疊的範圍並排序，之後用二分搜尋判斷某段文字有沒有落在其中。
struct Ranges(Vec<(usize, usize)>);

impl Ranges {
    fn new(mut ranges: Vec<(usize, usize)>) -> Self {
        ranges.sort_by_key(|r| r.0);
        let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
        for (a, b) in ranges {
            match merged.last_mut() {
                Some(last) if a <= last.1 => last.1 = last.1.max(b),
                _ => merged.push((a, b)),
            }
        }
        Self(merged)
    }

    /// `from..to` 和其中某個範圍重疊。
    fn hits(&self, from: usize, to: usize) -> bool {
        let i = self.0.partition_point(|r| r.0 < to);
        i > 0 && self.0[i - 1].1 > from
    }
}

/// `text` 在 `from..to` 這段是不是剛好落在詞 `e` 裡（例如「數據」在「數據機」裡）。
fn covers(text: &str, from: usize, to: usize, e: &str) -> bool {
    let word = &text[from..to];
    e.char_indices().any(|(i, _)| {
        e[i..].starts_with(word) && from >= i && text.get(from - i..from - i + e.len()) == Some(e)
    })
}

fn find_terms(text: &str, skip: &Ranges, ignore: &HashSet<String>) -> Vec<TermMatch> {
    let index = by_first_char();
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(c) = text[i..].chars().next() {
        let rest = &text[i..];
        let Some(term) = index
            .get(&c)
            .and_then(|list| list.iter().find(|t| rest.starts_with(&t.word)))
        else {
            i += c.len_utf8();
            continue;
        };
        let (from, to) = (i, i + term.word.len());
        i = to;
        if ignore.contains(&term.word)
            || skip.hits(from, to)
            || term.except.iter().any(|e| covers(text, from, to, e))
        {
            continue;
        }
        out.push(TermMatch {
            from,
            to,
            id: term.id,
        });
    }
    out
}

/// 「不再提示」記下的名稱，例如「半形標點 ,」（存在設定裡，所以不翻譯）。
pub fn punct_key(mark: &str) -> String {
    format!("半形標點 {mark}")
}

fn is_cjk(c: char) -> bool {
    matches!(c, '\u{3400}'..='\u{9fff}' | '\u{f900}'..='\u{faff}')
}

/// 中文句子裡的半形標點：中文字後面的 `, . ; : ! ?`（後面的空白一起換掉，全形標點本身就有間隔），
/// 以及前面是中文字、裡面有中文的半形括號。句點只在後面是行尾、空白或中文字時才算（避免 3.5、網址、英文縮寫）。
fn find_punctuation(text: &str, skip: &Ranges, ignore: &HashSet<String>) -> Vec<TermMatch> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if !matches!(b[i], b',' | b'.' | b';' | b':' | b'!' | b'?')
            || !before(text, i).is_some_and(is_cjk)
        {
            i += 1;
            continue;
        }
        if b[i] == b'.'
            && !text[i + 1..]
                .chars()
                .next()
                .is_none_or(|c| is_ws(c) || is_cjk(c))
        {
            i += 1;
            continue;
        }
        let from = i;
        let mut to = i + 1 + run(text, i + 1, |c| c == ' ' || c == '\t');
        i = to;
        // 行尾的空白留著（Markdown 的換行）；只換掉標點與後面接著文字的空白。
        if to > from + 1 && (to == b.len() || b[to] == b'\n') {
            to = from + 1;
        }
        let id = mark_id(&text[from..from + 1]);
        if ignore.contains(&terms()[id].word) || skip.hits(from, to) {
            continue;
        }
        out.push(TermMatch { from, to, id });
    }
    let mut i = 0;
    while let Some(p) = text[i..].find('(') {
        let at = i + p;
        i = at + 1;
        if !before(text, at).is_some_and(is_cjk) {
            continue;
        }
        let Some(len) = text[at + 1..].find(['(', ')', '\n']) else {
            continue;
        };
        let end = at + 1 + len;
        if b[end] != b')' || !text[at + 1..end].chars().any(is_cjk) {
            continue;
        }
        i = end + 1;
        if ignore.contains(&punct_key("()")) || skip.hits(at, end + 1) {
            continue;
        }
        out.push(TermMatch {
            from: at,
            to: end + 1,
            id: mark_id("()"),
        });
    }
    out.sort_by_key(|m| m.from);
    out
}

/// 檢查 `text`：用語、錯字與標點（標點和用語重疊時以用語為準），依位置排序。
/// `skip` 是不檢查的範圍（程式碼、網址等），`ignore` 是使用者選擇不再提示的詞。
pub fn proofread(text: &str, skip: &[(usize, usize)], ignore: &HashSet<String>) -> Vec<TermMatch> {
    let skip = Ranges::new(skip.to_vec());
    let mut all = find_terms(text, &skip, ignore);
    let on_term = Ranges::new(all.iter().map(|m| (m.from, m.to)).collect());
    all.extend(
        find_punctuation(text, &skip, ignore)
            .into_iter()
            .filter(|p| !on_term.hits(p.from, p.to)),
    );
    all.sort_by_key(|m| m.from);
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none() -> HashSet<String> {
        HashSet::new()
    }

    fn words(text: &str, skip: &[(usize, usize)]) -> Vec<String> {
        find_terms(text, &Ranges::new(skip.to_vec()), &none())
            .into_iter()
            .map(|m| m.term().word.clone())
            .collect()
    }

    /// 依建議把標點全部換掉。
    fn fix(text: &str, skip: &[(usize, usize)]) -> String {
        let mut out = text.to_owned();
        for m in find_punctuation(text, &Ranges::new(skip.to_vec()), &none())
            .iter()
            .rev()
        {
            out.replace_range(m.from..m.to, &m.suggestion(text));
        }
        out
    }

    #[test]
    fn finds_longest_terms_first() {
        assert_eq!(
            words("把源代碼的字符串存進數據庫，再看視頻", &[]),
            ["源代碼", "字符串", "數據庫", "視頻"]
        );
        assert_eq!(words("即然如此，就再接再勵", &[]), ["即然", "再接再勵"]);
        assert_eq!(words("人工智能與智能手機", &[]), ["人工智能", "智能"]);
    }

    #[test]
    fn words_also_used_in_taiwan_are_fine() {
        assert!(words(
            "在線上開會，數據機壞了，質量守恆定律，智能障礙，點擊率",
            &[]
        )
        .is_empty());
        assert!(words("以經濟成長為目標，因該公司要求", &[]).is_empty());
        assert!(words("程序正義與法律程序", &[]).is_empty());
    }

    #[test]
    fn skips_ranges_and_ignored_words() {
        let text = "`視頻` 和 視頻";
        assert_eq!(words(text, &[(0, 8)]), ["視頻"]);
        let ignore = HashSet::from(["視頻".to_owned()]);
        assert!(find_terms(text, &Ranges::new(vec![]), &ignore).is_empty());
    }

    #[test]
    fn context_terms_are_marked() {
        let m = proofread("默認的質量很好", &[], &none());
        let got: Vec<_> = m
            .iter()
            .map(|x| (x.term().word.as_str(), x.term().context, x.from, x.to))
            .collect();
        assert_eq!(got, [("默認", false, 0, 6), ("質量", true, 9, 15)]);
        assert_eq!(m[0].term().to, ["預設"]);
    }

    #[test]
    fn term_list_is_sound() {
        let mut seen = HashSet::new();
        assert!(terms().len() > 100);
        for (i, t) in terms().iter().enumerate() {
            assert_eq!(t.id, i);
            assert!(seen.insert(&t.word), "重複：{}", t.word);
            assert!(
                !t.word.is_empty() && (!t.to.is_empty() || t.kind == "punct"),
                "{}",
                t.word
            );
            assert!(
                t.context || !t.to.contains(&t.word),
                "建議成自己：{}",
                t.word
            );
        }
        let t = terms().iter().find(|t| t.word == "質量").unwrap();
        assert_eq!(t.note.as_deref(), Some("指好壞時（物理的質量不用改）"));
        assert_eq!(t.except, ["質量守恆", "質量數"]);
    }

    #[test]
    fn half_width_punctuation() {
        assert_eq!(
            fix("今天開會, 討論預算.明天再說!真的嗎?", &[]),
            "今天開會，討論預算。明天再說！真的嗎？"
        );
        assert_eq!(fix("時間: 10:00", &[]), "時間：10:00");
        assert_eq!(fix("注意;這很重要", &[]), "注意；這很重要");
        assert_eq!(fix("結束了.\n下一段", &[]), "結束了。\n下一段");
        // 行尾的空白保留（Markdown 換行）
        assert_eq!(fix("第一行.  \n第二行", &[]), "第一行。  \n第二行");
        for t in [
            "版本 3.5 已發布",
            "Hello, world. OK?",
            "請看 example.com",
            "比例是 1:2",
            "然後...",
            "Version 2.0",
        ] {
            assert_eq!(fix(t, &[]), t);
        }
    }

    #[test]
    fn parentheses() {
        assert_eq!(fix("台北(信義區)的辦公室", &[]), "台北（信義區）的辦公室");
        assert_eq!(fix("用 Excel(試算表)", &[]), "用 Excel(試算表)");
        assert_eq!(fix("單位(kg)", &[]), "單位(kg)");
        assert_eq!(fix("[說明](文件/說明.md)", &[]), "[說明](文件/說明.md)");
    }

    #[test]
    fn punctuation_skip_and_ignore() {
        let text = "程式`中文,不改`之後, 要改";
        let code = (text.find('`').unwrap(), text.rfind('`').unwrap() + 1);
        assert_eq!(fix(text, &[code]), "程式`中文,不改`之後，要改");
        let ignore = HashSet::from([punct_key(",")]);
        assert!(find_punctuation("中文,中文", &Ranges::new(vec![]), &ignore).is_empty());
    }

    #[test]
    fn terms_win_over_punctuation() {
        let m = proofread("硬盤(中文)與 智能.", &[], &none());
        let got: Vec<_> = m.iter().map(|x| x.term().word.as_str()).collect();
        assert_eq!(got, ["硬盤", "半形標點 ()", "智能", "半形標點 ."]);
    }
}
