import assert from "node:assert/strict";
import { test } from "node:test";
import { appendMarks, citeList, citeMarks, citeSnippet, findCited, type Cite } from "./assistant-cites.ts";

const cite = (text: string, extra: Partial<Cite> = {}): Cite => ({ text, title: "行程.md", start: null, page: null, ...extra });

test("出處編號：同一段原文只記一次，標記照出現的順序", () => {
  const list: Cite[] = [];
  assert.equal(citeMarks(list, [cite("八點出發。")]), " [1]");
  assert.equal(citeMarks(list, [cite("搭地鐵。"), cite("八點出發。")]), " [2][1]");
  assert.equal(citeMarks(list, [cite("八點出發。"), cite("八點出發。")]), " [1]");
  // 同樣的文字在不同的地方（PDF 的頁碼不同）是不同的出處。
  assert.equal(citeMarks(list, [cite("八點出發。", { title: null, page: 3 })]), " [3]");
  assert.equal(list.length, 3);
  assert.equal(citeMarks(list, []), "");
});

test("標記接在文字後面、結尾的換行之前", () => {
  assert.equal(appendMarks("早上八點出發。\n\n", " [1]"), "早上八點出發。 [1]\n\n");
  assert.equal(appendMarks("早上八點出發。", " [1][2]"), "早上八點出發。 [1][2]");
  assert.equal(appendMarks("早上八點出發。\n", ""), "早上八點出發。\n");
});

test("出處清單：原文縮成一行、太長截斷，方括號拿掉", () => {
  assert.equal(citeSnippet("第一天\n  早上八點出發。"), "第一天 早上八點出發。");
  assert.equal(citeSnippet("一二三四五六七八九十", 5), "一二三四五…");
  const list = [cite("早上[八點]出發。"), cite("租期一年。", { title: null, page: 3 })];
  const md = citeList(list, "出處", (c) => (c.page ? `PDF 第 ${c.page} 頁：「${c.text}」` : `「${c.text}」`));
  assert.equal(md, "**出處**\n\n- [1] 「早上八點出發。」\n- [2] PDF 第 3 頁：「租期一年。」");
  assert.equal(citeList([], "出處", () => ""), "");
});

test("在文件裡找原文：出現好幾次時挑離提示位置最近的；文件改過找不到是 null", () => {
  const doc = "# 行程\n\n集合。\n\n第一天早上八點出發。\n\n集合。\n";
  assert.deepEqual(findCited(doc, { text: "第一天早上八點出發。\n", start: 0 }), { from: 11, to: 21 });
  assert.deepEqual(findCited(doc, { text: "集合。", start: 20 }), { from: 23, to: 26 });
  assert.deepEqual(findCited(doc, { text: "集合。", start: null }), { from: 6, to: 9 });
  assert.equal(findCited(doc, { text: "第二天", start: 3 }), null);
  assert.equal(findCited(doc, { text: "  ", start: 3 }), null);
});
