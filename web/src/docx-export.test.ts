import assert from "node:assert/strict";
import { test } from "node:test";
import { fitImage, softBreaks } from "./docx-export.ts";

test("Word 匯出：中文之間的換行直接相連，其他換成空白", () => {
  assert.equal(softBreaks("第一行\n第二行"), "第一行第二行");
  assert.equal(softBreaks("first\nsecond"), "first second");
  assert.equal(softBreaks("中文\nEnglish"), "中文 English");
});

test("Word 匯出：圖片等比縮小到頁面寬度內", () => {
  assert.deepEqual(fitImage(300, 200), { width: 300, height: 200 });
  assert.deepEqual(fitImage(1200, 800), { width: 600, height: 400 });
});
