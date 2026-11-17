import assert from "node:assert/strict";
import { test } from "node:test";
import { nextDelay } from "./background-schedule.ts";

test("背景檢查的間隔：照設定，前後錯開最多 10%，最短 10 分鐘", () => {
  assert.equal(nextDelay(10, 0.5), 10 * 60_000);
  assert.equal(nextDelay(10, 0), 9 * 60_000);
  assert.equal(nextDelay(10, 1), 11 * 60_000);
  assert.equal(nextDelay(60, 0.5), 60 * 60_000);
  assert.equal(nextDelay(5, 0.5), 10 * 60_000, "比 10 分鐘短的當成 10 分鐘");
});
