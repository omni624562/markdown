/**
 * 側邊欄（檔案、大綱等面板）的寬度：拖曳面板邊緣調整，方向鍵也可以調，雙擊恢復預設寬度。
 * 寬度寫在 `--outline-width`，左邊的側邊欄和放在右邊的大綱共用。
 */
export const SIDEBAR_WIDTH = { min: 180, max: 560, default: 248 } as const;

export function clampSidebarWidth(px: number): number {
  return Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, px)));
}

/**
 * 在面板邊緣加上拖曳把手。`side` 是面板在左邊還是右邊。
 * 把手放在 `host`（版面）裡、跨在面板的邊框上，不會蓋住面板裡的捲軸。
 */
export function setupSidebarResize(
  host: HTMLElement,
  side: "left" | "right",
  get: () => number,
  set: (px: number) => void,
): void {
  const handle = document.createElement("div");
  handle.className = `sidebar-resizer ${side}`;
  handle.role = "separator";
  handle.tabIndex = 0;
  handle.title = "拖曳調整寬度（雙擊恢復）";
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", "調整側邊欄寬度（方向鍵調整，雙擊恢復）");
  handle.setAttribute("aria-valuemin", String(SIDEBAR_WIDTH.min));
  handle.setAttribute("aria-valuemax", String(SIDEBAR_WIDTH.max));
  const apply = (px: number) => {
    const w = clampSidebarWidth(px);
    handle.setAttribute("aria-valuenow", String(w));
    set(w);
  };
  // 右邊的大綱往左拖是變寬。
  const dir = side === "right" ? -1 : 1;

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const startX = e.clientX;
    const startWidth = get();
    const move = (ev: PointerEvent) => apply(startWidth + dir * (ev.clientX - startX));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      document.body.classList.remove("resizing");
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  });
  handle.addEventListener("dblclick", () => apply(SIDEBAR_WIDTH.default));
  handle.addEventListener("keydown", (e) => {
    const step = (e.shiftKey ? 48 : 16) * dir;
    if (e.key === "ArrowLeft") apply(get() - step);
    else if (e.key === "ArrowRight") apply(get() + step);
    else return;
    e.preventDefault();
  });
  host.append(handle);
}
