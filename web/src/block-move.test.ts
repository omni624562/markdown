import assert from "node:assert/strict";
import { test } from "node:test";
import { moveBlock, moveListItem } from "./block-move.ts";

const doc = ["# 行程", "", "第一段。", "", "第二段。", "", "| A | B |", "| --- | --- |", "| 1 | 2 |", "", "最後一段。", ""].join("\n");

test("一般區塊：搬到另一個區塊前面，前後各留一個空白行", () => {
  // 第二段（第 5 行）搬到第一段（第 3 行）前面。
  assert.equal(moveBlock(doc, { first: 5, last: 5 }, 3), ["# 行程", "", "第二段。", "", "第一段。", "", "| A | B |", "| --- | --- |", "| 1 | 2 |", "", "最後一段。", ""].join("\n"));
  // 表格（7–9 行）搬到第一段前面。
  assert.equal(moveBlock(doc, { first: 7, last: 9 }, 3), ["# 行程", "", "| A | B |", "| --- | --- |", "| 1 | 2 |", "", "第一段。", "", "第二段。", "", "最後一段。", ""].join("\n"));
});

test("一般區塊：往後搬（目標在後面）、搬到文件最後", () => {
  // 第一段搬到最後一段（第 11 行）前面。
  assert.equal(moveBlock(doc, { first: 3, last: 3 }, 11), ["# 行程", "", "第二段。", "", "| A | B |", "| --- | --- |", "| 1 | 2 |", "", "第一段。", "", "最後一段。", ""].join("\n"));
  // 搬到最後（行數 + 1；再後面也一樣，編輯器把結尾的換行也算一行）。
  assert.equal(moveBlock(doc, { first: 3, last: 3 }, 13), moveBlock(doc, { first: 3, last: 3 }, 12));
  assert.equal(moveBlock(doc, { first: 3, last: 3 }, 12), ["# 行程", "", "第二段。", "", "| A | B |", "| --- | --- |", "| 1 | 2 |", "", "最後一段。", "", "第一段。", ""].join("\n"));
});

test("一般區塊：位置沒變或搬進自己裡面時回傳 null；文件結尾沒有換行時照樣處理", () => {
  assert.equal(moveBlock(doc, { first: 5, last: 5 }, 5), null);
  assert.equal(moveBlock(doc, { first: 5, last: 5 }, 6), null);
  assert.equal(moveBlock(doc, { first: 7, last: 9 }, 8), null);
  assert.equal(moveBlock("甲\n\n乙", { first: 3, last: 3 }, 1), "乙\n\n甲");
});

test("清單項目：同一個清單裡調整順序（子項目跟著走）", () => {
  const list = ["- 早上：搭地鐵", "  - 約 20 分鐘", "- 中午：吃海鮮麵", "- 晚上：逛夜市", ""].join("\n");
  // 「晚上」（第 4 行）搬到「早上」前面。
  assert.equal(moveListItem(list, { first: 4, last: 4 }, { first: 1, last: 2 }), ["- 晚上：逛夜市", "- 早上：搭地鐵", "  - 約 20 分鐘", "- 中午：吃海鮮麵", ""].join("\n"));
  // 「早上」（含子項目）搬到最後一項後面。
  assert.equal(moveListItem(list, { first: 1, last: 2 }, { first: 4, last: 4 }, true), ["- 中午：吃海鮮麵", "- 晚上：逛夜市", "- 早上：搭地鐵", "  - 約 20 分鐘", ""].join("\n"));
});

test("清單項目：搬到另一個清單時，縮排與項目符號換成目標清單的", () => {
  const two = ["第一天：", "", "- 早上：搭地鐵", "- 中午：吃麵", "", "第二天：", "", "1. 看海", "2. 搭纜車", "   1. 來回票", ""].join("\n");
  // 「中午」搬到第二天的「搭纜車」前面：變成編號項目。
  assert.equal(
    moveListItem(two, { first: 4, last: 4 }, { first: 9, last: 10 }),
    ["第一天：", "", "- 早上：搭地鐵", "", "第二天：", "", "1. 看海", "2. 中午：吃麵", "2. 搭纜車", "   1. 來回票", ""].join("\n"),
  );
  // 子項目「來回票」搬成第一天的項目：縮排拿掉、符號換成「-」。
  assert.equal(
    moveListItem(two, { first: 10, last: 10 }, { first: 3, last: 3 }),
    ["第一天：", "", "- 來回票", "- 早上：搭地鐵", "- 中午：吃麵", "", "第二天：", "", "1. 看海", "2. 搭纜車", ""].join("\n"),
  );
});

test("清單項目：不能搬進自己的子項目裡", () => {
  const list = ["- 早上", "  - 搭地鐵", "- 晚上", ""].join("\n");
  assert.equal(moveListItem(list, { first: 1, last: 2 }, { first: 2, last: 2 }), null);
  assert.equal(moveListItem(list, { first: 1, last: 2 }, { first: 3, last: 3 }), null, "搬到下一項前面就是原地");
});
