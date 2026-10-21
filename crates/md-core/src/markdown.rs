//! Markdown（GFM）渲染。

use comrak::nodes::{AstNode, NodeValue};
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
    // `[[文件]]`、`[[文件#標題|顯示文字]]` 連到資料夾中的其他文件（Obsidian 的寫法），由前端找出對應的檔案。
    ext.wikilinks_title_after_pipe = true;

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
    allow_formatting_tags(&arena, root);

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

/// 允許的行內 HTML 標籤（不能帶屬性）與對應的節點。
fn formatting_tag(name: &str) -> Option<NodeValue> {
    Some(match name {
        "u" => NodeValue::Underline,
        "mark" => NodeValue::Highlight,
        "sup" => NodeValue::Superscript,
        "sub" => NodeValue::Subscript,
        "ins" => NodeValue::Insert,
        _ => return None,
    })
}

/// `<u>`、`</mark>` 這種不帶屬性的標籤：回傳（是否為結尾標籤, 名稱）。
fn parse_tag(literal: &str) -> Option<(bool, String)> {
    let inner = literal.trim().strip_prefix('<')?.strip_suffix('>')?;
    let (closing, name) = match inner.strip_prefix('/') {
        Some(n) => (true, n),
        None => (false, inner),
    };
    let name = name.trim_end().to_ascii_lowercase();
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphabetic()) {
        return None;
    }
    Some((closing, name))
}

/// 原始 HTML 一律不輸出，但常用的文字格式例外：成對的 `<u>`（底線）、`<mark>`（螢光標記）、
/// `<sup>`（上標）、`<sub>`（下標）、`<ins>`，以及 `<br>`。
/// 做法是把它們換成 comrak 本身的格式節點，所以仍然不輸出任何原始 HTML，危險連結的過濾也照舊。
/// 只配對同一層裡成對的標籤：沒有結尾的開頭標籤不會讓後面整份文件都變成底線。
fn allow_formatting_tags<'a>(arena: &'a Arena<'a>, root: Node<'a>) {
    let parents: Vec<Node<'a>> = root
        .descendants()
        .filter(|n| {
            n.children()
                .any(|c| matches!(c.data().value, NodeValue::HtmlInline(_)))
        })
        .collect();
    for parent in parents {
        let mut open: Vec<(String, Node<'a>)> = Vec::new();
        let mut pairs: Vec<(Node<'a>, Node<'a>, NodeValue)> = Vec::new();
        for child in parent.children() {
            let tag = match child.data().value {
                NodeValue::HtmlInline(ref literal) => parse_tag(literal),
                _ => None,
            };
            let Some((closing, name)) = tag else { continue };
            if !closing && matches!(name.as_str(), "br") {
                child.data_mut().value = NodeValue::LineBreak;
            } else if !closing {
                if formatting_tag(&name).is_some() {
                    open.push((name, child));
                }
            } else if open.last().is_some_and(|(n, _)| *n == name) {
                let (_, start) = open.pop().unwrap();
                pairs.push((start, child, formatting_tag(&name).unwrap()));
            }
        }
        // 內層的配對先處理；外層包起來時，內層已經是一個節點。
        for (start, end, value) in pairs {
            let mut ast = comrak::nodes::Ast::new(value, start.data().sourcepos.start);
            ast.sourcepos.end = end.data().sourcepos.end;
            let wrapper: Node<'a> = arena.alloc(AstNode::from(ast));
            start.insert_before(wrapper);
            while let Some(next) = start.next_sibling() {
                if next.same_node(end) {
                    break;
                }
                wrapper.append(next);
            }
            start.detach();
            end.detach();
        }
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
