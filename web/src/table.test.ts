import assert from "node:assert/strict";
import { test } from "node:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type StateCommand } from "@codemirror/state";
import { cellIndexAt, editTable, newRow, nextCell, previousCell, splitCells, tableAt } from "./table.ts";

// 測試用的排版器：簡單地對齊欄寬（真正的程式使用 Rust 的 formatTable）。
const format = (block: string) => {
  const rows = block.split("\n").map((l) => splitCells(l).map((c) => c.text));
  const cols = Math.max(...rows.map((r) => r.length));
  const w = Array.from({ length: cols }, (_, c) => Math.max(3, ...rows.map((r) => (r[c] ?? "").length)));
  return rows
    .map((r, i) => `| ${w.map((n, c) => (i === 1 ? "-".repeat(n) : (r[c] ?? "").padEnd(n))).join(" | ")} |`)
    .join("\n");
};
const notComposing = () => false;

function run(cmd: StateCommand, doc: string): { text: string; sel: string } | null {
  const pos = doc.indexOf("‸");
  let state = EditorState.create({
    doc: doc.replace("‸", ""),
    selection: EditorSelection.cursor(pos),
    extensions: markdown({ base: markdownLanguage }),
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const ok = cmd({ state, dispatch: (tr) => (state = tr.state) });
  if (!ok) return null;
  const { from, to } = state.selection.main;
  return { text: state.doc.toString(), sel: state.sliceDoc(from, to) || `@${from}` };
}

const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";

test("splitCells 處理跳脫字元與行內程式碼", () => {
  assert.deepEqual(
    splitCells("| `x|y` | \\| | z |").map((c) => c.text),
    ["`x|y`", "\\|", "z"],
  );
  assert.deepEqual(
    splitCells("a | b").map((c) => c.text),
    ["a", "b"],
  );
  assert.equal(cellIndexAt("| a | b |", 6), 1);
});

test("tableAt 忽略程式碼區塊裡的 |", () => {
  const state = EditorState.create({ doc: "```\n| a | b |\n| - | - |\n```", extensions: markdown({ base: markdownLanguage }) });
  ensureSyntaxTree(state, state.doc.length, 5000);
  assert.equal(tableAt(state, 6), null);
});

test("Tab 移到下一格並選取內容，跳過分隔列", () => {
  assert.equal(run(nextCell(format, notComposing), "| a‸ | b |\n| --- | --- |\n| 1 | 2 |")?.sel, "b");
  assert.equal(run(nextCell(format, notComposing), "| a | b‸ |\n| --- | --- |\n| 1 | 2 |")?.sel, "1");
});

test("最後一格按 Tab 新增一列", () => {
  const r = run(nextCell(format, notComposing), "| a | b |\n| --- | --- |\n| 1 | 2‸ |")!;
  assert.equal(r.text.split("\n").length, 4);
  assert.match(r.text.split("\n")[3], /^\|\s+\|\s+\|$/);
});

test("Shift+Tab 回到上一格", () => {
  assert.equal(run(previousCell(format, notComposing), "| a | b |\n| --- | --- |\n| 1 | 2‸ |")?.sel, "1");
  assert.equal(run(previousCell(format, notComposing), "| a | b |\n| --- | --- |\n| 1‸ | 2 |")?.sel, "b");
});

test("Enter 新增列；空白列按 Enter 離開表格", () => {
  const added = run(newRow(format, notComposing), "| a | b |\n| --- | --- |\n| 1‸ | 2 |")!;
  assert.equal(added.text.split("\n").length, 4);
  const exited = run(newRow(format, notComposing), "| a | b |\n| --- | --- |\n| 1 | 2 |\n|  ‸ |  |")!;
  assert.equal(exited.text, `${format(table)}\n`);
});

test("組字中不攔截按鍵", () => {
  assert.equal(run(nextCell(format, () => true), "| a‸ | b |\n| --- | --- |\n| 1 | 2 |"), null);
});

test("不在表格中時交給其他按鍵處理", () => {
  assert.equal(run(nextCell(format, notComposing), "一般段落‸"), null);
});

test("插入欄、刪除列", () => {
  const col = run(editTable("insert-column", format), "| a‸ | b |\n| --- | --- |\n| 1 | 2 |")!;
  assert.equal(splitCells(col.text.split("\n")[0]).length, 3);
  const del = run(editTable("delete-row", format), "| a | b |\n| --- | --- |\n| 1‸ | 2 |\n| 3 | 4 |")!;
  assert.ok(!del.text.includes("| 1"));
  assert.equal(run(editTable("delete-row", format), "| a‸ | b |\n| --- | --- |\n| 1 | 2 |"), null);
});
