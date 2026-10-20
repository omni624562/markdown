//! `md-core` 的 WebAssembly 綁定。回傳一般的 JS 物件，前端不必手動釋放記憶體。

use md_core::{Heading, RenderOptions, Stats};
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

export interface RenderResult {
  html: string;
  headings: Heading[];
  stats: Stats;
  title: string | null;
}

export interface RenderOptions {
  sourcepos?: boolean;
  hardbreaks?: boolean;
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
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Options {
    sourcepos: bool,
    hardbreaks: bool,
}

fn read_options(opts: Option<JsRenderOptions>) -> Result<RenderOptions, JsError> {
    let opts: Options = match opts {
        Some(v) if !v.is_undefined() && !v.is_null() => serde_wasm_bindgen::from_value(v.into())?,
        _ => Options::default(),
    };
    Ok(RenderOptions {
        sourcepos: opts.sourcepos,
        hardbreaks: opts.hardbreaks,
    })
}

/// 渲染 Markdown，回傳 HTML 片段、大綱與字數統計。
#[wasm_bindgen]
pub fn render(markdown: &str, options: Option<JsRenderOptions>) -> Result<JsRenderResult, JsError> {
    let rendered = md_core::render(markdown, &read_options(options)?);
    let result = RenderResult {
        html: &rendered.html,
        headings: &rendered.headings,
        stats: rendered.stats,
        title: rendered.title(),
    };
    Ok(serde_wasm_bindgen::to_value(&result)?.unchecked_into())
}

/// 產生可單獨開啟的完整 HTML 文件（含內建樣式）。
#[wasm_bindgen(js_name = renderDocument)]
pub fn render_document(
    markdown: &str,
    options: Option<JsRenderOptions>,
) -> Result<String, JsError> {
    Ok(md_core::render_document(
        markdown,
        &read_options(options)?,
        None,
    ))
}

/// 內建的 Markdown 內容樣式，與匯出文件使用的相同。
#[wasm_bindgen(js_name = defaultCss)]
pub fn default_css() -> String {
    md_core::DEFAULT_CSS.to_string()
}
