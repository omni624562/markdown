/**
 * 預覽的增量更新：比對新舊兩次渲染的頂層區塊，只換掉有改動的部分。
 * 每打一個字只改到一兩個段落，整個預覽重建會讓瀏覽器重新排版整頁（大文件要好幾秒）。
 */

/** 去掉 `data-sourcepos`（行號會因為前面的段落增減行數而改變，內容其實沒變）。 */
export function stripSourcepos(html: string): string {
  return html.replace(/ data-sourcepos="[^"]*"/g, "");
}

/** 新舊兩串鍵值前面、後面各有幾個相同（不重疊）。 */
export function diffRange(oldKeys: readonly string[], newKeys: readonly string[]): { prefix: number; suffix: number } {
  const max = Math.min(oldKeys.length, newKeys.length);
  let prefix = 0;
  while (prefix < max && oldKeys[prefix] === newKeys[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldKeys[oldKeys.length - 1 - suffix] === newKeys[newKeys.length - 1 - suffix]
  ) {
    suffix++;
  }
  return { prefix, suffix };
}

const POS = /^(\d+):(\d+)-(\d+):(\d+)$/;

/**
 * 內容相同的區塊只是上下移了幾行：從舊、新兩個 sourcepos 算出行數差。
 * 欄位不同（例如縮排改了）就不能只平移，回傳 null。
 */
export function lineDelta(oldPos: string | null, newPos: string | null): number | null {
  if (oldPos === newPos) return 0;
  const a = oldPos?.match(POS);
  const b = newPos?.match(POS);
  if (!a || !b || a[2] !== b[2] || a[4] !== b[4]) return null;
  const delta = Number(b[1]) - Number(a[1]);
  return Number(b[3]) - Number(a[3]) === delta ? delta : null;
}

/** 把 sourcepos 的起訖行號平移 `delta` 行。 */
export function shiftSourcepos(pos: string, delta: number): string {
  const m = pos.match(POS);
  if (!m) return pos;
  return `${Number(m[1]) + delta}:${m[2]}-${Number(m[3]) + delta}:${m[4]}`;
}

/** 沒有結束標籤的元素。 */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/**
 * 把 Rust 產生的 HTML 依頂層節點切開（元素與元素之間的文字各一段），和瀏覽器解析出來的
 * `childNodes` 一一對應。比對哪些段落改了只需要比字串，不必每次把整份文件解析成 DOM 再序列化。
 *
 * Rust 不輸出原始 HTML，屬性值與文字裡的 `<`、`>` 都已跳脫，所以只要數標籤的層數。
 * 遇到看不懂的寫法時回傳 null，呼叫端改用一般的解析。
 */
export function splitTopLevel(html: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = html.indexOf("<");
  while (i !== -1) {
    if (depth === 0 && i > start) {
      parts.push(html.slice(start, i));
      start = i;
    }
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      if (end === -1) return null;
      i = end + 3;
      if (depth === 0) {
        parts.push(html.slice(start, i));
        start = i;
      }
      i = html.indexOf("<", i);
      continue;
    }
    const close = html.indexOf(">", i);
    if (close === -1) return null;
    const tag = html.slice(i + 1, close);
    if (tag.startsWith("/")) {
      depth--;
      if (depth < 0) return null;
    } else {
      const name = /^[a-zA-Z][\w-]*/.exec(tag)?.[0].toLowerCase();
      if (!name || name === "script" || name === "style" || name === "textarea" || name === "title") return null;
      if (!tag.endsWith("/") && !VOID.has(name)) depth++;
    }
    i = close + 1;
    if (depth === 0) {
      parts.push(html.slice(start, i));
      start = i;
    }
    i = html.indexOf("<", i);
  }
  if (depth !== 0) return null;
  if (start < html.length) parts.push(html.slice(start));
  return parts;
}

/** 頂層區塊的比對鍵：內容（不含行號）相同就視為同一段。 */
export function partKey(part: string): string {
  return part.startsWith("<") ? stripSourcepos(part) : `#text\u0000${part}`;
}

/** 區塊最外層元素的 `data-sourcepos`（文字段落是 null）。 */
export function partSourcepos(part: string): string | null {
  if (!part.startsWith("<")) return null;
  const open = part.slice(0, part.indexOf(">") + 1);
  return / data-sourcepos="([^"]*)"/.exec(open)?.[1] ?? null;
}
