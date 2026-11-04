/**
 * 還沒存成檔案的文件用內容命名：分頁、標題列顯示第一個標題（沒有標題時用第一行），
 * 存檔時當成預設的檔名。好幾份新文件開著時才分得出哪個是哪個。
 */
import { plainTaskText } from "./doc-index.ts";
import type { DocKind } from "./kinds.ts";

/** 分頁上的名稱最多幾個字（太長的截斷，最後一個字換成「…」）。 */
export const TITLE_MAX = 30;
/** 存檔對話框預設的檔名（不含副檔名）最多幾個字。 */
export const FILE_NAME_MAX = 60;
/** 只在前面這些行裡找標題（很長、沒有標題的文件不必整份掃過）。 */
export const TITLE_SCAN_LINES = 1000;

/** 預設的名稱（還沒取名）：「未命名」或英文介面的「Untitled」，可能帶著副檔名。 */
const UNTITLED = /^(?:未命名|Untitled)(?:\.[A-Za-z0-9]+)?$/;

export function isUntitledName(name: string): boolean {
  return UNTITLED.test(name);
}

/** 標題、第一行裡的 Markdown 行內符號：連結只留文字，去掉粗體、程式碼、HTML 標記等。 */
function plain(s: string): string {
  return plainTaskText(
    s
      .replace(/<!--.*?-->/g, "")
      .replace(/\[\^[^\]]*\]/g, "")
      .replace(/<(https?:[^>\s]+)>/g, "$1"),
  )
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** 第一行當名稱時去掉行首的引言、清單、待辦符號。 */
function lineText(line: string): string {
  return plain(line.replace(/^\s*(?:>\s*)*/, "").replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, ""));
}

/**
 * 內容推出的標題（完整，不截斷）：Markdown 是第一個標題（任何層級，去掉 `#` 與行內符號），
 * 沒有標題時用第一行有字的；純文字是第一行有字的；JSON 沒有。都沒有時回傳空字串。
 * 只看前 {@link TITLE_SCAN_LINES} 行。
 */
export function titleOf(lines: Iterable<string>, kind: DocKind): string {
  if (kind === "json") return "";
  let first = "";
  /** 程式碼區塊的開頭符號（在區塊裡時）。 */
  let fence = "";
  let frontMatter = false;
  /** 上一行（Setext 標題：下一行是 `===` 或 `---` 時，這一行是標題）。 */
  let prev = "";
  let n = 0;
  for (const line of lines) {
    if (++n > TITLE_SCAN_LINES) break;
    if (kind !== "markdown") {
      if (line.trim()) return line.trim().replace(/\s+/g, " ");
      continue;
    }
    // 開頭的 YAML front matter 不算內容。
    if (n === 1 && /^---\s*$/.test(line)) {
      frontMatter = true;
      continue;
    }
    if (frontMatter) {
      if (/^(?:---|\.\.\.)\s*$/.test(line)) frontMatter = false;
      continue;
    }
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length && !line.trim().slice(mark.length).trim()) fence = "";
      else if (!first && line.trim()) first = line.trim();
      prev = "";
      continue;
    }
    if (mark) {
      fence = mark;
      prev = "";
      continue;
    }
    const atx = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) {
      const text = plain(atx[1] ?? "");
      if (text) return text;
      prev = "";
      continue;
    }
    if (prev && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) {
      const text = plain(prev);
      if (text) return text;
    }
    // 清單、引言、表格裡的一行不會是 Setext 標題。
    prev = line.trim() && !/^\s*(?:[-*+>|]|\d+[.)])/.test(line) ? line : "";
    if (!first) first = lineText(line);
  }
  return first;
}

/** 分頁上的名稱：太長時截斷，最後一個字換成「…」（依字元算，中文、表情符號都算一個字）。 */
export function shortTitle(title: string, max = TITLE_MAX): string {
  const chars = [...title];
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : title;
}

/** 標題當成檔名（不含副檔名）：去掉檔名不能用的字元與頭尾的點、空白，最多 {@link FILE_NAME_MAX} 個字。 */
export function titleFileName(title: string): string {
  const clean = (s: string) => s.replace(/^[\s.]+|[\s.]+$/g, "");
  const name = clean(title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").replace(/\s+/g, " "));
  return clean([...name].slice(0, FILE_NAME_MAX).join(""));
}
