/**
 * 表格文字：貼上 Tab 分隔的文字（從 Excel、Google 試算表、資料庫工具複製）時直接變成 Markdown 表格；
 * 選取 Tab 或逗號分隔的幾行文字，按右鍵「轉成表格」。程式碼區塊與表格裡不轉。
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { formatTable } from "../../pkg/md_wasm.js";
import { pasteAsMarkdown } from "../html-paste.ts";
import { t } from "../i18n.ts";
import { inTable } from "../table.ts";
import { pastedTable, textToTable } from "../table-convert.ts";
import { toast } from "../ui/toast.ts";
import { app } from "./context.ts";

const CODE = new Set(["FencedCode", "CodeBlock", "InlineCode", "CodeText", "HTMLBlock"]);

function inCode(state: EditorState, pos: number): boolean {
  for (let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (CODE.has(n.name)) return true;
  }
  return false;
}

/** 依設定對齊表格（和 Tab 移動儲存格時一樣）。 */
const format = (md: string) => (app.settings.value.tableAutoFormat ? (formatTable(md) ?? md) : md);

/** 表格前後要空一行：放進去的位置前面或後面有文字時補上換行。 */
export function withBlankLines(state: EditorState, from: number, to: number, table: string): string {
  const first = state.doc.lineAt(from);
  const last = state.doc.lineAt(to);
  const before = first.text.slice(0, from - first.from);
  const after = last.text.slice(to - last.from);
  const prev = first.number > 1 ? state.doc.line(first.number - 1).text : "";
  const next = last.number < state.doc.lines ? state.doc.line(last.number + 1).text : "";
  const head = before.trim() ? "\n\n" : prev.trim() ? "\n" : "";
  const tail = after.trim() ? "\n\n" : next.trim() ? "\n" : "";
  return head + table + tail;
}

/**
 * 智慧貼上的文字：網頁、Word 的格式轉成 Markdown（見 html-paste.ts）；Tab 分隔的純文字轉成 Markdown 表格。
 * 都不是時回傳 null（照原樣貼上）。
 */
export function smartPasteText(state: EditorState, html: string, plain: string): string | null {
  const md = pasteAsMarkdown(html, plain);
  if (md !== null) return md;
  const { from, to } = state.selection.main;
  if (inCode(state, from) || inTable(state)) return null;
  const table = pastedTable(plain);
  if (!table) return null;
  toast(t("已轉成表格。要貼上原本的文字，請按右鍵選「貼上純文字」。"), { duration: 6000 });
  return withBlankLines(state, from, to, format(table));
}

/** 選取範圍涵蓋的整行（選到下一行開頭時不算那一行）。 */
function selectedLines(state: EditorState): { from: number; to: number; text: string } | null {
  const sel = state.selection.main;
  if (sel.empty || state.selection.ranges.length > 1) return null;
  const first = state.doc.lineAt(sel.from);
  let last = state.doc.lineAt(sel.to);
  if (sel.to === last.from && last.number > first.number) last = state.doc.line(last.number - 1);
  return { from: first.from, to: last.to, text: state.sliceDoc(first.from, last.to) };
}

/** 選取的幾行是 Tab 或逗號分隔、每行欄數一樣的文字（右鍵選單的「轉成表格」）。 */
export function canConvertToTable(state: EditorState): boolean {
  const s = selectedLines(state);
  return !!s && !inTable(state) && !inCode(state, s.from) && textToTable(s.text) !== null;
}

/** 把選取的幾行轉成 Markdown 表格（第一行是標題列）。 */
export function convertSelectionToTable(): void {
  const view = app.editor.view;
  const s = selectedLines(view.state);
  const table = s && textToTable(s.text);
  if (!s || !table) {
    toast(t("選取的每一行都要用 Tab 或逗號分成同樣的欄數，才能轉成表格。"));
    return;
  }
  const insert = withBlankLines(view.state, s.from, s.to, format(table));
  view.dispatch({ changes: { from: s.from, to: s.to, insert }, selection: { anchor: s.from + insert.length }, scrollIntoView: true, userEvent: "input.table" });
  view.focus();
}
