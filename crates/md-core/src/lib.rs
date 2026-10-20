//! Markdown 渲染核心：解析 GFM、產生 HTML、擷取標題大綱與字數統計。
//!
//! 這個 crate 不依賴任何平台 API，同時供 WebAssembly 前端與 CLI 使用。
//! 原始 HTML 一律不輸出、危險的 URL（如 `javascript:`）也會被過濾，
//! 因此渲染結果可以直接放進頁面。

mod stats;

use comrak::nodes::NodeValue;
use comrak::{format_html, parse_document, Anchorizer, Arena, Node, Options};

pub use stats::{count_text, Stats};

/// 渲染選項。
#[derive(Debug, Clone, Default)]
pub struct RenderOptions {
    /// 在每個區塊元素加上 `data-sourcepos`，前端用它做編輯器與預覽的捲動同步。
    pub sourcepos: bool,
    /// 把單一換行視為 `<br>`。
    pub hardbreaks: bool,
}

/// 文件中的一個標題，用於大綱（目錄）。
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct Heading {
    pub level: u8,
    pub text: String,
    /// 與渲染出的 HTML `id` 屬性一致的錨點。
    pub id: String,
    /// 標題在原始 Markdown 中的起始行（從 1 開始）。
    pub line: usize,
}

/// 單次渲染的完整結果。
#[derive(Debug, Clone)]
pub struct Rendered {
    pub html: String,
    pub headings: Vec<Heading>,
    pub stats: Stats,
}

impl Rendered {
    /// 文件標題：取第一個一級標題，沒有的話取第一個標題。
    pub fn title(&self) -> Option<&str> {
        self.headings
            .iter()
            .find(|h| h.level == 1)
            .or_else(|| self.headings.first())
            .map(|h| h.text.as_str())
    }
}

fn comrak_options(opts: &RenderOptions) -> Options<'static> {
    let mut o = Options::default();
    let ext = &mut o.extension;
    ext.strikethrough = true;
    ext.table = true;
    ext.autolink = true;
    ext.tasklist = true;
    ext.footnotes = true;
    ext.alerts = true;
    ext.header_id_prefix = Some(String::new());
    ext.front_matter_delimiter = Some("---".into());
    // 讓 `**粗體**緊接中文` 這類寫法也能正確辨識強調。
    ext.cjk_friendly_emphasis = true;

    o.render.sourcepos = opts.sourcepos;
    o.render.hardbreaks = opts.hardbreaks;
    o.render.github_pre_lang = false;
    o.render.tasklist_classes = true;
    o
}

/// 把 Markdown 渲染成 HTML 片段，並附上大綱與統計。
pub fn render(markdown: &str, opts: &RenderOptions) -> Rendered {
    let options = comrak_options(opts);
    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &options);

    let headings = collect_headings(root);
    let stats = count_text(&plain_text(root));

    let mut html = String::with_capacity(markdown.len() * 3 / 2);
    format_html(root, &options, &mut html).expect("writing to a String cannot fail");

    Rendered {
        html,
        headings,
        stats,
    }
}

/// 依文件順序收集標題。錨點的產生方式與 comrak 渲染 HTML 時相同，
/// 因此大綱連結一定對得上預覽中的 `id`。
fn collect_headings<'a>(root: Node<'a>) -> Vec<Heading> {
    let mut anchorizer = Anchorizer::new();
    root.descendants()
        .filter_map(|node| {
            let data = node.data();
            let NodeValue::Heading(ref h) = data.value else {
                return None;
            };
            let text = node.collect_text();
            Some(Heading {
                level: h.level,
                id: anchorizer.anchorize(&text),
                text: text.trim().to_string(),
                line: data.sourcepos.start.line,
            })
        })
        .collect()
}

/// 取出文件中讀者實際會看到的文字，區塊之間以換行分隔，供字數統計使用。
fn plain_text<'a>(root: Node<'a>) -> String {
    fn walk<'a>(node: Node<'a>, out: &mut String) {
        match node.data().value {
            NodeValue::FrontMatter(_) | NodeValue::HtmlBlock(_) | NodeValue::HtmlInline(_) => {}
            NodeValue::Text(ref t) => out.push_str(t),
            NodeValue::Code(ref c) => out.push_str(&c.literal),
            NodeValue::CodeBlock(ref c) => out.push_str(&c.literal),
            NodeValue::SoftBreak | NodeValue::LineBreak => out.push(' '),
            ref value => {
                let is_block = value.block();
                for child in node.children() {
                    walk(child, out);
                }
                if is_block {
                    out.push('\n');
                }
            }
        }
    }
    let mut out = String::new();
    walk(root, &mut out);
    out
}

/// 匯出時套用的獨立頁面樣式。
pub const DEFAULT_CSS: &str = include_str!("document.css");

/// 產生可直接開啟的完整 HTML 文件。
pub fn render_document(markdown: &str, opts: &RenderOptions, css: Option<&str>) -> String {
    let rendered = render(markdown, opts);
    let title = rendered.title().unwrap_or("Untitled");
    let mut out = String::with_capacity(rendered.html.len() + DEFAULT_CSS.len() + 256);
    out.push_str("<!doctype html>\n<html lang=\"zh-Hant-TW\">\n<head>\n<meta charset=\"utf-8\">\n");
    out.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
    out.push_str("<title>");
    out.push_str(&escape_html(title));
    out.push_str("</title>\n<style>\n");
    out.push_str(css.unwrap_or(DEFAULT_CSS));
    out.push_str("</style>\n</head>\n<body>\n<article class=\"markdown-body\">\n");
    out.push_str(&rendered.html);
    out.push_str("</article>\n</body>\n</html>\n");
    out
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(md: &str) -> Rendered {
        render(md, &RenderOptions::default())
    }

    #[test]
    fn renders_gfm_extensions() {
        let out = r("~~刪除~~\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] 完成\n- [ ] 未完成\n");
        assert!(out.html.contains("<del>刪除</del>"));
        assert!(out.html.contains("<table>"));
        assert!(out.html.contains("type=\"checkbox\""));
    }

    #[test]
    fn cjk_friendly_emphasis() {
        let out = r("這是**粗體**文字");
        assert!(out.html.contains("<strong>粗體</strong>"), "{}", out.html);
    }

    #[test]
    fn strips_raw_html_by_default() {
        let out = r("<script>alert(1)</script>\n\n[x](javascript:alert(1))");
        assert!(!out.html.contains("<script>"));
        assert!(!out.html.contains("javascript:"));
    }

    #[test]
    fn heading_ids_match_rendered_html() {
        let out = r("# 你好 World\n\n## 重複\n\n## 重複\n");
        let ids: Vec<_> = out.headings.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids, ["你好-world", "重複", "重複-1"]);
        for id in ids {
            assert!(
                out.html.contains(&format!("id=\"{id}\"")),
                "{id} missing in {}",
                out.html
            );
        }
        assert_eq!(out.headings[1].line, 3);
        assert_eq!(out.title(), Some("你好 World"));
    }

    #[test]
    fn front_matter_is_hidden() {
        let out = r("---\ntitle: 測試\n---\n\n內文\n");
        assert!(!out.html.contains("title:"));
        assert_eq!(out.stats.cjk_chars, 2);
    }

    #[test]
    fn sourcepos_is_optional() {
        assert!(!r("段落").html.contains("data-sourcepos"));
        let opts = RenderOptions {
            sourcepos: true,
            ..Default::default()
        };
        assert!(render("段落", &opts)
            .html
            .contains("data-sourcepos=\"1:1-1:6\""));
    }

    #[test]
    fn plain_text_separates_blocks() {
        let out = r("hello\n\nworld\n");
        assert_eq!(out.stats.latin_words, 2);
    }

    #[test]
    fn document_escapes_title() {
        let doc = render_document("# 1 < 2 & \"x\"\n", &RenderOptions::default(), None);
        assert!(doc.contains("<title>1 &lt; 2 &amp; &quot;x&quot;</title>"));
        assert!(doc.starts_with("<!doctype html>"));
    }
}
