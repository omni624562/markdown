import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "@codemirror/state";
import { paragraphLines } from "./writing-modes.ts";

const doc = Text.of(["# 標題", "", "第一段第一行", "第一段第二行", "", "", "第二段"]);

test("段落以空白行為界", () => {
  assert.deepEqual(paragraphLines(doc, 3, 3), { first: 3, last: 4 });
  assert.deepEqual(paragraphLines(doc, 4, 4), { first: 3, last: 4 });
  assert.deepEqual(paragraphLines(doc, 7, 7), { first: 7, last: 7 });
  assert.deepEqual(paragraphLines(doc, 1, 1), { first: 1, last: 1 });
});

test("游標在空白行時只算那一行；選取跨段落時包含兩段", () => {
  assert.deepEqual(paragraphLines(doc, 5, 5), { first: 5, last: 5 });
  assert.deepEqual(paragraphLines(doc, 4, 7), { first: 3, last: 7 });
});
