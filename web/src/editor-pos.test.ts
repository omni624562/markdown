import assert from "node:assert/strict";
import { test } from "node:test";
import { posAt } from "./editor-pos.ts";

const view = (posAtCoords: () => number | null) => ({
  posAtCoords,
  documentTop: 100,
  // 每行 20px：第 n 行從 n * 10 開始。
  lineBlockAtHeight: (h: number) => ({ from: Math.floor(h / 20) * 10 }),
});

test("posAt：照常回傳位置；CodeMirror 內部出錯時改用滑鼠所在那一行的開頭，不往外丟", () => {
  assert.equal(posAt(view(() => 42), 10, 150), 42);
  assert.equal(posAt(view(() => null), 10, 150), null, "在文件外面照樣是 null");
  const broken = view(() => {
    throw new TypeError("Cannot read properties of null (reading 'length')");
  });
  // y = 165：離文件頂端 65px，第 3 行（從 30 開始）。
  assert.equal(posAt(broken, 10, 165), 30);
});

test("describe：只記結構（行號、長度、語法節點名稱），不含文字內容", async () => {
  const { EditorState } = await import("@codemirror/state");
  const { markdown } = await import("@codemirror/lang-markdown");
  const { describe } = await import("./editor-pos.ts");
  const state = EditorState.create({ doc: "# 機密標題\n\n王小明的**薪資**是秘密\n", extensions: [markdown()] });
  const fake = {
    state,
    viewport: { from: 0, to: state.doc.length },
    visibleRanges: [{ from: 0, to: state.doc.length }],
    documentTop: 0,
    posAtCoords: () => null,
    lineBlockAtHeight: () => ({ from: state.doc.line(3).from, to: state.doc.line(3).to, height: 20, type: 0 }),
  };
  const text = describe(fake, 10, 50);
  assert.match(text, /^line 3\/4 length 13 /);
  assert.match(text, /nodes .*Paragraph.*StrongEmphasis/);
  assert.ok(!/王小明|薪資|機密/.test(text), text);
});
