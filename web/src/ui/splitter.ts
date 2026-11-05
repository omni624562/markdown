/**
 * 編輯器與預覽之間的分隔線：可拖曳、可用方向鍵調整，雙擊恢復一半一半。
 */
import { t } from "../i18n.ts";

/**
 * 分隔線右邊那一塊的右緣：平常是預覽；兩份文件並排時是右邊的編輯器，工作項目等內容並排時是那份內容。
 * 這些時候預覽藏起來（寬度是 0），不能拿預覽來算，不然拖曳的比例會變成負的、左邊被壓到最窄。
 */
function rightEdge(container: HTMLElement, handle: HTMLElement): number {
  let right = handle.getBoundingClientRect().right;
  for (const el of container.querySelectorAll<HTMLElement>(":scope > :is(.preview-pane, .side-editor-pane, .issue-pane)")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0) right = Math.max(right, r.right);
  }
  return right;
}

export function setupSplitter(
  handle: HTMLElement,
  container: HTMLElement,
  initial: number,
  onChange: (ratio: number) => void,
): (ratio: number) => void {
  const clamp = (r: number) => Math.min(0.8, Math.max(0.2, r));
  let ratio = clamp(initial);

  const set = (r: number) => {
    ratio = clamp(r);
    handle.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    onChange(ratio);
  };

  handle.role = "separator";
  handle.tabIndex = 0;
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", t("調整編輯區與預覽的寬度（方向鍵調整，雙擊恢復）"));
  handle.setAttribute("aria-valuemin", "20");
  handle.setAttribute("aria-valuemax", "80");

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const editor = container.querySelector<HTMLElement>(".editor-pane")!;
    const left = editor.getBoundingClientRect().left;
    const width = rightEdge(container, handle) - left;
    const move = (ev: PointerEvent) => set((ev.clientX - left) / width);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      document.body.classList.remove("resizing");
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  });
  handle.addEventListener("dblclick", () => set(0.5));
  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === "ArrowLeft") set(ratio - step);
    else if (e.key === "ArrowRight") set(ratio + step);
    else if (e.key === "Home") set(0.2);
    else if (e.key === "End") set(0.8);
    else return;
    e.preventDefault();
  });

  set(ratio);
  return set;
}
