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

export interface Task {
  /** 第幾行（從 1 開始）。 */
  line: number;
  done: boolean;
  /** 勾選框後面的文字（原始 Markdown）。 */
  text: string;
  /** `@名字` 標記的負責人。 */
  owners: string[];
  /** 截止日（YYYY-MM-DD），沒寫就是 null。 */
  due: string | null;
}

export interface LinkRef {
  line: number;
  /** `[[週報]]` 的「週報」，或 `[說明](筆記/會議.md#標題)` 的「筆記/會議.md」（已解碼）。 */
  target: string;
  kind: "wiki" | "markdown";
}

/** 文件中的待辦、標籤與連結（程式碼區塊、行內程式碼與 HTML 註解裡的不算）。 */
export interface DocInfo {
  tasks: Task[];
  tags: string[];
  links: LinkRef[];
}

export interface FileRef {
  path: string;
  /** 相對於資料夾、以 `/` 分隔的路徑。 */
  rel: string;
}

export type TermKind = "cn" | "typo" | "punct";

export interface Term {
  /** 要找的詞（標點是「不再提示」記下的名稱，例如「半形標點 ,」）。 */
  word: string;
  /** 建議的寫法（第一個是預設）。半形括號是空的：建議是把括號換成全形、內容照舊。 */
  to: string[];
  kind: TermKind;
  /** 依文意判斷：在台灣也有其他意思，整份修正時不自動換。 */
  context: boolean;
  /** 說明（依文意的詞會寫什麼情況才要改）。 */
  note: string | null;
}

export interface RenderOptions {
  kind?: DocKind;
  sourcepos?: boolean;
  hardbreaks?: boolean;
  /** 只要大綱、統計與錯誤，不產生 HTML（預覽沒有顯示時用，比較快）。 */
  skipHtml?: boolean;
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
#[serde(default, rename_all = "camelCase")]
struct Options {
    kind: DocKind,
    sourcepos: bool,
    hardbreaks: bool,
    skip_html: bool,
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
            skip_html: self.skip_html,
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

/// 文件中的待辦、標籤與連結（和桌面版後端的資料夾索引同一份程式）。`year` 是今年，截止日沒寫年份時用。
#[wasm_bindgen(js_name = parseDoc, unchecked_return_type = "DocInfo")]
pub fn parse_doc(text: &str, year: i32) -> Result<JsValue, JsError> {
    // 沒有截止日要是 null（預設會變成 undefined）。
    let json = serde_wasm_bindgen::Serializer::json_compatible();
    Ok(md_text::parse_doc(text, year).serialize(&json)?)
}

/// 文件中的圖片網址（照文件裡寫的，依出現順序、不重複）：匯出 Word 前先讀好這些圖片。
#[wasm_bindgen(js_name = imageUrls)]
pub fn image_urls(markdown: &str) -> Vec<String> {
    md_core::image_urls(markdown)
}

/// 檔案或資料夾從 `from` 改名成 `to` 之後，更新 `docPath` 這份文件中指向它們的連結（和桌面版後端同一份程式）。
/// `files` 是改名前資料夾中的檔案；沒有要改的時候回傳 `undefined`。
#[wasm_bindgen(js_name = renameLinks)]
pub fn rename_links(
    text: &str,
    doc_path: &str,
    #[wasm_bindgen(unchecked_param_type = "FileRef[]")] files: JsValue,
    from: &str,
    to: &str,
) -> Result<Option<String>, JsError> {
    let files: Vec<md_text::FileRef> = serde_wasm_bindgen::from_value(files)?;
    Ok(md_text::rename_links(text, doc_path, &files, |p| {
        md_text::rebase(p, from, to)
    }))
}

/// 兩國用語、錯字與中文標點檢查。`skip` 是不檢查的範圍（起點、終點交錯排列），`ignore` 是不再提示的詞。
/// 回傳每個結果的起點、終點與詞在 `termList()` 裡的位置（三個一組）；位置都是 UTF-16 位移（和 JavaScript 字串一致）。
/// 不回傳物件：大文件可能有上萬個結果，逐一轉成 JavaScript 物件比檢查本身慢好幾倍。
#[wasm_bindgen]
pub fn proofread(text: &str, skip: &[u32], ignore: Vec<String>) -> Vec<u32> {
    let points: Vec<usize> = skip.iter().map(|&p| p as usize).collect();
    let bytes = convert(text, &points, true);
    let skip: Vec<(usize, usize)> = (0..bytes.len() / 2)
        .map(|i| (bytes[2 * i], bytes[2 * i + 1]))
        .collect();
    let found = md_text::proofread(text, &skip, &ignore.into_iter().collect());
    let ends: Vec<usize> = found.iter().flat_map(|m| [m.from, m.to]).collect();
    let ends = convert(text, &ends, false);
    found
        .iter()
        .enumerate()
        .flat_map(|(i, m)| [ends[2 * i] as u32, ends[2 * i + 1] as u32, m.id as u32])
        .collect()
}

/// 詞表：用語、錯字與半形標點（`proofread` 回傳的位置對應這裡）。
#[wasm_bindgen(js_name = termList, unchecked_return_type = "Term[]")]
pub fn term_list() -> Result<JsValue, JsError> {
    Ok(md_text::terms().serialize(&serde_wasm_bindgen::Serializer::json_compatible())?)
}

/// 位置換算：`from_utf16` 為真時 UTF-16 位移換成位元組位移，否則反過來。
/// 落在字元中間的位置算到下一個字元開頭，超過結尾的算結尾。
fn convert(text: &str, points: &[usize], from_utf16: bool) -> Vec<usize> {
    let mut order: Vec<usize> = (0..points.len()).collect();
    order.sort_by_key(|&k| points[k]);
    let mut order = order.into_iter().peekable();
    let mut out = vec![0; points.len()];
    let mut utf16 = 0;
    for (byte, c) in text.char_indices() {
        let (here, there) = if from_utf16 {
            (utf16, byte)
        } else {
            (byte, utf16)
        };
        while let Some(&k) = order.peek() {
            if points[k] > here {
                break;
            }
            out[k] = there;
            order.next();
        }
        utf16 += c.len_utf16();
    }
    let end = if from_utf16 { text.len() } else { utf16 };
    for k in order {
        out[k] = end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::convert;

    #[test]
    fn converts_positions() {
        let text = "a中😀b";
        // 位元組 0 1 4 8；UTF-16 0 1 2 4
        assert_eq!(
            convert(text, &[0, 1, 4, 8, 9, 30], false),
            [0, 1, 2, 4, 5, 5]
        );
        assert_eq!(convert(text, &[4, 0, 2, 3, 5], true), [8, 0, 4, 8, 9]);
    }
}
