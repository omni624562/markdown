/**
 * 焦點不在可以輸入的地方時，Ctrl+Z 復原文件、Ctrl+Y／Ctrl+Shift+Z 重做，和在編輯區裡按一樣。
 * 在大綱拖曳或用 Alt+↑／↓ 搬移章節、在預覽或即時預覽拖動段落、按工具列的按鈕之後，焦點停在大綱的標題、
 * 把手、按鈕或頁面本身，按鍵送不到編輯器；不處理的話要先點回編輯區才能復原。
 */
import { redo, undo } from "@codemirror/commands";
import type { Text } from "@codemirror/state";
import { t } from "../i18n.ts";
import { announce as speak } from "../ui/toast.ts";
import { app } from "./context.ts";

/** 有自己的 Ctrl+Z 的地方：輸入框、編輯區（包括並排編輯的另一個編輯器）、選單與清單。 */
const OWN_UNDO =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), .cm-editor, [role='menu'], [role='listbox']";

/** 一步做完的大改動（例如搬移章節）：記下前後的內容與名稱，復原、重做時才說得出「復原了什麼」。 */
interface Step {
  before: Text;
  after: Text;
  label: string;
}
const steps: Step[] = [];
const MAX_STEPS = 30;

/**
 * 執行一個一步就能復原的改動，並記下它的名稱（`label`，例如「調整順序」）。之後復原、重做到這一步時，
 * 螢幕閱讀器念出「已復原：調整順序」（畫面上看得到文件改回去了，不跳通知），使用者才知道一次回去的那一大步是什麼。
 */
export function labelStep(label: string, apply: () => void): void {
  const before = app.editor.view.state.doc;
  apply();
  const after = app.editor.view.state.doc;
  if (after.eq(before)) return;
  steps.push({ before, after, label });
  if (steps.length > MAX_STEPS) steps.shift();
}

/** 文件從 `before` 變成 `after`：剛好是某個有名稱的步驟被復原或重做時，說明一下。 */
function announce(before: Text, after: Text): void {
  if (before === after) return;
  const same = (a: Text, b: Text) => a === b || (a.length === b.length && a.eq(b));
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (same(step.after, before) && same(step.before, after)) return void speak(t("已復原：{what}", { what: step.label }));
    if (same(step.before, before) && same(step.after, after)) return void speak(t("已重做：{what}", { what: step.label }));
  }
}

/** 復原（`redo` 為 true 時重做）目前的文件；有做事回傳 true。從選單、指令面板、通知上的按鈕、編輯區外面的按鍵呼叫。 */
export function undoDoc(again = false): boolean {
  const view = app.editor.view;
  if (view.state.readOnly) return false;
  const before = view.state.doc;
  if (!(again ? redo(view) : undo(view))) return false;
  app.renderNow();
  announce(before, view.state.doc);
  return true;
}

const isUndoKey = (e: KeyboardEvent): "undo" | "redo" | null => {
  if (e.altKey || !(e.ctrlKey || e.metaKey)) return null;
  const key = e.key.toLowerCase();
  if (key === "z" && !e.shiftKey) return "undo";
  if ((key === "y" && !e.shiftKey) || (key === "z" && e.shiftKey)) return "redo";
  return null;
};

/** 按下時文件的內容：編輯區自己處理了 Ctrl+Z 之後，拿來比對是不是復原了某個有名稱的步驟。 */
let docAtKeydown: Text | null = null;

function onKeydown(e: KeyboardEvent): void {
  const kind = isUndoKey(e);
  if (!kind) return;
  if (e.defaultPrevented) {
    // 編輯區（CodeMirror）自己復原了：只補上說明。
    if (docAtKeydown) announce(docAtKeydown, app.editor.view.state.doc);
    return;
  }
  const active = document.activeElement;
  if (active instanceof Element && active.closest(OWN_UNDO)) return;
  // 開著對話框（設定、指令面板…）時不動到後面的文件。
  if (document.querySelector("dialog[open]")) return;
  const view = app.editor.view;
  // 只復原看得到的文件：編輯區與預覽都沒顯示（例如目前的分頁是工作項目）時不動。
  if (!view.dom.getClientRects().length && !app.previewScroller.getClientRects().length) return;
  if (undoDoc(kind === "redo")) e.preventDefault();
}

export function initUndoKeys(): void {
  document.addEventListener(
    "keydown",
    (e) => {
      docAtKeydown = isUndoKey(e) ? app.editor.view.state.doc : null;
    },
    true,
  );
  document.addEventListener("keydown", onKeydown);
}
