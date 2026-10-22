import type { PreviewPlugin } from "../preview.ts";

/**
 * 預覽中的表格：寬度放得下的表格標上 .fits，往下捲動時標題列固定在上方。
 * 太寬的表格要左右捲動，瀏覽器沒辦法同時固定標題列，維持原樣。預覽寬度改變時重新判斷。
 */
export function tablesPlugin(): PreviewPlugin {
  const mark = (root: HTMLElement) => {
    for (const table of root.querySelectorAll<HTMLTableElement>("table")) {
      // 先拿掉 .fits（恢復可捲動），才量得到真正需要的寬度。
      table.classList.remove("fits");
      if (table.tHead && table.scrollWidth <= table.clientWidth + 1) table.classList.add("fits");
    }
  };
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) mark(entry.target as HTMLElement);
  });
  let observed: HTMLElement | null = null;
  return {
    name: "tables",
    apply(root) {
      if (observed !== root) {
        observer.observe(root);
        observed = root;
      }
      if (root.querySelector("table")) mark(root);
    },
  };
}
