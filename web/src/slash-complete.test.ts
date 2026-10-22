import assert from "node:assert/strict";
import { test } from "node:test";
import { filterSlash } from "./slash-complete.ts";

const ITEMS = [
  { id: "h1", title: "標題 1", keywords: "h1 heading" },
  { id: "table", title: "表格", keywords: "table" },
  { id: "task", title: "待辦清單", keywords: "todo task checkbox" },
  { id: "bullet", title: "項目清單", keywords: "list ul" },
];

test("中文、英文都能篩選", () => {
  assert.deepEqual(filterSlash(ITEMS, "").map((i) => i.id), ["h1", "table", "task", "bullet"]);
  assert.deepEqual(filterSlash(ITEMS, "表").map((i) => i.id), ["table"]);
  assert.deepEqual(filterSlash(ITEMS, "清單").map((i) => i.id), ["task", "bullet"]);
  assert.deepEqual(filterSlash(ITEMS, "todo").map((i) => i.id), ["task"]);
  assert.deepEqual(filterSlash(ITEMS, "TAB").map((i) => i.id), ["table"]);
  assert.deepEqual(filterSlash(ITEMS, "zzz"), []);
});
