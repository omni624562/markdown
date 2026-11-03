/**
 * 浮動選單（下拉選單、右鍵選單）上的滑鼠滾輪只捲選單本身：選單不用捲、或已經捲到底時，
 * 不要讓後面的清單跟著捲（Windows 的 WebView2 會把選單上的捲動交給選單後面的清單）。
 */

/** 從 `target` 往上到 `root`（含）之間，有沒有元素還能往這個方向捲。 */
function canScroll(target: EventTarget | null, root: HTMLElement, dx: number, dy: number): boolean {
  for (let n = target instanceof Element ? target : null; n; n = n === root ? null : n.parentElement) {
    if (!(n instanceof HTMLElement)) continue;
    const s = getComputedStyle(n);
    if (dy && /auto|scroll/.test(s.overflowY) && (dy < 0 ? n.scrollTop > 0 : n.scrollTop + n.clientHeight < n.scrollHeight - 1)) return true;
    if (dx && /auto|scroll/.test(s.overflowX) && (dx < 0 ? n.scrollLeft > 0 : n.scrollLeft + n.clientWidth < n.scrollWidth - 1)) return true;
  }
  return false;
}

/** 滾輪在 `el` 上時，裡面捲得動的照常捲，捲不動的就停在這裡，不交給後面的元素。 */
export function containWheel(el: HTMLElement): void {
  el.style.overscrollBehavior = "contain";
  el.addEventListener(
    "wheel",
    (e) => {
      // Ctrl＋滾輪是縮放，不攔。
      if (e.ctrlKey) return;
      if (!canScroll(e.target, el, e.deltaX, e.deltaY)) e.preventDefault();
    },
    { passive: false },
  );
}
