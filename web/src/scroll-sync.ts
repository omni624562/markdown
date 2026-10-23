/** 預覽中的一個區塊，以及它對應到原始 Markdown 的行範圍。 */
export interface Block {
  /** 起始行（從 1 開始，含）。 */
  start: number;
  /** 結束行（含）。 */
  end: number;
  /** 區塊在捲動容器中的上緣位置（px）。 */
  top: number;
  /** 區塊在捲動容器中的下緣位置（px）。 */
  bottom: number;
}

/** 解析 comrak 輸出的 `data-sourcepos="3:1-5:10"`，回傳起訖行號。 */
export function parseSourcepos(attr: string | null): { start: number; end: number } | null {
  const m = attr?.match(/^(\d+):\d+-(\d+):\d+$/);
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]) };
}

/**
 * 計算原始碼第 `line` 行在預覽中應該捲到的位置。
 * `blocks` 必須依 `start` 由小到大排序（也就是文件順序）。
 * 行落在區塊內時依比例內插；落在區塊之間的空行時，在兩個區塊之間內插。
 */
export function offsetForLine(blocks: readonly Block[], line: number): number {
  let lo = 0;
  let hi = blocks.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].start <= line) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return 0;

  const b = blocks[idx];
  if (line <= b.end) {
    const ratio = (line - b.start) / (b.end - b.start + 1);
    return b.top + (b.bottom - b.top) * ratio;
  }
  const next = blocks[idx + 1];
  if (!next) return b.bottom;
  const ratio = (line - b.end) / (next.start - b.end);
  return b.bottom + (next.top - b.bottom) * ratio;
}

/** 預覽中可用於捲動同步的元素（還沒量位置）。 */
export interface BlockRef {
  start: number;
  end: number;
  el: Element;
}

/** 從預覽 DOM 收集可用於捲動同步的區塊：最外層區塊與所有清單項目。只讀屬性，不需要排版。 */
export function collectBlocks(root: HTMLElement): BlockRef[] {
  const blocks: BlockRef[] = [];
  for (const el of root.querySelectorAll(":scope > [data-sourcepos], li[data-sourcepos]")) {
    const pos = parseSourcepos(el.getAttribute("data-sourcepos"));
    if (pos) blocks.push({ ...pos, el });
  }
  return blocks;
}

/**
 * 和 `offsetForLine` 相同，但只量用得到的一兩個區塊：
 * 一次量全部會讓瀏覽器排版整個預覽，大文件每次按鍵都要好幾秒。
 */
export function offsetForLineLazy(
  blocks: readonly BlockRef[],
  line: number,
  measure: (el: Element) => { top: number; bottom: number },
): number {
  let lo = 0;
  let hi = blocks.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].start <= line) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return 0;
  const near = blocks.slice(idx, idx + 2).map((b) => ({ start: b.start, end: b.end, ...measure(b.el) }));
  return offsetForLine(near, line);
}
