//! 整理文件：在中文與英文、數字之間補上空格（俗稱「盤古之白」）。
//!
//! 走訪 Markdown 語法樹，只處理一般文字，以及文字與粗體、連結、行內程式碼等相鄰的邊界；
//! 程式碼、網址、數學公式、HTML 一律不動。結果是「要在哪些位置插入空格」的清單，
//! 前端可以一次套用成一個可復原的編輯。重複執行不會再插入（冪等）。
//!
//! 規則參考《中文文案排版指北》：中文與英文、數字之間加空格；全形標點旁不加。

use comrak::nodes::{NodeValue, Sourcepos};
use comrak::{parse_document, Arena, Node};

use crate::DocKind;

/// 中文、日文假名、注音。
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF   // 平假名、片假名
        | 0x3100..=0x312F // 注音符號
        | 0x31A0..=0x31BF // 注音符號擴充
        | 0x3400..=0x4DBF // 擴充 A
        | 0x4E00..=0x9FFF // 基本漢字
        | 0xF900..=0xFAFF // 相容漢字
        | 0x20000..=0x3134F // 擴充 B 之後
    )
}

/// 英文字母（含帶重音的拉丁字母）與數字。
fn is_latin(c: char) -> bool {
    c.is_ascii_alphanumeric() || (c.is_alphabetic() && (c as u32) >= 0xC0 && (c as u32) < 0x250)
}

/// `left` 與 `right` 之間是否需要空格。百分比後面接中文時也加（「50% 的人」）。
fn needs_space(left: char, right: char) -> bool {
    (is_cjk(left) && is_latin(right)) || ((is_latin(left) || left == '%') && is_cjk(right))
}

/// 純文字內部需要插入空格的位置（位元組位移）。
fn positions_in(text: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut prev: Option<char> = None;
    for (i, c) in text.char_indices() {
        if let Some(p) = prev {
            if needs_space(p, c) {
                out.push(i);
            }
        }
        prev = Some(c);
    }
    out
}

/// 每一行開頭在原始文字中的位元組位移。
fn line_starts(src: &str) -> Vec<usize> {
    std::iter::once(0)
        .chain(src.match_indices('\n').map(|(i, _)| i + 1))
        .collect()
}

/// 節點在原始文字中的範圍 `[start, end)`（位元組）。
fn byte_range(pos: Sourcepos, lines: &[usize], src: &str) -> Option<(usize, usize)> {
    let start = lines.get(pos.start.line.checked_sub(1)?)? + pos.start.column.checked_sub(1)?;
    let end = lines.get(pos.end.line.checked_sub(1)?)? + pos.end.column;
    (start <= end && end <= src.len() && src.is_char_boundary(start) && src.is_char_boundary(end))
        .then_some((start, end))
}

/// 把文字節點的每個字對應回原始文字的位置。原始文字可能多了跳脫字元（`\*`）或
/// HTML 實體（`&amp;`）；對不上時回傳 `None`，這個節點就不處理。
fn align(literal: &str, source: &str) -> Option<Vec<usize>> {
    let mut map = Vec::with_capacity(literal.len());
    let mut i = 0;
    for c in literal.chars() {
        let rest = source.get(i..)?;
        if let Some(len) = entity_len(rest) {
            // `&amp;` 之類的實體在文字裡是一個字。
            map.push(i);
            i += len;
        } else if rest.starts_with(c) {
            map.push(i);
            i += c.len_utf8();
        } else if rest.starts_with('\\') && rest[1..].starts_with(c) {
            map.push(i + 1);
            i += 1 + c.len_utf8();
        } else {
            return None;
        }
    }
    (i == source.len()).then_some(map)
}

/// `&amp;`、`&#39;` 這類 HTML 實體的長度。
fn entity_len(s: &str) -> Option<usize> {
    let body = s.strip_prefix('&')?;
    let semi = body.find(';').filter(|&n| (1..=31).contains(&n))?;
    body[..semi]
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '#')
        .then_some(semi + 2)
}

/// 行內節點在邊界上的樣子：第一個與最後一個看得到的字。`None` 表示這個節點的邊界不加空格。
#[derive(Clone, Copy)]
struct Edge {
    first: char,
    last: char,
}

/// 用來代表英文的字（網址、數學公式在邊界上當成英文）。
const LATIN: char = 'a';

fn edge<'a>(node: Node<'a>) -> Option<Edge> {
    let data = node.data();
    match &data.value {
        NodeValue::Text(t) => Some(Edge {
            first: t.chars().next()?,
            last: t.chars().last()?,
        }),
        NodeValue::Code(c) => Some(Edge {
            first: c.literal.chars().next()?,
            last: c.literal.chars().last()?,
        }),
        NodeValue::Math(_) => Some(Edge {
            first: LATIN,
            last: LATIN,
        }),
        NodeValue::Link(_) if is_autolink(node) => Some(Edge {
            first: LATIN,
            last: LATIN,
        }),
        NodeValue::Emph
        | NodeValue::Strong
        | NodeValue::Strikethrough
        | NodeValue::Link(_)
        | NodeValue::Image(_) => {
            let first = node.children().find_map(edge)?.first;
            let last = node.children().filter_map(edge).last()?.last;
            Some(Edge { first, last })
        }
        _ => None,
    }
}

/// 自動連結（直接寫網址）的文字就是網址本身，不能插入空格。
fn is_autolink<'a>(node: Node<'a>) -> bool {
    let data = node.data();
    let NodeValue::Link(link) = &data.value else {
        return false;
    };
    let text = node.collect_text();
    text == link.url
        || link.url.ends_with(&text)
        || text.starts_with("http")
        || text.contains("://")
}

struct Walker<'s> {
    src: &'s str,
    lines: Vec<usize>,
    out: Vec<usize>,
}

impl<'s> Walker<'s> {
    fn range(&self, node: Node<'_>) -> Option<(usize, usize)> {
        byte_range(node.data().sourcepos, &self.lines, self.src)
    }

    fn walk<'a>(&mut self, node: Node<'a>) {
        let skip_children = match &node.data().value {
            NodeValue::Text(t) => {
                self.text(node, t);
                true
            }
            NodeValue::Code(_)
            | NodeValue::CodeBlock(_)
            | NodeValue::HtmlBlock(_)
            | NodeValue::HtmlInline(_)
            | NodeValue::Math(_)
            | NodeValue::FrontMatter(_) => true,
            NodeValue::Link(_) => is_autolink(node),
            _ => false,
        };
        if skip_children {
            return;
        }
        self.boundaries(node);
        for child in node.children() {
            self.walk(child);
        }
    }

    fn text(&mut self, node: Node<'_>, literal: &str) {
        let Some((start, end)) = self.range(node) else {
            return;
        };
        let source = &self.src[start..end];
        let inside = positions_in(literal);
        if inside.is_empty() {
            return;
        }
        if source == literal {
            self.out.extend(inside.iter().map(|p| start + p));
        } else if let Some(map) = align(literal, source) {
            // 文字裡第 n 個字對應到原始文字的位置。
            let char_index: Vec<usize> = literal.char_indices().map(|(i, _)| i).collect();
            for p in inside {
                if let Ok(n) = char_index.binary_search(&p) {
                    self.out.push(start + map[n]);
                }
            }
        }
    }

    /// 相鄰的行內節點之間（例如「中文**English**」）。
    fn boundaries<'a>(&mut self, parent: Node<'a>) {
        let children: Vec<Node<'a>> = parent.children().collect();
        for pair in children.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            // 文字節點彼此相鄰的情況，交給上面的文字處理（comrak 有時會把文字拆成好幾段）。
            if matches!(a.data().value, NodeValue::Text(_))
                && matches!(b.data().value, NodeValue::Text(_))
            {
                if let (Some(ea), Some(eb), Some((_, a_end)), Some((b_start, _))) =
                    (edge(a), edge(b), self.range(a), self.range(b))
                {
                    if a_end == b_start && needs_space(ea.last, eb.first) {
                        self.out.push(b_start);
                    }
                }
                continue;
            }
            let (Some(ea), Some(eb)) = (edge(a), edge(b)) else {
                continue;
            };
            let (Some((_, a_end)), Some((b_start, _))) = (self.range(a), self.range(b)) else {
                continue;
            };
            // 兩個節點中間在原始文字裡必須緊鄰（沒有空白、換行或其他符號）。
            if a_end == b_start && needs_space(ea.last, eb.first) {
                self.out.push(b_start);
            }
        }
    }
}

/// 需要插入空格的位置（原始文字中的位元組位移，由小到大、不重複）。
pub fn spacing_positions(text: &str, kind: DocKind) -> Vec<usize> {
    match kind {
        DocKind::Json => Vec::new(),
        DocKind::Text => positions_in(text),
        DocKind::Markdown => {
            let options = crate::markdown::comrak_options(&crate::RenderOptions {
                kind,
                sourcepos: true,
                hardbreaks: false,
            });
            let arena = Arena::new();
            let root = parse_document(&arena, text, &options);
            let mut w = Walker {
                src: text,
                lines: line_starts(text),
                out: Vec::new(),
            };
            w.walk(root);
            let mut out = w.out;
            out.sort_unstable();
            out.dedup();
            // 保險：前後已經是空白的位置不插入。
            out.retain(|&p| {
                let before = text[..p].chars().next_back();
                let after = text[p..].chars().next();
                !before.is_some_and(char::is_whitespace) && !after.is_some_and(char::is_whitespace)
            });
            out
        }
    }
}

/// 在中文與英文、數字之間補上空格。
pub fn add_spacing(text: &str, kind: DocKind) -> String {
    let positions = spacing_positions(text, kind);
    let mut out = String::with_capacity(text.len() + positions.len());
    let mut last = 0;
    for p in positions {
        out.push_str(&text[last..p]);
        out.push(' ');
        last = p;
    }
    out.push_str(&text[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn md(s: &str) -> String {
        add_spacing(s, DocKind::Markdown)
    }

    #[test]
    fn spaces_between_chinese_and_latin() {
        assert_eq!(
            md("今天用Rust寫了3個工具。\n"),
            "今天用 Rust 寫了 3 個工具。\n"
        );
        assert_eq!(md("50%的人喜歡iPhone15\n"), "50% 的人喜歡 iPhone15\n");
        assert_eq!(md("# 標題Title\n"), "# 標題 Title\n");
        // 全形標點旁不加。
        assert_eq!(
            md("「Rust」很好，Go也不錯。\n"),
            "「Rust」很好，Go 也不錯。\n"
        );
        // 日文假名也算。
        assert_eq!(md("これはTestです\n"), "これは Test です\n");
    }

    #[test]
    fn spaces_around_inline_elements_but_not_inside_code() {
        assert_eq!(
            md("使用`npm`安裝**React**元件\n"),
            "使用 `npm` 安裝 **React** 元件\n"
        );
        // 程式碼內部不動；程式碼開頭是英文時，前面照樣加空格。
        assert_eq!(md("程式`let a=中文`不動\n"), "程式 `let a=中文`不動\n");
        // 連結只改看得到的文字，網址不動；連結文字結尾是英文時，後面也加空格。
        assert_eq!(
            md("見[文件Docs](https://x.com/路徑)說明\n"),
            "見[文件 Docs](https://x.com/路徑) 說明\n"
        );
        assert_eq!(md("**粗體**English\n"), "**粗體** English\n");
        assert_eq!(md("公式$E=mc^2$很有名\n"), "公式 $E=mc^2$ 很有名\n");
    }

    #[test]
    fn leaves_code_blocks_urls_and_html_alone() {
        let src = "```\n中文English\n```\n\n網址https://example.com/a中文b說明\n\n<div>中文English</div>\n";
        assert_eq!(
            md(src),
            "```\n中文English\n```\n\n網址 https://example.com/a中文b說明\n\n<div>中文English</div>\n"
        );
    }

    #[test]
    fn handles_escapes_and_entities() {
        assert_eq!(md("\\*註記A中文\n"), "\\*註記 A 中文\n");
        assert_eq!(md("甲&amp;乙B\n"), "甲&amp;乙 B\n");
        assert_eq!(md("A&B中文\n"), "A&B 中文\n");
    }

    #[test]
    fn tables_and_lists() {
        let src = "- 第1項\n- Item二\n\n| 欄A | 中B |\n|---|---|\n| 值1 | x中 |\n";
        assert_eq!(
            md(src),
            "- 第 1 項\n- Item 二\n\n| 欄 A | 中 B |\n|---|---|\n| 值 1 | x 中 |\n"
        );
    }

    #[test]
    fn is_idempotent() {
        let src = "使用`npm`安裝**React**元件，共3個。\n\n- 第1項Item\n";
        let once = md(src);
        assert_eq!(md(&once), once);
        assert!(spacing_positions(&once, DocKind::Markdown).is_empty());
    }

    #[test]
    fn plain_text_and_json() {
        assert_eq!(add_spacing("中文English", DocKind::Text), "中文 English");
        assert_eq!(
            add_spacing("{\"中文\":\"English中\"}", DocKind::Json),
            "{\"中文\":\"English中\"}"
        );
    }

    #[test]
    fn front_matter_is_untouched() {
        let src = "---\ntitle: 中文Title\n---\n\n內文Text\n";
        assert_eq!(md(src), "---\ntitle: 中文Title\n---\n\n內文 Text\n");
    }
}
