import assert from "node:assert/strict";
import { test } from "node:test";
import { sameTitle } from "./page-hero.ts";

test("頁名和內容的大標題：空白、大小寫、網址裡的 - 不影響比較", () => {
  assert.equal(sameTitle("轉真人客服", " 轉真人客服 "), true);
  assert.equal(sameTitle("Release-Notes", "release notes"), true);
  assert.equal(sameTitle("COMET  說明", "COMET 說明"), true);
  assert.equal(sameTitle("轉真人客服", "需求資訊"), false);
});
