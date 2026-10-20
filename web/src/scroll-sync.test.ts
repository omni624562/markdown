import assert from "node:assert/strict";
import { test } from "node:test";
import { type Block, offsetForLine, parseSourcepos } from "./scroll-sync.ts";

test("parseSourcepos 解析起訖行", () => {
  assert.deepEqual(parseSourcepos("3:1-5:10"), { start: 3, end: 5 });
  assert.equal(parseSourcepos(null), null);
  assert.equal(parseSourcepos("abc"), null);
});

const blocks: Block[] = [
  { start: 1, end: 1, top: 0, bottom: 40 }, // # 標題
  { start: 3, end: 6, top: 60, bottom: 160 }, // 四行段落
  { start: 10, end: 10, top: 200, bottom: 220 },
];

test("第一個區塊之前回傳 0", () => {
  assert.equal(offsetForLine([], 5), 0);
  assert.equal(offsetForLine([{ start: 3, end: 3, top: 50, bottom: 70 }], 1), 0);
});

test("區塊內依比例內插", () => {
  assert.equal(offsetForLine(blocks, 1), 0);
  assert.equal(offsetForLine(blocks, 3), 60);
  assert.equal(offsetForLine(blocks, 5), 110);
});

test("區塊之間的空行在兩區塊間內插", () => {
  assert.equal(offsetForLine(blocks, 2), 50);
  assert.equal(offsetForLine(blocks, 8), 180);
});

test("最後一個區塊之後停在其底部", () => {
  assert.equal(offsetForLine(blocks, 99), 220);
});
