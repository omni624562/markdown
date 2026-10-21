import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBytes, planCompression, renameForType } from "./image-compress.ts";

test("什麼時候要縮小或重新壓縮", () => {
  const MB = 1024 * 1024;
  assert.deepEqual(planCompression({ type: "image/png", size: 300_000, width: 1200, height: 800 }), { scale: 1, reencode: false });
  assert.deepEqual(planCompression({ type: "image/png", size: 300_000, width: 4000, height: 1000 }), { scale: 0.5, reencode: true });
  assert.deepEqual(planCompression({ type: "image/jpeg", size: 3 * MB, width: 1800, height: 1200 }), { scale: 1, reencode: true });
  assert.equal(planCompression({ type: "image/gif", size: 9 * MB, width: 4000, height: 4000 }).reencode, false, "GIF 可能是動畫");
  assert.equal(planCompression({ type: "image/svg+xml", size: 9 * MB, width: 4000, height: 4000 }).reencode, false);
});

test("換副檔名與顯示大小", () => {
  assert.equal(renameForType("截圖 2026.png", "image/jpeg"), "截圖 2026.jpg");
  assert.equal(renameForType("image", "image/png"), "image.png");
  assert.equal(formatBytes(3.2 * 1024 * 1024), "3.2 MB");
  assert.equal(formatBytes(480 * 1024), "480 KB");
});
