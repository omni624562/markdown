/**
 * 複製整個表格：貼到 Word、Outlook、Teams 時是真正的表格（格式文字），貼到純文字的地方是 Markdown。
 * 即時預覽的表格工具列有「複製」按鈕（table-widget.ts 發出 `table-copy` 事件，這裡接）；
 * 原始碼、分割模式游標在表格裡時，用右鍵選單「表格」或指令面板的「表格：複製整個表格」。
 */
import { t } from "../i18n.ts";
import { tableAt } from "../table.ts";
import { TABLE_COPY_EVENT } from "../table-widget.ts";
import { toast } from "../ui/toast.ts";
import { writeRichClipboard } from "./activity-bar.ts";
import { app } from "./context.ts";

export async function copyTable(markdown: string): Promise<void> {
  if (await writeRichClipboard(markdown)) toast(t("已複製表格，可以貼到 Word、Outlook、Teams"), { tone: "success" });
}

/** 複製游標所在的表格。 */
export function copyTableAtCursor(): void {
  const { state } = app.editor.view;
  const table = tableAt(state, state.selection.main.head);
  if (!table) {
    toast(t("請先把游標移到表格裡。"));
    return;
  }
  void copyTable(state.sliceDoc(table.from, table.to));
}

export function initTableCopy(): void {
  document.addEventListener(TABLE_COPY_EVENT, (e) => void copyTable((e as CustomEvent<string>).detail));
}
