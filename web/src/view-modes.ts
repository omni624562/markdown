/**
 * 檢視模式（狀態列右邊的「原始碼／即時預覽／分割／預覽」）與各種文件類型用得到的模式。
 *
 * 純文字（含程式碼）的預覽只是把內容原樣再顯示一次，分割是兩邊一模一樣、預覽只是不能打字，
 * 即時預覽在編輯器裡根本不會啟用（editor.ts 只對 Markdown 開）：只留原始碼。
 * JSON 的預覽會驗證格式、畫成可摺疊的樹狀圖，分割和預覽有用，只拿掉即時預覽。
 */
import type { DocKind } from "./kinds.ts";
import * as storage from "./storage.ts";

export type ViewMode = "editor" | "live" | "split" | "preview";

export const VIEW_MODES: readonly ViewMode[] = ["editor", "live", "split", "preview"];

export function isViewMode(v: unknown): v is ViewMode {
  return (VIEW_MODES as readonly unknown[]).includes(v);
}

/** 這種文件類型用得到的檢視模式。 */
export function viewsFor(kind: DocKind): readonly ViewMode[] {
  switch (kind) {
    case "markdown":
      return VIEW_MODES;
    case "json":
      return ["editor", "split", "preview"];
    default:
      return ["editor"];
  }
}

/**
 * 這份文件實際要用的檢視：`chosen` 是使用者選的模式（存在設定裡，換回 Markdown 時照舊），
 * 這種文件用不到時退回原始碼；沒選過或值壞掉時用分割。
 */
export function viewFor(chosen: string | null | undefined, kind: DocKind): ViewMode {
  const mode: ViewMode = isViewMode(chosen) ? chosen : "split";
  return viewsFor(kind).includes(mode) ? mode : "editor";
}

/** 使用者這次選的模式（沒有儲存空間時，這個工作階段還是記得）。 */
let chosen: ViewMode | null = null;

/** 記住使用者選的模式：存進設定，換回 Markdown 時照舊。 */
export function chooseView(mode: ViewMode): void {
  chosen = mode;
  storage.save("view", mode);
}

/** 目前這份文件實際要用的檢視（見 {@link viewFor}）。 */
export function currentView(kind: DocKind): ViewMode {
  return viewFor(chosen ?? storage.load("view"), kind);
}

/** 狀態列的檢視切換：只顯示這種文件用得到的模式、標出目前的那一個；只剩一個可選時整組藏起來。 */
export function applyViewSwitch(root: ParentNode, kind: DocKind, current: ViewMode): void {
  const allowed = viewsFor(kind);
  for (const b of root.querySelectorAll<HTMLButtonElement>(".view-switch [data-view]")) {
    const mode = b.dataset.view as ViewMode;
    b.hidden = !allowed.includes(mode);
    b.setAttribute("aria-checked", String(mode === current));
  }
  const group = root.querySelector<HTMLElement>(".view-switch");
  if (group) group.hidden = allowed.length < 2;
}
