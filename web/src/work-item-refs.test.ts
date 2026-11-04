import assert from "node:assert/strict";
import { test } from "node:test";
import { findWorkItemRefs } from "./work-item-refs.ts";

const ids = (text: string) => findWorkItemRefs(text).map((r) => r.id);

test("找出「#編號」：表格、留言裡的寫法", () => {
  assert.deepEqual(ids("#1940122"), [1940122]);
  assert.deepEqual(ids("Story #1895964 / Task #1895969（New）：update"), [1895964, 1895969]);
  assert.deepEqual(ids("見 #123、#4567。"), [123, 4567]);
  const [ref] = findWorkItemRefs("Task #1895969（New）");
  assert.deepEqual(ref, { index: 5, length: 8, id: 1895969 });
});

test("不是工作項目的「#」：條列編號、網址、字元參照、接在文字後面", () => {
  assert.deepEqual(ids("第 #1 點、#12 號"), [], "兩位數以下常是條列的編號");
  assert.deepEqual(ids("https://ado.test/page#1234"), [], "網址裡的錨點");
  assert.deepEqual(ids("&#1234;"), [], "HTML 字元參照");
  assert.deepEqual(ids("abc#1234 ##1234 C:\\#1234"), []);
  assert.deepEqual(ids("#123abc #1234_5"), [], "後面接著字母、數字");
  assert.deepEqual(ids("#1234567890"), [], "超過九位數");
});
