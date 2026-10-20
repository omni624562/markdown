import assert from "node:assert/strict";
import { test } from "node:test";
import { sizeLabel, timeAgo } from "./history-label.ts";

test("timeAgo 用台灣的說法", () => {
  const now = Date.UTC(2026, 9, 20, 12, 0, 0);
  assert.equal(timeAgo(now - 10_000, now), "剛剛");
  assert.equal(timeAgo(now - 3 * 60_000, now), "3 分鐘前");
  assert.equal(timeAgo(now - 2 * 3600_000, now), "2 小時前");
  assert.equal(timeAgo(now - 24 * 3600_000, now), "昨天");
});

test("sizeLabel", () => {
  assert.equal(sizeLabel(500), "500 位元組");
  assert.equal(sizeLabel(2048), "2.0 KB");
});
