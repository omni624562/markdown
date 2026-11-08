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
