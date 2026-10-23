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
