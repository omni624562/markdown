import type { PreviewPlugin, Queryable } from "../preview.ts";

/**
 * 預覽中的表格：寬度放得下的表格標上 .fits，往下捲動時標題列固定在上方。
 * 太寬的表格要左右捲動，瀏覽器沒辦法同時固定標題列，維持原樣。預覽寬度改變時重新判斷。
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
