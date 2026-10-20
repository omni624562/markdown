//! 文件渲染核心：Markdown、純文字與 JSON 轉成 HTML，並擷取大綱與字數統計。
//!
//! 這個 crate 不依賴任何平台 API，同時供 WebAssembly 前端與 CLI 使用。
//! 原始 HTML 一律不輸出、危險的 URL（如 `javascript:`）也會被過濾，
//! 因此渲染結果可以直接放進頁面。

mod html;
mod json;
mod markdown;
mod spacing;
mod stats;
mod table;

use html::escape_html;
pub use json::format_json;
pub use spacing::{add_spacing, spacing_positions};
pub use stats::{count_text, Stats};
pub use table::{format_all_tables, format_table};

/// 文件類型。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "lowercase"))]
pub enum DocKind {
    #[default]
    Markdown,
    Text,
    Json,
}

impl DocKind {
    /// 依副檔名判斷類型；不認得的副檔名一律當成純文字。
    pub fn from_file_name(name: &str) -> Self {
        let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
        match ext.as_deref() {
            Some("md" | "markdown" | "mdown" | "mkd") => Self::Markdown,
            Some("json" | "jsonc" | "geojson" | "webmanifest") => Self::Json,
            _ => Self::Text,
        }
    }
}

/// 渲染選項。
#[derive(Debug, Clone, Default)]
pub struct RenderOptions {
    pub kind: DocKind,
    /// 在區塊元素加上 `data-sourcepos`，前端用它做編輯器與預覽的捲動同步。
    pub sourcepos: bool,
    /// （Markdown）把單一換行視為 `<br>`。
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
    /// 標題在原始文件中的起始行（從 1 開始）。
    pub line: usize,
}

/// 解析錯誤與其位置（行、欄皆從 1 開始）。
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct SourceError {
    pub message: String,
    pub line: usize,
    pub column: usize,
}

/// 單次渲染的完整結果。
#[derive(Debug, Clone)]
pub struct Rendered {
    pub html: String,
    pub headings: Vec<Heading>,
    pub stats: Stats,
    /// 文件無法解析時（例如 JSON 語法錯誤）的錯誤資訊；此時 `html` 為空。
    pub error: Option<SourceError>,
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

/// 渲染文件，回傳 HTML 片段、大綱與統計。
pub fn render(text: &str, opts: &RenderOptions) -> Rendered {
    match opts.kind {
        DocKind::Markdown => markdown::render(text, opts),
        DocKind::Json => json::render(text),
        DocKind::Text => render_text(text, opts),
    }
}

fn render_text(text: &str, opts: &RenderOptions) -> Rendered {
    let mut html = String::from("<pre class=\"plain-text\"");
    if opts.sourcepos && !text.is_empty() {
        // 整份文字視為單一區塊，捲動同步會在其中依行數比例內插。
        let body = text.strip_suffix('\n').unwrap_or(text);
        let lines = body.split('\n').count();
        let last_len = body.rsplit('\n').next().map_or(0, str::len);
        html.push_str(&format!(
            " data-sourcepos=\"1:1-{lines}:{}\"",
            last_len.max(1)
        ));
    }
    html.push('>');
    html.push_str(&escape_html(text));
    html.push_str("</pre>\n");
    Rendered {
        html,
        headings: Vec::new(),
        stats: count_text(text),
        error: None,
    }
}

/// 匯出時套用的獨立頁面樣式。
pub const DEFAULT_CSS: &str = include_str!("document.css");

/// 匯出獨立 HTML 文件的選項。
#[derive(Debug, Clone, Copy, Default)]
pub struct DocumentOptions<'a> {
    /// 取代內建樣式的 CSS。
    pub css: Option<&'a str>,
    /// 文件沒有標題時使用的頁面標題（例如檔名）。
    pub title: Option<&'a str>,
}

/// 產生可直接開啟的完整 HTML 文件。
pub fn render_document(text: &str, opts: &RenderOptions, doc: &DocumentOptions) -> String {
    let rendered = render(text, opts);
    let title = escape_html(rendered.title().or(doc.title).unwrap_or("Untitled"));
    let body = match &rendered.error {
        Some(e) => format!(
            "<p>無法解析（第 {} 行，第 {} 欄）：{}</p>\n<pre class=\"plain-text\">{}</pre>\n",
            e.line,
            e.column,
            escape_html(&e.message),
            escape_html(text)
        ),
        None => rendered.html,
    };
    let mut out = String::with_capacity(body.len() + DEFAULT_CSS.len() + 256);
    out.push_str("<!doctype html>\n<html lang=\"zh-Hant-TW\">\n<head>\n<meta charset=\"utf-8\">\n");
    out.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
    out.push_str("<title>");
    out.push_str(&title);
    out.push_str("</title>\n<style>\n");
    out.push_str(doc.css.unwrap_or(DEFAULT_CSS));
    out.push_str("</style>\n</head>\n<body>\n<article class=\"markdown-body\">\n");
    out.push_str(&body);
    out.push_str("</article>\n</body>\n</html>\n");
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
        let doc = render_document(
            "# 1 < 2 & \"x\"\n",
            &RenderOptions::default(),
            &DocumentOptions::default(),
        );
        assert!(doc.contains("<title>1 &lt; 2 &amp; &quot;x&quot;</title>"));
        assert!(doc.starts_with("<!doctype html>"));
    }

    #[test]
    fn plain_text_is_escaped_and_preformatted() {
        let opts = RenderOptions {
            kind: DocKind::Text,
            sourcepos: true,
            ..Default::default()
        };
        let out = render("第一行 <tag>\n第二行\n", &opts);
        assert_eq!(
            out.html,
            "<pre class=\"plain-text\" data-sourcepos=\"1:1-2:9\">第一行 &lt;tag&gt;\n第二行\n</pre>\n"
        );
        assert_eq!(out.stats.cjk_chars, 6);
    }

    #[test]
    fn non_markdown_documents_use_fallback_title() {
        let opts = RenderOptions {
            kind: DocKind::Json,
            ..Default::default()
        };
        let doc = render_document(
            "[1]",
            &opts,
            &DocumentOptions {
                title: Some("資料"),
                ..Default::default()
            },
        );
        assert!(doc.contains("<title>資料</title>"));
        assert!(doc.contains("json-tree"));
    }

    #[test]
    fn renders_math_but_not_prices() {
        let out = r("$E=mc^2$，價格 $5 與 $10");
        assert!(out
            .html
            .contains(r#"<span data-math-style="inline">E=mc^2</span>"#));
        assert!(out.html.contains("價格 $5 與 $10"));
    }

    #[test]
    fn kind_from_file_name() {
        assert_eq!(DocKind::from_file_name("a/筆記.MD"), DocKind::Markdown);
        assert_eq!(DocKind::from_file_name("data.json"), DocKind::Json);
        assert_eq!(DocKind::from_file_name("readme.txt"), DocKind::Text);
        assert_eq!(DocKind::from_file_name("LICENSE"), DocKind::Text);
    }
}
