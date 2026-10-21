/**
 * Windows 桌面版的標題列：不用系統的標題列，頂端列兼當標題列。
 * 空白處按住拖曳可以移動視窗（拖到螢幕邊緣會貼齊）、連按兩下最大化或還原，
 * 右邊是和 Windows 一樣的最小化、最大化、關閉按鈕。
 */

type Action = "minimize" | "toggle-maximize" | "close" | "drag" | "state";

/** 和 Windows 標題列一樣的細線圖示（10×10）。 */
const GLYPHS = {
  minimize: '<path d="M0 5.5h10"/>',
  maximize: '<rect x="0.5" y="0.5" width="9" height="9"/>',
  restore: '<rect x="0.5" y="2.5" width="7" height="7"/><path d="M2.5 2.5v-2h7v7h-2"/>',
  close: '<path d="M0.5 0.5l9 9M9.5 0.5l-9 9"/>',
};

function glyph(name: keyof typeof GLYPHS): string {
  return `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">${GLYPHS[name]}</svg>`;
}

/** 在頂端列上按這些元素不會拖曳視窗。 */
const INTERACTIVE = "button, a, input, select, textarea, [role=tab], [role=radiogroup], [contenteditable]";

export function setupWindowControls(topbar: HTMLElement, control: (action: Action) => Promise<boolean>): void {
  document.documentElement.classList.add("custom-titlebar");
  const box = document.createElement("div");
  box.className = "window-controls";
  const button = (cls: string, label: string, action: Action) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `window-btn ${cls}`;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.tabIndex = -1;
    b.addEventListener("click", () => void control(action).then(show, console.error));
    box.append(b);
    return b;
  };
  const min = button("window-min", "最小化", "minimize");
  const max = button("window-max", "最大化", "toggle-maximize");
  const close = button("window-close", "關閉", "close");
  min.innerHTML = glyph("minimize");
  close.innerHTML = glyph("close");
  topbar.append(box);

  /** 依視窗是否最大化切換圖示。 */
  function show(maximized: boolean): void {
    max.innerHTML = glyph(maximized ? "restore" : "maximize");
    const label = maximized ? "還原" : "最大化";
    max.title = label;
    max.setAttribute("aria-label", label);
    document.documentElement.classList.toggle("window-maximized", maximized);
  }
  const refresh = () => void control("state").then(show, console.error);
  refresh();
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(refresh, 100);
  });

  topbar.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || (e.target as Element).closest(INTERACTIVE)) return;
    e.preventDefault();
    // 連按兩下：最大化／還原；按住：拖曳。
    void control(e.detail === 2 ? "toggle-maximize" : "drag").then(show, console.error);
  });
}
