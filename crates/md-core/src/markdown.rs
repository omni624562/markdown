//! Markdown（GFM）渲染。

use comrak::html::{format_node_default, ChildRendering, Context};
use comrak::nodes::{AstNode, NodeValue};
use comrak::{parse_document, Anchorizer, Arena, Node, Options};
use std::fmt::{self, Write};

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

    let mut html = String::new();
    if !opts.skip_html {
        html.reserve(markdown.len() * 3 / 2);
        comrak::html::format_document_with_formatter(
            root,
            &options,
            &mut html,
            &comrak::options::Plugins::default(),
            format_node,
            (),
        )
        .expect("writing to a String cannot fail");
    }

    Rendered {
        html,
        headings,
        stats,
        error: None,
    }
}

/// 解析 Markdown（和渲染相同的設定，含允許的文字格式標籤），把文件的根節點交給 `f`。
pub fn with_document<R>(markdown: &str, f: impl for<'a> FnOnce(Node<'a>) -> R) -> R {
    let options = comrak_options(&RenderOptions::default());
    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &options);
    allow_formatting_tags(&arena, root);
    f(root)
}

/// 文件中的圖片網址（照文件裡寫的，依出現順序、不重複）。
pub fn image_urls(markdown: &str) -> Vec<String> {
    with_document(markdown, |root| {
        let mut out: Vec<String> = Vec::new();
        for node in root.descendants() {
            if let NodeValue::Image(ref link) = node.data().value {
                if !out.contains(&link.url) {
                    out.push(link.url.clone());
                }
            }
        }
        out
    })
}

/// 輸出 HTML：原始 HTML 區塊一律不輸出，只有可收合區塊（`<details>`、`<summary>…</summary>`、`</details>`）例外。
fn format_node<'a>(
    context: &mut Context<()>,
    node: Node<'a>,
    entering: bool,
) -> Result<ChildRendering, fmt::Error> {
    if let NodeValue::HtmlBlock(ref block) = node.data().value {
        if let Some(parts) = details_parts(&block.literal) {
            if entering {
                context.cr()?;
                context.write_str(&parts.head)?;
                if !parts.body.trim().is_empty() {
                    let body = render_fragment(parts.body, context.options);
                    context.write_str(&body)?;
                }
                context.write_str(&parts.tail)?;
                context.cr()?;
            }
            return Ok(ChildRendering::HTML);
        }
    }
    format_node_default(context, node, entering)
}

/// 區塊裡夾帶的 Markdown（標籤和內容之間沒有空行時，整段會被當成同一個 HTML 區塊）：照一般規則渲染。
fn render_fragment(markdown: &str, options: &Options) -> String {
    let mut options = options.clone();
    // 行號是片段裡的，對不到原文件，不輸出。
    options.render.sourcepos = false;
    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &options);
    allow_formatting_tags(&arena, root);
    let mut html = String::new();
    let _ = comrak::html::format_document_with_formatter(
        root,
        &options,
        &mut html,
        &comrak::options::Plugins::default(),
        format_node,
        (),
    );
    html
}

/// 可收合區塊的 HTML 區塊拆成：開頭的標籤（整理過、安全的 HTML）、中間夾帶的 Markdown、結尾的 `</details>`。
pub(crate) struct DetailsParts<'s> {
    pub head: String,
    pub body: &'s str,
    pub tail: String,
}

/// HTML 區塊以可收合區塊的標籤開頭時拆開；否則回傳 None（照舊不輸出）。
/// 認得的標籤：`<details>`（屬性只保留 `open`）、`<summary>…</summary>`（只留純文字）、`</details>`，
/// 可以寫在同一行或分行；標籤後面、結尾 `</details>` 前面的內容照 Markdown 渲染。
pub(crate) fn details_parts(literal: &str) -> Option<DetailsParts<'_>> {
    let mut head = String::new();
    let mut rest = literal;
    loop {
        let trimmed = rest.trim_start();
        match take_tag(trimmed) {
            Some((html, after)) => {
                head.push_str(&html);
                head.push('\n');
                rest = after;
            }
            None => break,
        }
    }
    if head.is_empty() {
        return None;
    }
    // 結尾連續的 `</details>`。
    let mut tail = String::new();
    let mut body = rest;
    loop {
        let trimmed = body.trim_end();
        let lower = trimmed.to_ascii_lowercase();
        if !lower.ends_with("</details>") {
            break;
        }
        body = &trimmed[..trimmed.len() - "</details>".len()];
        tail.push_str("</details>\n");
    }
    Some(DetailsParts { head, body, tail })
}

/// 開頭一個可收合區塊的標籤：回傳整理過的 HTML 與剩下的文字。
fn take_tag(s: &str) -> Option<(String, &str)> {
    let lower = s.to_ascii_lowercase();
    let starts_tag = |name: &str| {
        lower.starts_with(name)
            && matches!(
                lower.as_bytes().get(name.len()),
                Some(b'>' | b' ' | b'\t' | b'\n' | b'\r' | b'/')
            )
    };
    if lower.starts_with("</details>") {
        return Some(("</details>".into(), &s["</details>".len()..]));
    }
    if starts_tag("<details") {
        let gt = s.find('>')?;
        let attrs = &lower["<details".len()..gt];
        if attrs.contains('<') {
            return None;
        }
        let open = attrs
            .split(|c: char| c.is_whitespace() || c == '/')
            .any(|a| a == "open" || a.starts_with("open="));
        let html = if open {
            "<details class=\"md-details\" open>"
        } else {
            "<details class=\"md-details\">"
        };
        return Some((html.into(), &s[gt + 1..]));
    }
    if starts_tag("<summary") {
        let gt = s.find('>')?;
        let close = lower[gt..].find("</summary>")? + gt;
        let text = summary_text(&s[gt + 1..close]);
        let html = format!(
            "<summary>{}</summary>",
            if text.is_empty() {
                "Details".into()
            } else {
                text
            }
        );
        return Some((html, &s[close + "</summary>".len()..]));
    }
    None
}

/// 標題只留純文字：拿掉標籤、合併空白，跳脫 `<`、`>` 與不是字元參照的 `&`。
fn summary_text(inner: &str) -> String {
    let mut text = String::with_capacity(inner.len());
    let mut in_tag = false;
    for c in inner.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => text.push(c),
            _ => {}
        }
    }
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    escape_amp(&text).replace('<', "&lt;").replace('>', "&gt;")
}

/// 把不是字元參照（`&amp;`、`&#123;`、`&#x1F;`）的 `&` 跳脫，`"` 也一併跳脫。
fn escape_amp(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for (i, c) in text.char_indices() {
        match c {
            '&' => {
                let rest = &text[i + 1..];
                let entity = rest.find(';').is_some_and(|end| {
                    let name = &rest[..end];
                    let digits = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X"));
                    !name.is_empty()
                        && end <= 32
                        && match (digits, name.strip_prefix('#')) {
                            (Some(hex), _) => {
                                !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit())
                            }
                            (None, Some(dec)) => {
                                !dec.is_empty() && dec.bytes().all(|b| b.is_ascii_digit())
                            }
                            (None, None) => name.bytes().all(|b| b.is_ascii_alphanumeric()),
                        }
                });
                out.push_str(if entity { "&" } else { "&amp;" });
            }
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
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
