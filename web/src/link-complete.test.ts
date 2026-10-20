import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeLinkPath, linkDestination } from "./link-complete.ts";

test("只在連結網址中觸發", () => {
  assert.equal(linkDestination("見[週報]("), "");
  assert.equal(linkDestination("見[週報](筆記/週"), "筆記/週");
  assert.equal(linkDestination("見[週報](a.md#第"), "a.md#第");
  assert.equal(linkDestination("見[週報](a.md) 與 ("), null);
  assert.equal(linkDestination("![圖]("), null);
  assert.equal(linkDestination("一般文字"), null);
});

test("空白與括號要編碼，中文保留", () => {
  assert.equal(encodeLinkPath("筆記/會議 記錄(1).md"), "筆記/會議%20記錄%281%29.md");
});
