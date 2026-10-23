/**
 * 大綱拖曳重排章節（E10）。章節範圍是「從這個標題，到下一個同級或更高級的標題之前」，
 * 子章節跟著一起移動。行號來自 md-core 的大綱（程式碼區塊裡的 # 不會被當成標題）。
 */

export interface HeadingLine {
  /** 標題所在的行號（從 1 開始）。 */
  line: number;
  level: number;
}

/** 第 `index` 個標題的章節範圍：[first, end) 行號，`end` 是下一個同級或更高級標題的行號。 */
export function sectionRange(headings: HeadingLine[], index: number, totalLines: number): { first: number; end: number } {
  const h = headings[index];
  const next = headings.slice(index + 1).find((o) => o.level <= h.level);
  return { first: h.line, end: next ? next.line : totalLines + 1 };
}

/**
 * 把第 `from` 個標題的章節搬到第 `before` 個標題之前（`before` 等於標題數量時搬到文件最後）。
 * 不能搬進自己的章節裡；無法搬移或位置沒變時回傳 null。
 */
export function moveSection(text: string, headings: HeadingLine[], from: number, before: number): string | null {
  if (from < 0 || from >= headings.length || before < 0 || before > headings.length) return null;
  const lines = text.split("\n");
  // 最後一行後面有換行時，split 會多出一個空字串；先拿掉，最後再補回去。
  const trailingNewline = lines.length > 1 && lines[lines.length - 1] === "";
  if (trailingNewline) lines.pop();
  const { first, end } = sectionRange(headings, from, lines.length);
  const target = before === headings.length ? lines.length + 1 : headings[before].line;
  if (target >= first && target <= end) return null;

  const block = lines.slice(first - 1, end - 1);
  const rest = [...lines.slice(0, first - 1), ...lines.slice(end - 1)];
  // 目標行號在被搬走的章節之後時，要扣掉章節的行數。
  let at = (target > first ? target - block.length : target) - 1;
  // 搬到文件最後：前面留一個空白行。
  if (before === headings.length) {
    while (rest.length && rest[rest.length - 1].trim() === "") rest.pop();
    rest.push("");
    at = rest.length;
  }
  // 章節之間要有空白行，否則後面的標題會黏在上一段文字後面。
  while (block.length && block[block.length - 1].trim() === "") block.pop();
  if (at < rest.length) block.push("");
  rest.splice(at, 0, ...block);
  while (rest.length && rest[rest.length - 1].trim() === "") rest.pop();
  return rest.join("\n") + (trailingNewline ? "\n" : "");
}

/** 和前一個或後一個同級章節交換位置（Alt+↑／↓）。回傳 [新內容, 被搬移的章節現在是第幾個標題]。 */
export function swapSection(
  text: string,
  headings: HeadingLine[],
  index: number,
  direction: -1 | 1,
): { text: string; index: number } | null {
  const h = headings[index];
  if (!h) return null;
  const totalLines = text.split("\n").length;
  if (direction < 0) {
    // 往前：找前一個同級標題（中間不能隔著更高級的標題）。
    for (let i = index - 1; i >= 0; i--) {
      if (headings[i].level < h.level) return null;
      if (headings[i].level === h.level) {
        const out = moveSection(text, headings, index, i);
        return out === null ? null : { text: out, index: i };
      }
    }
    return null;
  }
  const { end } = sectionRange(headings, index, totalLines);
  const next = headings.findIndex((o) => o.line === end);
  if (next < 0 || headings[next].level !== h.level) return null;
  // 往後：等於把下一個章節搬到這個章節前面。
  const out = moveSection(text, headings, next, index);
  if (out === null) return null;
  const nextSize = sectionRange(headings, next, totalLines).end - end;
  const childCount = headings.filter((o) => o.line >= end && o.line < end + nextSize).length;
  return { text: out, index: index + childCount };
}

// ---- 大綱收合 ----------------------------------------------------------------

/** 第 `index` 個標題的子標題結束在哪裡：下一個同級或更高級標題的索引（沒有就是標題數量）。 */
export function subtreeEnd(levels: number[], index: number): number {
  for (let j = index + 1; j < levels.length; j++) if (levels[j] <= levels[index]) return j;
  return levels.length;
}

/** 收合後哪些標題要隱藏：在某個收合的標題底下（子標題、孫標題…）的都隱藏。 */
export function hiddenByCollapse(levels: number[], collapsed: (i: number) => boolean): boolean[] {
  const hidden = levels.map(() => false);
  for (let i = 0; i < levels.length; i++) {
    if (hidden[i] || !collapsed(i)) continue;
    const end = subtreeEnd(levels, i);
    for (let j = i + 1; j < end; j++) hidden[j] = true;
  }
  return hidden;
}
