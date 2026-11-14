/**
 * 焦點不在可以輸入的地方時，Ctrl+Z 復原文件、Ctrl+Y／Ctrl+Shift+Z 重做，和在編輯區裡按一樣。
 * 在大綱拖曳或用 Alt+↑／↓ 搬移章節、在預覽或即時預覽拖動段落、按工具列的按鈕之後，焦點停在大綱的標題、
 * 把手、按鈕或頁面本身，按鍵送不到編輯器；不處理的話要先點回編輯區才能復原。
 */
import { redo, undo } from "@codemirror/commands";
import { app } from "./context.ts";

/** 有自己的 Ctrl+Z 的地方：輸入框、編輯區（包括並排編輯的另一個編輯器）、選單與清單。 */
const OWN_UNDO =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), .cm-editor, [role='menu'], [role='listbox']";

function onKeydown(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.altKey || !(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  const isUndo = key === "z" && !e.shiftKey;
  const isRedo = (key === "y" && !e.shiftKey) || (key === "z" && e.shiftKey);
  if (!isUndo && !isRedo) return;
  const active = document.activeElement;
  if (active instanceof Element && active.closest(OWN_UNDO)) return;
  // 開著對話框（設定、指令面板…）時不動到後面的文件。
  if (document.querySelector("dialog[open]")) return;
  const view = app.editor.view;
  if (view.state.readOnly) return;
  // 只復原看得到的文件：編輯區與預覽都沒顯示（例如目前的分頁是工作項目）時不動。
  if (!view.dom.getClientRects().length && !app.previewScroller.getClientRects().length) return;
  if (!(isUndo ? undo(view) : redo(view))) return;
  e.preventDefault();
  app.renderNow();
}

export function initUndoKeys(): void {
  document.addEventListener("keydown", onKeydown);
}
