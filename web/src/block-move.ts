/**
 * 在預覽拖動段落調整順序（app/preview-drag.ts）：搬動原始 Markdown 的行。
 * - 一般區塊（段落、表格、程式碼、引言、圖片）：搬到另一個區塊前面或文件最後，前後保持一個空白行。
 * - 清單項目：搬到另一個項目前面（或某個清單的最後一項後面），縮排與項目符號換成目標清單的
 *   （「-」的項目搬進「1.」的清單會變成編號項目），不加空白行。
 * 章節（標題連同底下的內容）用 sections.ts 的 moveSection。
 */

/** 原始碼的行範圍（從 1 開始，含頭含尾）。 */
export interface LineRange {
  first: number;
  last: number;
}

/** 拆成行；記住最後有沒有換行（split 會多出一個空字串）。 */
function splitLines(text: string): { lines: string[]; trailing: boolean } {
  const lines = text.split("\n");
  const trailing = lines.length > 1 && lines[lines.length - 1] === "";
  if (trailing) lines.pop();
  return { lines, trailing };
}

const blank = (s: string | undefined) => s !== undefined && s.trim() === "";

/** 把連續的空白行縮成一行（只在拿掉區塊留下的接縫處）。 */
function closeGap(lines: string[], at: number): void {
  while (at > 0 && at < lines.length && blank(lines[at - 1]) && blank(lines[at])) lines.splice(at, 1);
  // 搬走的是文件開頭：開頭不留空白行。
  while (at === 0 && lines.length && blank(lines[0])) lines.shift();
}

/**
 * 把 `range` 的行搬到第 `before` 行前面（`before` 是 行數 + 1 時搬到最後）。
 * 位置沒變或不合理（搬進自己裡面）時回傳 null。
 */
export function moveBlock(text: string, range: LineRange, before: number): string | null {
  const { lines, trailing } = splitLines(text);
  const { first, last } = range;
  // 超過最後一行都算「搬到最後」（編輯器把結尾的換行也算一行）。
  before = Math.min(before, lines.length + 1);
  if (first < 1 || last > lines.length || first > last || before < 1) return null;
  if (before >= first && before <= last + 1) return null;
  const block = lines.slice(first - 1, last);
  while (block.length && blank(block[block.length - 1])) block.pop();
  if (!block.length) return null;
  const rest = [...lines.slice(0, first - 1), ...lines.slice(last)];
  closeGap(rest, first - 1);
  // 目標在被搬走的區塊後面：扣掉拿掉的行數（含縮掉的空白行）。
  let at = before > last ? before - 1 - (lines.length - rest.length) : before - 1;
  at = Math.max(0, Math.min(at, rest.length));
  // 搬到最後：接在最後一個非空白行後面。
  if (before === lines.length + 1) {
    while (rest.length && blank(rest[rest.length - 1])) rest.pop();
    at = rest.length;
  }
  const insert = [...block];
  if (at > 0 && !blank(rest[at - 1])) insert.unshift("");
  if (at < rest.length && !blank(rest[at])) insert.push("");
  rest.splice(at, 0, ...insert);
  while (rest.length && blank(rest[rest.length - 1])) rest.pop();
  return rest.join("\n") + (trailing ? "\n" : "");
}

const MARKER = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/;

/** 項目第一行的縮排、項目符號。 */
function marker(line: string): { indent: number; mark: string; gap: string } | null {
  const m = MARKER.exec(line);
  return m ? { indent: m[1].length, mark: m[2], gap: m[3] } : null;
}

/**
 * 把清單項目 `item` 搬到 `target` 這個項目前面（`after` 時放在它的範圍後面，給清單的最後一項用）。
 * 縮排與項目符號換成目標項目的：內容（含子項目）一起平移同樣的縮排差。
 */
export function moveListItem(text: string, item: LineRange, target: LineRange, after = false): string | null {
  const { lines, trailing } = splitLines(text);
  if (item.first < 1 || item.last > lines.length || target.first < 1 || target.last > lines.length) return null;
  // 不能搬進自己（或自己的子項目）裡。
  if (target.first >= item.first && target.first <= item.last) return null;
  const before = after ? target.last + 1 : target.first;
  if (before >= item.first && before <= item.last + 1) return null;
  const src = marker(lines[item.first - 1]);
  const dst = marker(lines[target.first - 1]);
  if (!src || !dst) return null;
  const block = lines.slice(item.first - 1, item.last);
  while (block.length > 1 && blank(block[block.length - 1])) block.pop();
  // 項目符號：換成目標清單的（編號清單用目標的編號，Markdown 顯示時會自己接著編）。
  const mark = dst.mark;
  const delta = dst.indent - src.indent;
  const shift = (line: string) => {
    if (blank(line)) return line;
    if (delta >= 0) return " ".repeat(delta) + line;
    const lead = line.length - line.trimStart().length;
    return line.slice(Math.min(lead, -delta));
  };
  const first = " ".repeat(dst.indent) + mark + src.gap + lines[item.first - 1].replace(MARKER, "");
  // 子內容原本對齊在項目文字下面；項目符號長度變了（「-」→「10.」）時跟著平移。
  const textShift = mark.length + src.gap.length - (src.mark.length + src.gap.length);
  const moved = [first, ...block.slice(1).map((l) => {
    const s = shift(l);
    if (blank(s) || textShift === 0) return s;
    return textShift > 0 ? " ".repeat(textShift) + s : s.slice(Math.min(-textShift, s.length - s.trimStart().length));
  })];
  const rest = [...lines.slice(0, item.first - 1), ...lines.slice(item.last)];
  const removed = item.last - item.first + 1;
  const at = before > item.last ? before - 1 - removed : before - 1;
  rest.splice(at, 0, ...moved);
  return rest.join("\n") + (trailing ? "\n" : "");
}
