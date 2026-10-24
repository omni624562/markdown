//! 匯出 Word（.docx）：把 Markdown 轉成 Word 的段落、標題、清單、表格、連結與圖片。
//!
//! 和網頁版（`web/src/docx-export.ts`）的排版相同：中文用微軟正黑體、英文用 Calibri；
//! 文件內的 #錨點 連結（例如目錄）轉成 Word 的書籤連結；數學公式保留 TeX 原文。
//! 圖片由呼叫的一方先讀好（以 Markdown 裡寫的網址為鍵），讀不到的改成文字說明。

mod zip;

use std::collections::HashMap;
use std::fmt::Write as _;

use md_core::comrak::nodes::{AlertType, ListType, NodeValue, TableAlignment};
use md_core::comrak::{Anchorizer, Node};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ImageKind {
    Png,
    Jpeg,
    Gif,
    Bmp,
}

impl ImageKind {
    fn ext(self) -> &'static str {
        match self {
            ImageKind::Png => "png",
            ImageKind::Jpeg => "jpeg",
            ImageKind::Gif => "gif",
            ImageKind::Bmp => "bmp",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Image {
    pub data: Vec<u8>,
    pub kind: ImageKind,
    /// 原始大小（像素）。
    pub width: u32,
    pub height: u32,
}

pub struct Options<'a> {
    pub title: &'a str,
    /// 讀好的圖片，以 Markdown 裡寫的網址為鍵（`md_core::image_urls` 列出的那些）。
    pub images: &'a HashMap<String, Image>,
    /// 圖片讀不到時顯示的文字，收到圖片說明（沒有說明時是網址）。
    pub missing_image: &'a dyn Fn(&str) -> String,
}

const FONT: &str = r#"<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Microsoft JhengHei"/>"#;
const MONO: &str = r#"<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas" w:eastAsia="Microsoft JhengHei"/>"#;
/// 圖片最大寬度（像素，約等於 A4 扣掉邊界）。
const MAX_IMAGE_WIDTH: u32 = 600;
/// 一個像素是幾個 EMU（Word 圖片大小的單位）。
const EMU_PER_PX: u64 = 9525;
/// 版面寬度（A4 扣掉左右邊界，單位是 1/20 點）。
const TEXT_WIDTH: u32 = 11906 - 2 * 1134;

const NS: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture""#;

/// 圖片等比縮小到最大寬度內。
pub fn fit_image(width: u32, height: u32) -> (u32, u32) {
    if width <= MAX_IMAGE_WIDTH {
        return (width, height);
    }
    let h = (f64::from(height) * f64::from(MAX_IMAGE_WIDTH) / f64::from(width)).round();
    (MAX_IMAGE_WIDTH, h as u32)
}

/// `![說明|400](…)`、`![說明|400x300](…)`：說明與指定的寬、高。
fn sized_alt(alt: &str) -> (&str, Option<u32>, Option<u32>) {
    let Some((text, size)) = alt.rsplit_once('|') else {
        return (alt, None, None);
    };
    let size = size.trim();
    let num = |s: &str| {
        let s = s.trim();
        (!s.is_empty() && s.len() <= 4 && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse::<u32>().ok())
            .flatten()
    };
    let (w, h) = match size.split_once('x') {
        Some((w, h)) => match (num(w), num(h)) {
            (Some(w), Some(h)) => (Some(w), Some(h)),
            _ => return (alt, None, None),
        },
        None => match num(size) {
            Some(w) => (Some(w), None),
            None => return (alt, None, None),
        },
    };
    (text.trim_end(), w, h)
}

/// 和 `decodeURIComponent` 相同：編碼不合法時回傳 `None`。
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            out.push(u8::from_str_radix(s.get(i + 1..i + 3)?, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn is_cjk(c: char) -> bool {
    matches!(c, '\u{2e80}'..='\u{9fff}' | '\u{ff00}'..='\u{ffef}')
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            // XML 不允許的控制字元
            '\t' | '\n' | '\r' => out.push(c),
            c if (c as u32) < 0x20 => {}
            c => out.push(c),
        }
    }
    out
}

#[derive(Clone, Copy, Default)]
struct Style {
    bold: bool,
    italics: bool,
    strike: bool,
    underline: bool,
    highlight: bool,
    sup: bool,
    sub: bool,
    code: bool,
    link: bool,
}

#[derive(Clone, Copy, Default)]
struct Context {
    /// 引言的層數（左邊縮排加框線）。
    quote: u32,
    /// 清單的層數（0 表示不在清單裡）。
    list: u32,
}

#[derive(Default)]
struct Para<'a> {
    style: Option<&'a str>,
    /// （編號定義, 層級）
    num: Option<(u32, u32)>,
    quote: u32,
    border_bottom: bool,
    shading: Option<&'a str>,
    /// （段前, 段後, 行高）；行高 0 表示不設定。
    spacing: Option<(u32, u32, u32)>,
    indent: Option<u32>,
    align: Option<&'a str>,
}

impl Para<'_> {
    fn props(&self) -> String {
        let mut p = String::new();
        if let Some(s) = self.style {
            let _ = write!(p, r#"<w:pStyle w:val="{s}"/>"#);
        }
        if let Some((id, level)) = self.num {
            let _ = write!(
                p,
                r#"<w:numPr><w:ilvl w:val="{level}"/><w:numId w:val="{id}"/></w:numPr>"#
            );
        }
        if self.quote > 0 || self.border_bottom {
            p.push_str("<w:pBdr>");
            if self.quote > 0 {
                p.push_str(r#"<w:left w:val="single" w:sz="12" w:space="8" w:color="D0D0D0"/>"#);
            }
            if self.border_bottom {
                p.push_str(r#"<w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/>"#);
            }
            p.push_str("</w:pBdr>");
        }
        if let Some(fill) = self.shading {
            let _ = write!(
                p,
                r#"<w:shd w:val="clear" w:color="auto" w:fill="{fill}"/>"#
            );
        }
        if let Some((before, after, line)) = self.spacing {
            let _ = write!(p, r#"<w:spacing w:before="{before}" w:after="{after}""#);
            if line > 0 {
                let _ = write!(p, r#" w:line="{line}" w:lineRule="auto""#);
            }
            p.push_str("/>");
        }
        // 清單的縮排由編號定義決定；引言裡的段落往右縮。
        let indent = self
            .indent
            .or((self.quote > 0 && self.num.is_none()).then_some(360 * self.quote));
        if let Some(left) = indent {
            let _ = write!(p, r#"<w:ind w:left="{left}"/>"#);
        }
        if let Some(a) = self.align {
            let _ = write!(p, r#"<w:jc w:val="{a}"/>"#);
        }
        if p.is_empty() {
            p
        } else {
            format!("<w:pPr>{p}</w:pPr>")
        }
    }
}

struct Writer<'o> {
    opts: &'o Options<'o>,
    body: String,
    /// 文件的關聯（rId、類型、目標、是否為外部連結）；rId1、rId2 是樣式與編號。
    rels: Vec<(String, &'static str, String, bool)>,
    media: Vec<(String, Vec<u8>)>,
    /// 圖片網址 → rId（同一張圖只放一次）。
    image_rels: HashMap<String, String>,
    /// 標題的錨點 → Word 書籤名稱（書籤名稱要以英文字母開頭，所以另外編號）。
    anchors: HashMap<String, String>,
    heading_ids: Vec<String>,
    headings_seen: usize,
    /// 編號清單：每個有編號的清單一個（層級, 起始號碼）。
    ordered: Vec<(u32, usize)>,
    drawing: u32,
}

impl<'o> Writer<'o> {
    fn rel(&mut self, kind: &'static str, target: String, external: bool) -> String {
        let id = format!("rId{}", self.rels.len() + 3);
        self.rels.push((id.clone(), kind, target, external));
        id
    }

    fn run(&self, text: &str, s: Style, out: &mut String) {
        if text.is_empty() {
            return;
        }
        let mut p = String::new();
        if s.link {
            p.push_str(r#"<w:rStyle w:val="Hyperlink"/>"#);
        }
        if s.code {
            p.push_str(MONO);
        }
        if s.bold {
            p.push_str("<w:b/>");
        }
        if s.italics {
            p.push_str("<w:i/>");
        }
        if s.strike {
            p.push_str("<w:strike/>");
        }
        if s.link {
            p.push_str(r#"<w:color w:val="2F6FD6"/>"#);
        }
        if s.highlight {
            p.push_str(r#"<w:highlight w:val="yellow"/>"#);
        }
        if s.underline || s.link {
            p.push_str(r#"<w:u w:val="single"/>"#);
        }
        if s.code {
            p.push_str(r#"<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>"#);
        }
        if s.sup {
            p.push_str(r#"<w:vertAlign w:val="superscript"/>"#);
        } else if s.sub {
            p.push_str(r#"<w:vertAlign w:val="subscript"/>"#);
        }
        out.push_str("<w:r>");
        if !p.is_empty() {
            let _ = write!(out, "<w:rPr>{p}</w:rPr>");
        }
        let _ = write!(
            out,
            r#"<w:t xml:space="preserve">{}</w:t></w:r>"#,
            escape(text)
        );
    }

    fn children_inline<'a>(&mut self, node: Node<'a>, s: Style, out: &mut String) {
        for c in node.children() {
            self.inline(c, s, out);
        }
    }

    fn inline<'a>(&mut self, node: Node<'a>, s: Style, out: &mut String) {
        let value = node.data().value.clone();
        match value {
            NodeValue::Text(t) => self.run(&t, s, out),
            NodeValue::SoftBreak => {
                // HTML 裡的換行：中文字之間直接相連，其他情況換成空白（和瀏覽器顯示一致）。
                let text = |n: Option<Node<'a>>| match n.map(|n| n.data().value.clone()) {
                    Some(NodeValue::Text(t)) => Some(t.to_string()),
                    _ => None,
                };
                let before = text(node.previous_sibling()).and_then(|t| t.chars().last());
                let after = text(node.next_sibling()).and_then(|t| t.chars().next());
                if !(before.is_some_and(is_cjk) && after.is_some_and(is_cjk)) {
                    self.run(" ", s, out);
                }
            }
            NodeValue::LineBreak => out.push_str("<w:r><w:br/></w:r>"),
            NodeValue::Code(c) => self.run(&c.literal, Style { code: true, ..s }, out),
            NodeValue::Emph => self.children_inline(node, Style { italics: true, ..s }, out),
            NodeValue::Strong => self.children_inline(node, Style { bold: true, ..s }, out),
            NodeValue::Strikethrough => {
                self.children_inline(node, Style { strike: true, ..s }, out)
            }
            NodeValue::Underline | NodeValue::Insert => self.children_inline(
                node,
                Style {
                    underline: true,
                    ..s
                },
                out,
            ),
            NodeValue::Highlight => self.children_inline(
                node,
                Style {
                    highlight: true,
                    ..s
                },
                out,
            ),
            NodeValue::Superscript => self.children_inline(node, Style { sup: true, ..s }, out),
            NodeValue::Subscript => self.children_inline(node, Style { sub: true, ..s }, out),
            // 數學公式：保留 TeX 原文（Word 的方程式格式不同）。
            NodeValue::Math(m) => self.run(&m.literal, Style { italics: true, ..s }, out),
            NodeValue::FootnoteReference(f) => {
                self.run(&f.ix.to_string(), Style { sup: true, ..s }, out)
            }
            NodeValue::Link(link) => {
                let url = link.url.as_str();
                let mut inner = String::new();
                self.children_inline(node, Style { link: true, ..s }, &mut inner);
                if let Some(id) = url.strip_prefix('#') {
                    let id = percent_decode(id).unwrap_or_else(|| id.to_owned());
                    match self.anchors.get(&id) {
                        Some(anchor) => {
                            let _ = write!(
                                out,
                                r#"<w:hyperlink w:anchor="{anchor}">{inner}</w:hyperlink>"#
                            );
                        }
                        None => self.children_inline(node, s, out),
                    }
                } else if url.len() > 7
                    && (url[..7].eq_ignore_ascii_case("http://")
                        || url
                            .get(..8)
                            .is_some_and(|p| p.eq_ignore_ascii_case("https://"))
                        || url[..7].eq_ignore_ascii_case("mailto:"))
                {
                    let id = self.rel("hyperlink", escape(url), true);
                    let _ = write!(out, r#"<w:hyperlink r:id="{id}">{inner}</w:hyperlink>"#);
                } else {
                    self.children_inline(node, s, out);
                }
            }
            NodeValue::Image(link) => self.image(node, &link.url, s, out),
            NodeValue::HtmlInline(_) | NodeValue::Raw(_) => {}
            _ => self.children_inline(node, s, out),
        }
    }

    fn image<'a>(&mut self, node: Node<'a>, url: &str, s: Style, out: &mut String) {
        let alt_text = node.collect_text();
        let (alt, w, h) = sized_alt(&alt_text);
        let Some(img) = self.opts.images.get(url) else {
            let label = (self.opts.missing_image)(if alt.is_empty() { url } else { alt });
            self.run(&label, Style { italics: true, ..s }, out);
            return;
        };
        let rid = match self.image_rels.get(url) {
            Some(id) => id.clone(),
            None => {
                let name = format!("image{}.{}", self.media.len() + 1, img.kind.ext());
                self.media.push((name.clone(), img.data.clone()));
                let id = self.rel("image", format!("media/{name}"), false);
                self.image_rels.insert(url.to_owned(), id.clone());
                id
            }
        };
        let (iw, ih) = (img.width.max(1), img.height.max(1));
        let width = w.unwrap_or(iw);
        let height =
            h.unwrap_or_else(|| (f64::from(ih) * f64::from(width) / f64::from(iw)).round() as u32);
        let (width, height) = fit_image(width, height);
        let (cx, cy) = (
            u64::from(width) * EMU_PER_PX,
            u64::from(height) * EMU_PER_PX,
        );
        self.drawing += 1;
        let n = self.drawing;
        let _ = write!(
            out,
            r#"<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="{n}" name="Picture {n}" descr="{descr}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{n}" name="Picture {n}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"#,
            descr = escape(alt)
        );
    }

    fn para(&mut self, props: &Para, runs: &str) {
        let _ = write!(self.body, "<w:p>{}{runs}</w:p>", props.props());
    }

    fn quote_para(ctx: Context) -> Para<'static> {
        Para {
            quote: ctx.quote,
            ..Para::default()
        }
    }

    fn blocks<'a>(&mut self, node: Node<'a>, ctx: Context) {
        let children: Vec<Node<'a>> = node.children().collect();
        let mut i = 0;
        while i < children.len() {
            // 連續的註腳定義當成一個編號清單（和網頁版一樣放在文件最後）。
            if matches!(children[i].data().value, NodeValue::FootnoteDefinition(_)) {
                let start = i;
                while i < children.len()
                    && matches!(children[i].data().value, NodeValue::FootnoteDefinition(_))
                {
                    i += 1;
                }
                self.list_items(&children[start..i], ctx, Some(1));
                continue;
            }
            self.block(children[i], ctx);
            i += 1;
        }
    }

    fn block<'a>(&mut self, node: Node<'a>, ctx: Context) {
        let value = node.data().value.clone();
        match value {
            NodeValue::Heading(h) => {
                let mut runs = String::new();
                self.children_inline(node, Style::default(), &mut runs);
                let level = h.level.clamp(1, 6);
                let anchor = self
                    .heading_ids
                    .get(self.headings_seen)
                    .and_then(|id| self.anchors.get(id))
                    .cloned();
                self.headings_seen += 1;
                let runs = match anchor {
                    Some(name) => {
                        let id = self.headings_seen;
                        format!(
                            r#"<w:bookmarkStart w:id="{id}" w:name="{name}"/>{runs}<w:bookmarkEnd w:id="{id}"/>"#
                        )
                    }
                    None => runs,
                };
                let style = format!("Heading{level}");
                let props = Para {
                    style: Some(&style),
                    ..Para::default()
                };
                let _ = write!(self.body, "<w:p>{}{runs}</w:p>", props.props());
            }
            NodeValue::Paragraph => {
                let mut runs = String::new();
                self.children_inline(node, Style::default(), &mut runs);
                self.para(&Self::quote_para(ctx), &runs);
            }
            NodeValue::List(list) => {
                let items: Vec<Node<'a>> = node.children().collect();
                let start = (list.list_type == ListType::Ordered).then_some(list.start);
                self.list_items(&items, ctx, start);
            }
            NodeValue::BlockQuote | NodeValue::MultilineBlockQuote(_) => self.blocks(
                node,
                Context {
                    quote: ctx.quote + 1,
                    ..ctx
                },
            ),
            // 提示區塊（> [!NOTE]）：標題和內容當成引言縮排。
            NodeValue::Alert(alert) => {
                let inner = Context {
                    quote: ctx.quote + 1,
                    ..ctx
                };
                let title = alert
                    .title
                    .clone()
                    .unwrap_or_else(|| alert_title(alert.alert_type).to_owned());
                let mut runs = String::new();
                self.run(&title, Style::default(), &mut runs);
                self.para(&Self::quote_para(inner), &runs);
                self.blocks(node, inner);
            }
            NodeValue::CodeBlock(code) => {
                let text = code.literal.strip_suffix('\n').unwrap_or(&code.literal);
                let lines: Vec<&str> = text.split('\n').collect();
                for (i, line) in lines.iter().enumerate() {
                    let line = line.strip_suffix('\r').unwrap_or(line);
                    let mut runs = String::new();
                    let _ = write!(
                        runs,
                        r#"<w:r><w:rPr>{MONO}<w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr><w:t xml:space="preserve">{}</w:t></w:r>"#,
                        escape(if line.is_empty() { " " } else { line })
                    );
                    let props = Para {
                        shading: Some("F6F8FA"),
                        spacing: Some((0, if i + 1 == lines.len() { 160 } else { 0 }, 260)),
                        quote: ctx.quote,
                        ..Para::default()
                    };
                    self.para(&props, &runs);
                }
            }
            NodeValue::Table(table) => self.table(node, &table.alignments, ctx),
            NodeValue::ThematicBreak => {
                let props = Para {
                    border_bottom: true,
                    ..Para::default()
                };
                self.para(&props, "");
            }
            NodeValue::FrontMatter(_) | NodeValue::HtmlBlock(_) => {}
            NodeValue::FootnoteDefinition(_) => self.list_items(&[node], ctx, Some(1)),
            _ => self.blocks(node, ctx),
        }
    }

    /// 清單：`start` 是編號清單的起始號碼（項目符號清單是 `None`）。
    fn list_items<'a>(&mut self, items: &[Node<'a>], ctx: Context, start: Option<usize>) {
        let level = ctx.list.min(8);
        let num = match start {
            Some(start) => {
                self.ordered.push((level, start));
                self.ordered.len() as u32 + 1
            }
            None => 1,
        };
        for &item in items {
            let task = match &item.data().value {
                NodeValue::TaskItem(t) => Some(t.symbol.is_some()),
                _ => None,
            };
            let task_indent = 360 * (level + 1) + 360 * ctx.quote;
            let mut first = true;
            let flush = |w: &mut Self, runs: &str, first: &mut bool| {
                let mut props = Self::quote_para(ctx);
                if *first && task.is_none() {
                    props.num = Some((num, level));
                } else {
                    props.indent = Some(360 * (level + 1));
                }
                if task.is_some() {
                    props.indent = Some(task_indent);
                }
                let mut text = String::new();
                if *first {
                    if let Some(done) = task {
                        w.run(if done { "☑ " } else { "☐ " }, Style::default(), &mut text);
                    }
                }
                text.push_str(runs);
                w.para(&props, &text);
                *first = false;
            };
            for child in item.children() {
                match child.data().value.clone() {
                    NodeValue::Paragraph => {
                        let mut runs = String::new();
                        self.children_inline(child, Style::default(), &mut runs);
                        flush(self, &runs, &mut first);
                    }
                    NodeValue::List(list) => {
                        if first {
                            flush(self, "", &mut first);
                        }
                        let nested: Vec<Node<'a>> = child.children().collect();
                        let start = (list.list_type == ListType::Ordered).then_some(list.start);
                        self.list_items(
                            &nested,
                            Context {
                                list: ctx.list + 1,
                                ..ctx
                            },
                            start,
                        );
                    }
                    _ => {
                        if first {
                            flush(self, "", &mut first);
                        }
                        self.block(child, ctx);
                    }
                }
            }
            if first {
                flush(self, "", &mut first);
            }
        }
    }

    fn table<'a>(&mut self, node: Node<'a>, align: &[TableAlignment], ctx: Context) {
        let columns = align.len().max(1) as u32;
        let mut xml = String::from(
            r#"<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr><w:tblGrid>"#,
        );
        for _ in 0..columns {
            let _ = write!(xml, r#"<w:gridCol w:w="{}"/>"#, TEXT_WIDTH / columns);
        }
        xml.push_str("</w:tblGrid>");
        let mut rows = 0;
        for row in node.children() {
            let NodeValue::TableRow(header) = row.data().value else {
                continue;
            };
            rows += 1;
            xml.push_str("<w:tr>");
            if header {
                xml.push_str("<w:trPr><w:tblHeader/></w:trPr>");
            }
            for (i, cell) in row.children().enumerate() {
                let mut runs = String::new();
                let style = Style {
                    bold: header,
                    ..Style::default()
                };
                self.children_inline(cell, style, &mut runs);
                let jc = match align.get(i) {
                    Some(TableAlignment::Center) => "center",
                    Some(TableAlignment::Right) => "right",
                    _ => "left",
                };
                let props = Para {
                    spacing: Some((0, 0, 0)),
                    align: Some(jc),
                    ..Para::default()
                };
                let shading = if header {
                    r#"<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>"#
                } else {
                    ""
                };
                let _ = write!(
                    xml,
                    r#"<w:tc><w:tcPr><w:tcW w:w="{}" w:type="dxa"/>{shading}<w:tcMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar></w:tcPr><w:p>{}{runs}</w:p></w:tc>"#,
                    TEXT_WIDTH / columns,
                    props.props()
                );
            }
            xml.push_str("</w:tr>");
        }
        xml.push_str("</w:tbl>");
        if rows == 0 {
            return;
        }
        self.body.push_str(&xml);
        self.para(&Self::quote_para(ctx), "");
    }
}

fn alert_title(kind: AlertType) -> &'static str {
    kind.default_title()
}

fn styles() -> String {
    let heading = |level: u32, size: u32| {
        format!(
            r#"<w:style w:type="paragraph" w:styleId="Heading{level}"><w:name w:val="heading {level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="{}"/></w:pPr><w:rPr>{FONT}<w:b/><w:bCs/><w:color w:val="1F1F1F"/><w:sz w:val="{size}"/><w:szCs w:val="{size}"/></w:rPr></w:style>"#,
            level - 1
        )
    };
    let headings: String = [36, 30, 26, 24, 22, 22]
        .iter()
        .enumerate()
        .map(|(i, &size)| heading(i as u32 + 1, size))
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles {NS}><w:docDefaults><w:rPrDefault><w:rPr>{FONT}<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-TW"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>{headings}<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="2F6FD6"/><w:u w:val="single"/></w:rPr></w:style></w:styles>"#
    )
}

fn numbering(ordered: &[(u32, usize)]) -> String {
    let bullets = ["•", "◦", "▪"];
    let levels = |is_ordered: bool| -> String {
        (0..9u32)
            .map(|i| {
                let (fmt, text) = if is_ordered {
                    ("decimal", format!("%{}.", i + 1))
                } else {
                    ("bullet", bullets[i as usize % 3].to_owned())
                };
                format!(
                    r#"<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="{fmt}"/><w:lvlText w:val="{text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{}" w:hanging="300"/></w:pPr></w:lvl>"#,
                    420 * (i + 1)
                )
            })
            .collect()
    };
    let mut xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering {NS}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>{}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>{}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>"#,
        levels(false),
        levels(true)
    );
    // 每個編號清單各自從頭編號。
    for (i, &(level, start)) in ordered.iter().enumerate() {
        let _ = write!(
            xml,
            r#"<w:num w:numId="{}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="{level}"><w:startOverride w:val="{start}"/></w:lvlOverride></w:num>"#,
            i + 2
        );
    }
    xml.push_str("</w:numbering>");
    xml
}

/// 把 Markdown 轉成 .docx 檔的內容。
pub fn markdown_to_docx(markdown: &str, opts: &Options) -> Vec<u8> {
    md_core::with_document(markdown, |root| {
        let mut anchorizer = Anchorizer::new();
        let heading_ids: Vec<String> = root
            .descendants()
            .filter(|n| matches!(n.data().value, NodeValue::Heading(_)))
            .map(|n| anchorizer.anchorize(&n.collect_text()))
            .collect();
        let anchors = heading_ids
            .iter()
            .enumerate()
            .map(|(i, id)| (id.clone(), format!("_h{}", i + 1)))
            .collect();
        let mut w = Writer {
            opts,
            body: String::with_capacity(markdown.len() * 4),
            rels: Vec::new(),
            media: Vec::new(),
            image_rels: HashMap::new(),
            anchors,
            heading_ids,
            headings_seen: 0,
            ordered: Vec::new(),
            drawing: 0,
        };
        w.blocks(root, Context::default());
        package(w)
    })
}

fn package(w: Writer) -> Vec<u8> {
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {NS}><w:body>{}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>"#,
        w.body
    );
    let mut rels = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>"#,
    );
    for (id, kind, target, external) in &w.rels {
        let mode = if *external {
            r#" TargetMode="External""#
        } else {
            ""
        };
        let _ = write!(
            rels,
            r#"<Relationship Id="{id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}" Target="{target}"{mode}/>"#
        );
    }
    rels.push_str("</Relationships>");
    let types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="bmp" ContentType="image/bmp"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>"#;
    let root_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>"#;
    let core = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>{}</dc:title><dc:creator>oMarker</dc:creator></cp:coreProperties>"#,
        escape(w.opts.title)
    );
    let mut zip = zip::ZipWriter::default();
    zip.add("[Content_Types].xml", types.as_bytes());
    zip.add("_rels/.rels", root_rels.as_bytes());
    zip.add("docProps/core.xml", core.as_bytes());
    zip.add("word/document.xml", document.as_bytes());
    zip.add("word/styles.xml", styles().as_bytes());
    zip.add("word/numbering.xml", numbering(&w.ordered).as_bytes());
    zip.add("word/_rels/document.xml.rels", rels.as_bytes());
    for (name, data) in &w.media {
        zip.add(&format!("word/media/{name}"), data);
    }
    zip.finish()
}

#[cfg(test)]
mod tests;
