/**
 * 編輯器與預覽之間的分隔線：可拖曳、可用方向鍵調整，雙擊恢復一半一半。
 */
import { t } from "../i18n.ts";
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
    const preview = container.querySelector<HTMLElement>(".preview-pane")!;
    const left = editor.getBoundingClientRect().left;
    const width = preview.getBoundingClientRect().right - left;
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
