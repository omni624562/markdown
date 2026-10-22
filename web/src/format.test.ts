import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorSelection, EditorState, type StateCommand } from "@codemirror/state";
import { clearInlineFormat, insertBlock, insertLink, toggleLineStyle, toggleWrap } from "./format.ts";

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
  // 游標在行首（空白行）時跑到新標記後面
  assert.equal(run(toggleLineStyle("task"), "|"), "- [ ] |");
  assert.equal(run(toggleLineStyle("h1"), "|標題"), "# |標題");
});

test("insertBlock 前後補空行並選取預留文字", () => {
  assert.equal(run(insertBlock("---"), "段落|"), "段落\n\n---|\n");
  assert.equal(run(insertBlock("```\n程式碼\n```", "程式碼"), "|"), "```\n«程式碼»\n```\n");
});

test("insertLink 依選取內容決定要選取標籤或網址", () => {
  assert.equal(run(insertLink, "看«這裡»"), "看[這裡](«https://»)");
  assert.equal(run(insertLink, "«https://a.tw»"), "[«連結文字»](https://a.tw)");
});

test("toggleWrap 支援不對稱的 HTML 標籤（底線、螢光、上下標）", () => {
  assert.equal(run(toggleWrap("<u>", "</u>"), "這是«重點»文字"), "這是<u>«重點»</u>文字");
  assert.equal(run(toggleWrap("<u>", "</u>"), "這是<u>«重點»</u>文字"), "這是«重點»文字");
  assert.equal(run(toggleWrap("<sup>", "</sup>"), "m«2»"), "m<sup>«2»</sup>");
});

test("清除格式", () => {
  assert.equal(run(clearInlineFormat, "«**粗** *斜* ~~刪~~ `碼` <u>底</u> <mark>亮</mark>»"), "«粗 斜 刪 碼 底 亮»");
  // 選取範圍被標記包住時，外面的標記也拿掉
  assert.equal(run(clearInlineFormat, "這是**<u>«重點»</u>**文字"), "這是«重點»文字");
  // 清單符號、乘法的星號不受影響
  assert.equal(run(clearInlineFormat, "«3 * 4 = 12»"), "«3 * 4 = 12»");
});

test("游標在已套用的格式裡：再按一次就拿掉（不用自己刪標籤）", () => {
  assert.equal(run(toggleWrap("<mark>", "</mark>"), "估算<mark>統計|數據</mark>，並"), "估算統計|數據，並");
  assert.equal(run(toggleWrap("<mark>", "</mark>"), "<mark>a</mark> <mark>b|c</mark>"), "<mark>a</mark> b|c");
  assert.equal(run(toggleWrap("**"), "這是**重|點**文字"), "這是重|點文字");
  assert.equal(run(toggleWrap("**"), "這是**«重»點**文字"), "這是«重»點文字");
  // 斜體的 * 不會配到粗體 ** 的一半
  assert.equal(run(toggleWrap("*"), "**粗|體**"), "**粗*|*體**");
  // 不在格式裡：照常插入成對標記
  assert.equal(run(toggleWrap("<mark>", "</mark>"), "<mark>a</mark> b|"), "<mark>a</mark> b<mark>|</mark>");
});

test("清除格式：沒有選取時拿掉游標外面的格式", () => {
  assert.equal(run(clearInlineFormat, "估算<mark>統計|數據</mark>，並"), "估算統計|數據，並");
  assert.equal(run(clearInlineFormat, "a **<u>重|點</u>** b"), "a 重|點 b");
  assert.equal(run(clearInlineFormat, "沒有格式|"), "沒有格式|");
});
