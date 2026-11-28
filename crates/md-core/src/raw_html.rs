//! 文件裡直接寫的 HTML 區塊（例如從 Word、Confluence 轉出來的 `<table>…</table>`）：只留安全的標籤與屬性。
//!
//! 預覽在桌面版裡可以呼叫本機功能，所以不能照抄別人傳來的 HTML：`<script>`、`on…` 事件、`javascript:` 連結、
//! `<iframe>`、`<style>` 等一律拿掉，只放行排版用的標籤（表格、清單、段落、文字格式、連結、圖片）。
//! `style` 只留 `text-align`、`vertical-align`、`width`，讓欄寬與置中照原樣顯示。

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use ammonia::Builder;

const TAGS: &[&str] = &[
    // 表格
    "table",
    "caption",
    "colgroup",
    "col",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    // 段落與清單
    "p",
    "div",
    "span",
    "br",
    "hr",
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "blockquote",
    "pre",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    // 文字格式
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "del",
    "ins",
    "mark",
    "sup",
    "sub",
    "small",
    "code",
    "kbd",
    // 連結與圖片
    "a",
    "img",
    // 可收合區塊
    "details",
    "summary",
];

static CLEANER: LazyLock<Builder<'static>> = LazyLock::new(|| {
    let mut b = Builder::empty();
    b.add_tags(TAGS.iter().copied())
        .add_generic_attributes(["id", "title", "style", "align"])
        .tag_attributes(HashMap::from([
            ("a", HashSet::from(["href", "name"])),
            ("img", HashSet::from(["src", "alt", "width", "height"])),
            ("ol", HashSet::from(["type", "start"])),
            ("td", HashSet::from(["colspan", "rowspan", "valign"])),
            ("th", HashSet::from(["colspan", "rowspan", "valign"])),
            ("col", HashSet::from(["span", "width"])),
            ("colgroup", HashSet::from(["span"])),
            ("details", HashSet::from(["open"])),
        ]))
        .url_schemes(HashSet::from(["http", "https", "mailto"]))
        .link_rel(Some("noopener noreferrer"))
        .attribute_filter(|_tag, attr, value| match attr {
            "style" => {
                let kept = safe_style(value);
                (!kept.is_empty()).then(|| kept.into())
            }
            _ => Some(value.into()),
        });
    b
});

/// HTML 區塊整理成安全的 HTML。
pub(crate) fn clean(html: &str) -> String {
    CLEANER.clean(html).to_string()
}

/// `style` 只留排版用的幾項，而且值只能是簡單的字（數字、百分比、left 之類），不能有 `url(`、`expression(` 等。
fn safe_style(style: &str) -> String {
    let mut out = Vec::new();
    for decl in style.split(';') {
        let Some((name, value)) = decl.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if !matches!(name.as_str(), "text-align" | "vertical-align" | "width") {
            continue;
        }
        if value.is_empty()
            || !value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '%' | '.' | '-' | ' '))
        {
            continue;
        }
        out.push(format!("{name}: {value}"));
    }
    out.join("; ")
}

/// 整理過的 HTML 表格（[`clean`] 的輸出：標籤成對、屬性有引號）轉成 Markdown 的表格，給匯出 Word 用。
/// 第一列當標題；儲存格裡的段落、清單項目、換行用 `<br>` 分開，其他標籤拿掉；合併儲存格不展開。
/// 沒有表格時回傳 None。
pub(crate) fn table_to_markdown(html: &str) -> Option<String> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut cell: Option<String> = None;
    let mut rest = html;
    let brk = |cell: &mut Option<String>| {
        if let Some(c) = cell {
            if !c.trim().is_empty() && !c.ends_with("<br>") {
                c.push_str("<br>");
            }
        }
    };
    while let Some(lt) = rest.find('<') {
        if let Some(c) = cell.as_mut() {
            c.push_str(&rest[..lt].replace('|', "\\|").replace(['\n', '\r'], " "));
        }
        let Some(gt) = rest[lt..].find('>') else {
            break;
        };
        let tag = rest[lt + 1..lt + gt].trim().to_ascii_lowercase();
        let name = tag
            .trim_start_matches('/')
            .split([' ', '/'])
            .next()
            .unwrap_or("");
        let closing = tag.starts_with('/');
        match (name, closing) {
            ("tr", false) => rows.push(Vec::new()),
            ("td" | "th", false) => cell = Some(String::new()),
            ("td" | "th", true) => {
                if let (Some(c), Some(row)) = (cell.take(), rows.last_mut()) {
                    let c = c.trim().trim_end_matches("<br>").trim().to_string();
                    row.push(c);
                }
            }
            ("br", _) | ("p" | "li" | "div", true) => brk(&mut cell),
            ("li", false) => {
                if let Some(c) = cell.as_mut() {
                    c.push_str("• ");
                }
            }
            _ => {}
        }
        rest = &rest[lt + gt + 1..];
    }
    rows.retain(|r| !r.is_empty());
    let width = rows.iter().map(Vec::len).max()?;
    let line = |r: &[String]| {
        let cells: Vec<&str> = (0..width)
            .map(|i| r.get(i).map_or("", String::as_str))
            .collect();
        format!("| {} |", cells.join(" | "))
    };
    let mut out = vec![line(&rows[0]), format!("|{}", " --- |".repeat(width))];
    out.extend(rows[1..].iter().map(|r| line(r)));
    Some(out.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_tables_lists_and_layout_styles() {
        let html = clean(
            "<table>\n<colgroup>\n<col style=\"width: 15%\" />\n</colgroup>\n<thead>\n<tr>\n<th style=\"text-align: center;\"><strong>修訂時間</strong></th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td style=\"text-align: center;\">2026/07/21</td>\n<td><ul><li><p>初版</p></li></ul><ol type=\"1\"><li>第一點</li></ol></td>\n</tr>\n</tbody>\n</table>",
        );
        assert!(html.contains("<col style=\"width: 15%\">"), "{html}");
        assert!(
            html.contains("<th style=\"text-align: center\"><strong>修訂時間</strong></th>"),
            "{html}"
        );
        assert!(
            html.contains("<ol type=\"1\"><li>第一點</li></ol>"),
            "{html}"
        );
        assert!(html.contains("<ul><li><p>初版</p></li></ul>"), "{html}");
    }

    #[test]
    fn removes_scripts_events_and_dangerous_urls() {
        for (src, bad) in [
            ("<img src=x onerror=alert(1)>", "onerror"),
            ("<script>alert(1)</script>", "script"),
            ("<a href=\"javascript:alert(1)\">x</a>", "javascript"),
            ("<iframe src=\"https://ado.test\"></iframe>", "iframe"),
            (
                "<div style=\"background: url(https://ado.test/x.png)\">x</div>",
                "url(",
            ),
            (
                "<div style=\"width: expression(alert(1))\">x</div>",
                "expression",
            ),
            ("<style>body{display:none}</style>", "display"),
            (
                "<form action=\"https://ado.test\"><input name=x></form>",
                "input",
            ),
            ("<svg><script>alert(1)</script></svg>", "alert"),
        ] {
            let html = clean(src);
            assert!(!html.to_ascii_lowercase().contains(bad), "{src} → {html}");
        }
    }

    #[test]
    fn keeps_anchors_and_safe_links() {
        assert_eq!(
            clean("<a id=\"資源配置\"></a>"),
            "<a id=\"資源配置\" rel=\"noopener noreferrer\"></a>"
        );
        let html =
            clean("<a href=\"https://ado.test/wiki\">Wiki</a> <a href=\"docs/說明.md\">說明</a>");
        assert!(html.contains("href=\"https://ado.test/wiki\""), "{html}");
        assert!(html.contains("href=\"docs/說明.md\""), "{html}");
    }

    #[test]
    fn converts_html_tables_to_markdown_tables() {
        let html = clean("<table><thead><tr><th style=\"text-align: center;\"><strong>修訂時間</strong></th><th>修訂紀錄</th></tr></thead><tbody><tr><td>2026/07/21</td><td><ul><li><p>初版</p></li><li>A|B</li></ul></td></tr><tr><td>只有一格</td></tr></tbody></table>");
        assert_eq!(
            table_to_markdown(&html).unwrap(),
            "| 修訂時間 | 修訂紀錄 |\n| --- | --- |\n| 2026/07/21 | • 初版<br>• A\\|B |\n| 只有一格 |  |"
        );
        assert_eq!(table_to_markdown("<p>沒有表格</p>"), None);
    }
}
