/**
 * 「預覽」模式不能編輯：在預覽裡打字什麼都不會發生，看起來像當掉。這裡在打字時跳出一則通知
 * 「預覽不能編輯」，上面有按鈕直接切換到可以編輯的模式（Markdown 是即時預覽，其他是原始碼）。
 * 只管焦點在預覽或頁面本身時打的字；輸入框（尋找列、助理、設定…）、快速鍵（Ctrl／Alt 的組合）、
 * 捲動用的按鍵（空白鍵、方向鍵、PageUp／PageDown）都不算。
 */
import { t } from "../i18n.ts";
import { toast } from "../ui/toast.ts";
import { app } from "./context.ts";

/** 這個按鍵是想輸入或刪除文字（包括輸入法正在組字）。 */
export function isTypingKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "isComposing">): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.isComposing || e.key === "Process") return true;
  if (e.key === "Backspace" || e.key === "Delete") return true;
  // 一個字元的按鍵是打字；空白鍵在預覽是往下捲一頁。
  return [...e.key].length === 1 && e.key !== " ";
}

function onKeydown(e: KeyboardEvent): void {
  if (e.defaultPrevented || app.view !== "preview" || !isTypingKey(e)) return;
  if (!app.previewScroller.getClientRects().length) return;
  const active = document.activeElement;
  const here = !active || active === document.body || app.previewScroller.contains(active);
  if (!here || (active instanceof HTMLElement && (active.isContentEditable || active.matches("input, textarea, select")))) return;
  if (document.querySelector("dialog[open], [popover]:popover-open:not(.toasts)")) return;
  const target = app.cur.kind === "markdown" ? "live" : "editor";
  toast(t("預覽不能編輯"), {
    action: {
      label: target === "live" ? t("切換到即時預覽") : t("切換到原始碼"),
      primary: true,
      run: () => {
        app.setView(target);
        app.editor.view.focus();
      },
    },
  });
}

export function initPreviewHint(): void {
  document.addEventListener("keydown", onKeydown);
}
