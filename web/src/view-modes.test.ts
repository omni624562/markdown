import assert from "node:assert/strict";
import { test } from "node:test";
import { VIEW_MODES, viewFor, viewsFor } from "./view-modes.ts";

test("Markdown 四種模式都能用；JSON 沒有即時預覽；純文字只有原始碼", () => {
  assert.deepEqual(viewsFor("markdown"), VIEW_MODES);
  assert.deepEqual(viewsFor("json"), ["editor", "split", "preview"]);
  assert.deepEqual(viewsFor("text"), ["editor"]);
});

test("使用者選的模式這種文件用不到時退回原始碼，換回 Markdown 照舊", () => {
  assert.equal(viewFor("live", "markdown"), "live");
  assert.equal(viewFor("live", "json"), "editor");
  assert.equal(viewFor("split", "json"), "split");
  assert.equal(viewFor("preview", "text"), "editor");
  assert.equal(viewFor("split", "text"), "editor");
});

test("沒選過或值壞掉時用分割（純文字仍是原始碼）", () => {
  assert.equal(viewFor(null, "markdown"), "split");
  assert.equal(viewFor("bogus", "markdown"), "split");
  assert.equal(viewFor(undefined, "text"), "editor");
});

test("網頁檔（.html、.htm）是純文字，但有分割和預覽（照網頁本身的樣子顯示）；其他程式碼檔還是只有原始碼", () => {
  assert.deepEqual(viewsFor("text", "報價單.html"), ["editor", "split", "preview"]);
  assert.deepEqual(viewsFor("text", "INDEX.HTM"), ["editor", "split", "preview"]);
  assert.deepEqual(viewsFor("text", "style.css"), ["editor"]);
  assert.deepEqual(viewsFor("text", "html-notes.txt"), ["editor"]);
  assert.equal(viewFor("preview", "text", "報價單.html"), "preview");
  assert.equal(viewFor("live", "text", "報價單.html"), "editor");
  assert.equal(viewFor(null, "text", "報價單.html"), "split");
});
