/**
 * 整頁不會出現捲軸：畫面固定在視窗大小、各區自己捲動。Windows 縮放 175% 時視窗不是整數像素，
 * WebView2 可能差不到 1px 就出現整頁的捲軸；這裡故意讓整頁比視窗多 1px，確認不會出現捲軸、用滑輪也捲不動。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

test("整頁比視窗大一點點時，不會出現捲軸、用滑輪也捲不動", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  await page.setViewportSize({ width: 1463, height: 878 });
  await page.evaluate(() => {
    document.body.style.height = "calc(100dvh + 1px)";
    document.body.style.width = "calc(100vw + 1px)";
  });
  const style = await page.evaluate(() => [getComputedStyle(document.documentElement).overflow, getComputedStyle(document.body).overflow]);
  assert.deepEqual(style, ["hidden", "clip"]);
  // 滑輪停在狀態列上（狀態列本身不會捲，捲的話就是整頁在捲）。
  const bar = await page.locator(".statusbar").boundingBox();
  await page.mouse.move(bar.x + 4, bar.y + bar.height / 2);
  await page.mouse.wheel(40, 40);
  await page.waitForTimeout(200);
  const root = await page.evaluate(() => {
    const r = document.scrollingElement;
    return { scrolled: [r.scrollLeft, r.scrollTop], scrollbar: [innerWidth - r.clientWidth, innerHeight - r.clientHeight] };
  });
  assert.deepEqual(root, { scrolled: [0, 0], scrollbar: [0, 0] });
  assert.deepEqual(errors, []);
  await context.close();
});
