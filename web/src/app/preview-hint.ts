/**
 * 「預覽」模式不能編輯：在預覽裡打字什麼都不會發生，看起來像當掉。這裡在打字時跳出一則通知
 * 「預覽不能編輯」，上面有按鈕直接切換到可以編輯的模式（Markdown 是即時預覽，其他是原始碼）。
 * 只管焦點在預覽或頁面本身時打的字；輸入框（尋找列、助理、設定…）、快速鍵（Ctrl／Alt 的組合）、
 * 捲動用的按鍵（空白鍵、方向鍵、PageUp／PageDown）都不算。
 */
import { t } from "../i18n.ts";
import { isTypingKey } from "../typing-key.ts";
import { toast } from "../ui/toast.ts";
import { app } from "./context.ts";

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
