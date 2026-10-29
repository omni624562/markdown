import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorState } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { type InlineTag, blockMath, inlineMath, mapBlocks, mermaidSource, pairTags, parseTag } from "./live-preview.ts";
import { rangeChecker } from "./ranges.ts";

test("行內公式的規則和 md-core 一致", () => {
  assert.deepEqual(inlineMath("能量 $E=mc^2$ 守恆"), [{ from: 3, to: 11, tex: "E=mc^2" }]);
  assert.deepEqual(inlineMath("價格是 $5 到 $10"), []); // 結尾的 $ 後面接數字
  assert.deepEqual(inlineMath("$ x $"), []); // 開頭或結尾是空白
  assert.deepEqual(inlineMath("跳脫 \\$x$"), []);
  assert.deepEqual(
    inlineMath("$a$ 和 $b$").map((m) => m.tex),
    ["a", "b"],
  );
});

test("區塊公式", () => {
  assert.equal(blockMath("$$\nE=mc^2\n$$"), "\nE=mc^2\n");
  assert.equal(blockMath("文字 $$x$$"), null);
});

test("流程圖區塊的原始碼", () => {
  assert.equal(mermaidSource("```mermaid\nflowchart LR\n  A --> B\n```"), "flowchart LR\n  A --> B");
  assert.equal(mermaidSource("~~~~ mermaid title\ngraph TD\n~~~~"), "graph TD");
  // 還沒打結尾圍欄：整段都是原始碼
  assert.equal(mermaidSource("```mermaid\ngraph TD\n  A"), "graph TD\n  A");
  // 結尾圍欄比開頭短或字元不同，不算結尾
  assert.equal(mermaidSource("````mermaid\ngraph TD\n```"), "graph TD\n```");
  assert.equal(mermaidSource("```mermaid\ngraph TD\n~~~"), "graph TD\n~~~");
  assert.equal(mermaidSource("```js\nlet a\n```"), null);
  assert.equal(mermaidSource("```mermaidx\ngraph\n```"), null);
  assert.equal(mermaidSource("```mermaid"), null);
});

test("格式標籤：只認不帶屬性的 u／mark／sup／sub", () => {
  assert.deepEqual(parseTag("<u>"), { name: "u", closing: false });
  assert.deepEqual(parseTag("</MARK>"), { name: "mark", closing: true });
  assert.equal(parseTag('<u style="x">'), null);
  assert.equal(parseTag("<span>"), null);
});

test("格式標籤配對：同層、同名、正確巢狀", () => {
  const t = (name: InlineTag["name"], closing: boolean, at: number, parent = 0): InlineTag => ({
    name,
    closing,
    from: at,
    to: at + 1,
    parent,
  });
  const names = (pairs: [InlineTag, InlineTag][]) => pairs.map(([a, b]) => `${a.name}${a.from}-${b.from}`);
  assert.deepEqual(names(pairTags([t("mark", false, 0), t("sup", false, 2), t("sup", true, 4), t("mark", true, 6)])), [
    "sup2-4",
    "mark0-6",
  ]);
  // 交錯時，結尾對不上最近開頭的標籤不算（和 Rust 核心相同）；沒有結尾的開頭不配
  assert.deepEqual(names(pairTags([t("u", false, 0), t("mark", false, 2), t("u", true, 4), t("mark", true, 6)])), [
    "mark2-6",
  ]);
  // 不同層不配對
  assert.deepEqual(names(pairTags([t("u", false, 0, 0), t("u", true, 4, 9)])), []);
});

test("rangeChecker：合併重疊範圍後用二分搜尋判斷", () => {
  const inside = rangeChecker([[50, 60], [10, 20], [15, 30], [100, 200], [120, 130]]);
  assert.equal(inside(0, 10), false);
  assert.equal(inside(9, 11), true);
  assert.equal(inside(25, 35), true);
  assert.equal(inside(30, 50), false);
  assert.equal(inside(59, 61), true);
  assert.equal(inside(140, 150), true);
  assert.equal(inside(200, 210), false);
  assert.equal(rangeChecker([])(0, 100), false);
});

test("打字沒有碰到表格、公式或流程圖時，區塊跟著位移，不必重建", () => {
  const doc = "第一段\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n最後一段";
  const table: [number, number] = [doc.indexOf("|"), doc.indexOf("2 |") + 3];
  const value = { set: Decoration.none, blocks: [table] };
  const state = EditorState.create({ doc });
  // 在第一段打字：表格往後移兩個字。
  const typed = mapBlocks(value, state.update({ changes: { from: 1, insert: "甲乙" } }));
  assert.deepEqual(typed?.blocks, [[table[0] + 2, table[1] + 2]]);
  // 在表格裡打字、在表格下一行打字、打出 `|` 或 `` ` ``：要重建。
  assert.equal(mapBlocks(value, state.update({ changes: { from: table[0] + 2, insert: "x" } })), null);
  assert.equal(mapBlocks(value, state.update({ changes: { from: table[1] + 1, insert: "x" } })), null);
  assert.equal(mapBlocks(value, state.update({ changes: { from: 1, insert: "|" } })), null);
  assert.equal(mapBlocks(value, state.update({ changes: { from: doc.length, insert: "\n```mermaid" } })), null);
  // 刪掉含有 `$` 的文字也要重建。
  const math = EditorState.create({ doc: "a $x$ b\n\nc" });
  assert.equal(mapBlocks({ set: Decoration.none, blocks: [] }, math.update({ changes: { from: 2, to: 5 } })), null);
});
