import assert from "node:assert/strict";
import { test } from "node:test";
import { menuTitle } from "./menu.ts";

test("子選單省略和選單同名的前綴", () => {
  assert.equal(menuTitle("Git：提交…", "Git"), "提交…");
  assert.equal(menuTitle("Help: Release Notes", "Help"), "Release Notes");
  assert.equal(menuTitle("說明：快速鍵一覽", "說明"), "快速鍵一覽");
  // 不同名、或在最上層時保留原名。
  assert.equal(menuTitle("關於 oMarker", "說明"), "關於 oMarker");
  assert.equal(menuTitle("Git：提交…"), "Git：提交…");
  assert.equal(menuTitle("Git：", "Git"), "Git：");
});
