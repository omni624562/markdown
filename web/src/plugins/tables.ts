import type { PreviewPlugin, Queryable } from "../preview.ts";

/** 不能從中間斷開的數字：日期（2026-11-15、2026/11/15）、時間（10:30）、版本號（1.2.3）、電話（02-1234-5678）。 */
const NUMBER_TOKEN = /\d+(?:[-/.:]\d+)+%?/g;
/** 這麼短（字數）的儲存格整格不換行，例如「進行中」「王小明」「45%」「2026-11-15」。 */
export const SHORT_CELL = 12;

/** 把文字切成一般的文字與不能斷開的數字（`{ keep }`）。 */
export function splitNumbers(text: string): (string | { keep: string })[] {
  const out: (string | { keep: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(NUMBER_TOKEN)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ keep: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * 欄寬不夠時，瀏覽器會把儲存格擠到最窄：中文一個字一行、日期從「-」斷成「2026-11-」和「15」。
 * 短的儲存格整格不換行（.cell-nowrap），長的照常換行，只把裡面的日期、數字包成 .nobr；
 * 表格因此變寬時就左右捲動（document.css）。
 */
function keepTogether(content: ParentNode): void {
  for (const cell of content.querySelectorAll<HTMLTableCellElement>("td, th")) {
    const text = (cell.textContent ?? "").trim();
    if ([...text].length <= SHORT_CELL) {
      cell.classList.add("cell-nowrap");
      continue;
    }
    const walker = cell.ownerDocument.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      const parts = splitNumbers(node.data);
      if (!parts.some((p) => typeof p !== "string")) continue;
      node.replaceWith(
        ...parts.map((p) => (typeof p === "string" ? p : Object.assign(document.createElement("span"), { className: "nobr", textContent: p.keep }))),
      );
    }
  }
}

/**
 * 預覽中的表格：寬度放得下的表格標上 .fits，往下捲動時標題列固定在上方。
 * 太寬的表格要左右捲動，瀏覽器沒辦法同時固定標題列，維持原樣。預覽寬度改變時重新判斷。
 * 儲存格裡的短內容、日期與數字不從中間斷開（見 keepTogether）。
 */
export function tablesPlugin(): PreviewPlugin {
  const mark = (scope: Queryable) => {
    const tables = [...scope.querySelectorAll<HTMLTableElement>("table")];
    if (!tables.length) return;
    // 先全部拿掉 .fits（恢復可捲動）、再一起量、最後一起標記：量寬度會讓瀏覽器排版，
    // 寫一個量一個的話，有幾個表格就要重新排版幾次。
    for (const table of tables) table.classList.remove("fits");
    const fits = tables.map((table) => !!table.tHead && table.scrollWidth <= table.clientWidth + 1);
    tables.forEach((table, i) => table.classList.toggle("fits", fits[i]));
  };
  // 只在預覽「寬度」改變時重新量；打字讓預覽變高不影響表格寬度。
  const widths = new WeakMap<Element, number>();
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const width = Math.round(entry.contentRect.width);
      if (widths.get(entry.target) === width) continue;
      widths.set(entry.target, width);
      mark(entry.target as HTMLElement);
    }
  });
  let observed: HTMLElement | null = null;
  return {
    name: "tables",
    // 放進畫面之前處理：表格第一次出現就是最後的寬度，不會先擠成一字一行再撐開。
    prepare(content) {
      if (content.querySelector("table")) keepTogether(content);
    },
    apply(root, scope) {
      if (observed !== root) {
        observer.observe(root);
        observed = root;
      }
      // 只量這次新加入的表格；預覽寬度改變時 ResizeObserver 會重新量全部。
      // 量寬度要等排版，放到下一個畫面前，不在這裡強迫瀏覽器立刻排版整頁。
      if (scope.querySelector("table")) requestAnimationFrame(() => mark(scope));
    },
  };
}
