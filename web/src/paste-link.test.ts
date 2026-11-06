import assert from "node:assert/strict";
import { test } from "node:test";
import { linkFromPaste } from "./app/paste-link.ts";

test("選取文字貼上網址：變成連結", () => {
  assert.equal(linkFromPaste("規格文件", "https://ado.test/tfs/DefaultCollection/產品/_wiki/規格"), "[規格文件](https://ado.test/tfs/DefaultCollection/產品/_wiki/規格)");
  assert.equal(linkFromPaste("寫信給王小明", " mailto:wang@example.test \n"), "[寫信給王小明](mailto:wang@example.test)");
});

test("文字裡的中括號跳脫，網址裡有括號時用 <> 包起來", () => {
  assert.equal(linkFromPaste("[草稿] 週報", "https://example.test/a"), "[\\[草稿\\] 週報](https://example.test/a)");
  assert.equal(linkFromPaste("說明", "https://example.test/wiki/A_(B)"), "[說明](<https://example.test/wiki/A_(B)>)");
});

test("不是網址、沒有選取、選了好幾行、選的本身是網址：照原樣貼上", () => {
  assert.equal(linkFromPaste("規格", "不是網址"), null);
  assert.equal(linkFromPaste("規格", "https://a.test 和 https://b.test"), null);
  assert.equal(linkFromPaste("", "https://example.test"), null);
  assert.equal(linkFromPaste("  ", "https://example.test"), null);
  assert.equal(linkFromPaste("第一行\n第二行", "https://example.test"), null);
  assert.equal(linkFromPaste("https://old.test", "https://new.test"), null);
});
