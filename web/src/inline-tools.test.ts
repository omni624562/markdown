import assert from "node:assert/strict";
import { test } from "node:test";
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { emptyLineAt } from "./inline-tools.ts";

function state(doc: string): EditorState {
  const s = EditorState.create({ doc, extensions: [markdown()] });
  ensureSyntaxTree(s, s.doc.length, 5000);
  return s;
}

test("空白行才顯示插入按鈕", () => {
  const s = state("第一段\n\n   \n第二段");
  assert.equal(emptyLineAt(s, s.doc.line(1).from), false);
  assert.equal(emptyLineAt(s, s.doc.line(2).from), true);
  assert.equal(emptyLineAt(s, s.doc.line(3).to), true); // 只有空白也算
});

test("程式碼區塊裡的空白行不算", () => {
  const s = state("```js\nconst a = 1;\n\nconst b = 2;\n```\n\n文字");
  assert.equal(emptyLineAt(s, s.doc.line(3).from), false);
  assert.equal(emptyLineAt(s, s.doc.line(6).from), true);
});
