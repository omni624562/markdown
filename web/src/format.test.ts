import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorSelection, EditorState, type StateCommand } from "@codemirror/state";
import { insertBlock, insertLink, toggleLineStyle, toggleWrap } from "./format.ts";

/** 在 `doc` 上執行指令；`doc` 中的 `|` 代表游標，`«` `»` 代表選取範圍。 */
function run(cmd: StateCommand, doc: string): string {
  let state: EditorState;
  const a = doc.indexOf("«");
  if (a >= 0) {
    const b = doc.indexOf("»") - 1;
    state = EditorState.create({
      doc: doc.replace("«", "").replace("»", ""),
      selection: EditorSelection.range(a, b),
      extensions: EditorState.allowMultipleSelections.of(true),
    });
  } else {
    const c = doc.indexOf("|");
    state = EditorState.create({ doc: doc.replace("|", ""), selection: EditorSelection.cursor(c) });
  }
  cmd({ state, dispatch: (tr) => (state = tr.state) });
  const { from, to } = state.selection.main;
  const text = state.doc.toString();
  return from === to ? text.slice(0, from) + "|" + text.slice(from) : `${text.slice(0, from)}«${text.slice(from, to)}»${text.slice(to)}`;
}

test("toggleWrap 加上與移除粗體", () => {
  assert.equal(run(toggleWrap("**"), "這是«重點»文字"), "這是**«重點»**文字");
  assert.equal(run(toggleWrap("**"), "這是**«重點»**文字"), "這是«重點»文字");
  assert.equal(run(toggleWrap("`"), "a|b"), "a`|`b");
});

test("toggleLineStyle 套用、切換與取代區塊標記", () => {
  assert.equal(run(toggleLineStyle("h2"), "標|題"), "## 標|題");
  assert.equal(run(toggleLineStyle("h2"), "## 標|題"), "標|題");
  assert.equal(run(toggleLineStyle("h1"), "- 項|目"), "# 項|目");
  assert.equal(run(toggleLineStyle("ordered"), "«a\nb\nc»"), "1. «a\n2. b\n3. c»");
  assert.equal(run(toggleLineStyle("task"), "- [x] 完|成"), "完|成");
  assert.equal(run(toggleLineStyle("bullet"), "1. 第|一"), "- 第|一");
});

test("insertBlock 前後補空行並選取預留文字", () => {
  assert.equal(run(insertBlock("---"), "段落|"), "段落\n\n---|\n");
  assert.equal(run(insertBlock("```\n程式碼\n```", "程式碼"), "|"), "```\n«程式碼»\n```\n");
});

test("insertLink 依選取內容決定要選取標籤或網址", () => {
  assert.equal(run(insertLink, "看«這裡»"), "看[這裡](«https://»)");
  assert.equal(run(insertLink, "«https://a.tw»"), "[«連結文字»](https://a.tw)");
});
