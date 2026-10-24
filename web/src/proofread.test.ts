import assert from "node:assert/strict";
import { test } from "node:test";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { scanDocument } from "./proofread.ts";

test("只檢查一段時，位置和整份檢查的結果一致", () => {
  const para = "這段影片的視頻品質很好，`視頻` 在程式碼裡不算。\n\n";
  const text = para.repeat(50);
  const state = EditorState.create({ doc: text, extensions: [markdown()] });
  const all = scanDocument(state, new Set());
  assert.ok(all.length >= 50);
  const from = state.doc.line(21).from;
  const to = state.doc.line(41).to;
  const part = scanDocument(state, new Set(), from, to);
  const expected = all.filter((m) => m.from >= from && m.to <= to);
  assert.deepEqual(
    part.map((m) => [m.from, m.to, m.term.word]),
    expected.map((m) => [m.from, m.to, m.term.word]),
  );
  // 程式碼裡的不檢查。
  assert.ok(part.every((m) => text.slice(m.from - 1, m.from) !== "`"));
});
