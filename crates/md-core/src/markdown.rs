//! Markdown（GFM）渲染。

use comrak::nodes::NodeValue;
use comrak::{format_html, parse_document, Anchorizer, Arena, Node, Options};

use crate::{count_text, Heading, RenderOptions, Rendered};

pub(crate) fn comrak_options(opts: &RenderOptions) -> Options<'static> {
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
    // `$…$` 與 `$$…$$` 數學公式，輸出帶 `data-math-style` 的元素，由前端的 KaTeX 外掛渲染。
    ext.math_dollars = true;

    o.render.sourcepos = opts.sourcepos;
    o.render.hardbreaks = opts.hardbreaks;
    o.render.github_pre_lang = false;
    o.render.tasklist_classes = true;
    o
}

/// 把 Markdown 渲染成 HTML 片段，並附上大綱與統計。
pub(crate) fn render(markdown: &str, opts: &RenderOptions) -> Rendered {
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
        error: None,
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
