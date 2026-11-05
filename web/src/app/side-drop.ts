/**
 * 拖曳分頁到編輯區的右半邊就並排開啟：拖到右半邊時出現虛線框「放開：在右邊並排開啟」，放開就把那份文件開在右邊。
 * 已經在並排時，拖到右邊那一塊就換掉右邊的文件。
 */
import { t } from "../i18n.ts";
import { icon } from "../ui/icons.ts";
import { app } from "./context.ts";

/** 拖曳分頁時放進 dataTransfer 的資料類型（值是分頁的 id）。 */
export const TAB_DRAG_TYPE = "application/x-omarker-tab";

export function initSideDrop(): void {
  // 文件的分頁都可以拖（工作項目、Wiki 頁面等不行）。
  app.tabBar.extend({ dragData: (id) => (app.docs.some((d) => d.id === id) ? { [TAB_DRAG_TYPE]: id } : null) });

  const zone = document.createElement("div");
  zone.className = "side-drop";
  zone.hidden = true;
  zone.setAttribute("aria-hidden", "true");
  zone.append(icon("panel-right"), Object.assign(document.createElement("span"), { textContent: t("放開：在右邊並排開啟") }));
  document.body.append(zone);

  const workspace = app.$(".workspace");
  const editorPane = app.$(".editor-pane");
  const sidePane = app.$("#side-pane");
  /** 放得下的地方：已經並排時是右邊那一塊，沒有並排時是編輯區的右半邊。 */
  const target = (): DOMRect | null => {
    if (sidePane.getClientRects().length) return sidePane.getBoundingClientRect();
    if (!editorPane.getClientRects().length) return null;
    const r = editorPane.getBoundingClientRect();
    return new DOMRect(r.left + r.width / 2, r.top, r.width / 2, r.height);
  };
  const inside = (r: DOMRect | null, e: DragEvent) => !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  const show = (r: DOMRect | null) => {
    zone.hidden = !r;
    if (r) Object.assign(zone.style, { left: `${r.left + 6}px`, top: `${r.top + 6}px`, width: `${r.width - 12}px`, height: `${r.height - 12}px` });
  };
  const isTab = (e: DragEvent) => !!e.dataTransfer?.types.includes(TAB_DRAG_TYPE);

  // 在捕捉階段處理，編輯器不會把拖進來的資料當成文字插入。
  workspace.addEventListener(
    "dragover",
    (e) => {
      if (!isTab(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const r = target();
      const on = inside(r, e);
      e.dataTransfer!.dropEffect = on ? "copy" : "none";
      show(on ? r : null);
    },
    true,
  );
  workspace.addEventListener("dragleave", (e) => {
    if (!workspace.contains(e.relatedTarget as Node | null)) show(null);
  });
  workspace.addEventListener(
    "drop",
    (e) => {
      if (!isTab(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const on = inside(target(), e);
      show(null);
      const doc = app.docs.find((d) => d.id === e.dataTransfer!.getData(TAB_DRAG_TYPE));
      if (on && doc) app.openBeside(doc);
    },
    true,
  );
  document.addEventListener("dragend", () => show(null));
}
