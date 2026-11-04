/**
 * Wiki 頁面最上面的大標題（和工作項目的標題一樣）：頁名只在內容最上面大字出現一次，
 * 往下捲到看不到時，標頭在位置後面帶出頁名（見 issue-view.ts 的 `h1.page-hero`）。
 * 內容一開始就是和頁名一樣的大標題時直接用它；沒有時在最上面補一個。
 */

/** 比較標題用：去掉前後空白、連續空白當成一個、不分大小寫（頁名的 `-` 在網址上代表空白）。 */
export function sameTitle(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/-/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return norm(a) === norm(b);
}

/** 標出（或補上）頁面的大標題；重畫時重複呼叫沒有影響。 */
export function markPageHero(body: HTMLElement, title: string): void {
  const first = body.firstElementChild;
  if (first instanceof HTMLHeadingElement && first.classList.contains("page-hero")) {
    // 補上的標題留著；內容自己的標題（重畫時是新的元素）照下面重新判斷。
    if (first.dataset.added === "1") first.textContent = title;
    return;
  }
  if (first instanceof HTMLHeadingElement && first.tagName === "H1" && sameTitle(first.textContent ?? "", title)) {
    first.classList.add("page-hero");
    return;
  }
  const h1 = document.createElement("h1");
  h1.className = "page-hero";
  h1.dataset.added = "1";
  h1.textContent = title;
  body.prepend(h1);
}
