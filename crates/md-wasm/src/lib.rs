//! `md-core` 的 WebAssembly 綁定。回傳一般的 JS 物件，前端不必手動釋放記憶體。

use md_core::{DocKind, DocumentOptions, Heading, RenderOptions, SourceError, Stats};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(typescript_custom_section)]
const TS_TYPES: &str = r#"
export interface Heading {
  level: number;
  text: string;
  id: string;
  line: number;
}

export interface Stats {
  words: number;
  latinWords: number;
  cjkChars: number;
  chars: number;
  readingMinutes: number;
}

export type DocKind = "markdown" | "text" | "json";

export interface SourceError {
  message: string;
  line: number;
  column: number;
}

export interface RenderResult {
  html: string;
  headings: Heading[];
  stats: Stats;
  title: string | null;
  error: SourceError | null;
}

export interface RenderOptions {
  kind?: DocKind;
  sourcepos?: boolean;
  hardbreaks?: boolean;
  /** renderDocument：文件沒有標題時使用的頁面標題。 */
  title?: string;
}
"#;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "RenderOptions")]
    pub type JsRenderOptions;

    #[wasm_bindgen(typescript_type = "RenderResult")]
    pub type JsRenderResult;
}

#[derive(Serialize)]
struct RenderResult<'a> {
    html: &'a str,
    headings: &'a [Heading],
    stats: Stats,
    title: Option<&'a str>,
    error: Option<&'a SourceError>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Options {
    kind: DocKind,
    sourcepos: bool,
    hardbreaks: bool,
    title: Option<String>,
}

fn read_options(opts: Option<JsRenderOptions>) -> Result<Options, JsError> {
    Ok(match opts {
        Some(v) if !v.is_undefined() && !v.is_null() => serde_wasm_bindgen::from_value(v.into())?,
        _ => Options::default(),
    })
}

impl Options {
    fn render(&self) -> RenderOptions {
        RenderOptions {
            kind: self.kind,
            sourcepos: self.sourcepos,
            hardbreaks: self.hardbreaks,
        }
    }
}

/// 渲染文件（預設為 Markdown），回傳 HTML 片段、大綱與字數統計。
#[wasm_bindgen]
pub fn render(markdown: &str, options: Option<JsRenderOptions>) -> Result<JsRenderResult, JsError> {
    let rendered = md_core::render(markdown, &read_options(options)?.render());
    let result = RenderResult {
        html: &rendered.html,
        headings: &rendered.headings,
        stats: rendered.stats,
        title: rendered.title(),
        error: rendered.error.as_ref(),
    };
    Ok(serde_wasm_bindgen::to_value(&result)?.unchecked_into())
}

/// 產生可單獨開啟的完整 HTML 文件（含內建樣式）。
#[wasm_bindgen(js_name = renderDocument)]
pub fn render_document(
    markdown: &str,
    options: Option<JsRenderOptions>,
) -> Result<String, JsError> {
    let opts = read_options(options)?;
    let doc = DocumentOptions {
        title: opts.title.as_deref(),
        ..Default::default()
    };
    Ok(md_core::render_document(markdown, &opts.render(), &doc))
}

/// 內建的 Markdown 內容樣式，與匯出文件使用的相同。
#[wasm_bindgen(js_name = defaultCss)]
pub fn default_css() -> String {
    md_core::DEFAULT_CSS.to_string()
}

/// 依檔名判斷文件類型。
#[wasm_bindgen(js_name = kindFromFileName, unchecked_return_type = "DocKind")]
pub fn kind_from_file_name(name: &str) -> String {
    match DocKind::from_file_name(name) {
        DocKind::Markdown => "markdown",
        DocKind::Text => "text",
        DocKind::Json => "json",
    }
    .to_string()
}

/// 把 JSON 排版成縮排兩格的格式；語法錯誤時丟出含行、欄位置的錯誤。
#[wasm_bindgen(js_name = formatJson)]
pub fn format_json(text: &str) -> Result<String, JsError> {
    md_core::format_json(text).map_err(|e| {
        JsError::new(&format!(
            "第 {} 行，第 {} 欄：{}",
            e.line, e.column, e.message
        ))
    })
}

/// 依東亞字寬排版一個表格區塊（中日韓文字算兩格）；不是有效的表格時回傳 `undefined`。
#[wasm_bindgen(js_name = formatTable)]
pub fn format_table(block: &str) -> Option<String> {
    md_core::format_table(block)
}

/// 在中文與英文、數字之間補空格的位置（UTF-16 位移，與 JavaScript 字串一致），由小到大。
#[wasm_bindgen(js_name = spacingPositions)]
pub fn spacing_positions(text: &str, kind: &str) -> Vec<u32> {
    let kind = match kind {
        "markdown" => md_core::DocKind::Markdown,
        "json" => md_core::DocKind::Json,
        _ => md_core::DocKind::Text,
    };
    let bytes = md_core::spacing_positions(text, kind);
    // 位元組位移換算成 UTF-16 位移。
    let mut out = Vec::with_capacity(bytes.len());
    let mut utf16 = 0u32;
    let mut next = bytes.iter().peekable();
    for (i, c) in text.char_indices() {
        while next.peek().is_some_and(|&&b| b == i) {
            out.push(utf16);
            next.next();
        }
        utf16 += c.len_utf16() as u32;
    }
    out
}

/// 排版文件中所有的表格，略過程式碼區塊。
#[wasm_bindgen(js_name = formatAllTables)]
pub fn format_all_tables(text: &str) -> String {
    md_core::format_all_tables(text)
}
