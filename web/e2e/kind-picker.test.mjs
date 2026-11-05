/**
 * 狀態列的文件類型：用 oMarker 自己的選單（不是原生的下拉清單），選單一律留在視窗裡，視窗多大都選得到。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, setText } from "./helpers.mjs";

test("文件類型的選單往上開、留在視窗裡，選了就換類型", async () => {
  const { page, context, errors } = await open();
  await setText(page, '{ "a": 1 }');
  assert.equal(await page.textContent("#doc-kind"), "Markdown");
  await page.click("#doc-kind");
  const menu = page.locator("#doc-kind-popover");
  await menu.waitFor();
  const box = await menu.boundingBox();
  const button = await page.locator("#doc-kind").boundingBox();
  const viewport = page.viewportSize();
  // 狀態列在最下面：選單開在按鈕上方，整個都在視窗裡。
  assert.ok(box.y + box.height <= button.y + 1, "選單在按鈕上方");
  assert.ok(box.y >= 0 && box.y + box.height <= viewport.height, "選單在視窗裡");
  // 目前的類型打勾；用方向鍵也能選。
  assert.equal(await menu.locator('[role="menuitemradio"][aria-checked="true"]').textContent(), "Markdown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal(await page.textContent("#doc-kind"), "JSON");
  await page.waitForFunction(() => document.querySelector("#status-stats")?.textContent.includes("行"));
  // 再選回 Markdown。
  await page.click("#doc-kind");
  await menu.locator("button", { hasText: "Markdown" }).click();
  assert.equal(await page.textContent("#doc-kind"), "Markdown");
  assert.deepEqual(errors, []);
  await context.close();
});

test("視窗很矮時選單也留在視窗裡", async () => {
  const { page, context, errors } = await open();
  await page.setViewportSize({ width: 900, height: 260 });
  await page.click("#doc-kind");
  // 選單打開後的下一刻（toggle 事件）才量大小、定位，定位好之前是隱藏的：等看得見了再量，
  // 不然可能量到還沒定位的位置（視窗頂端、原本的高度）。
  const menu = page.locator("#doc-kind-popover");
  await menu.waitFor({ state: "visible" });
  const box = await menu.boundingBox();
  assert.ok(box.y >= 0 && box.y + box.height <= 260, `選單在視窗裡（${Math.round(box.y)}～${Math.round(box.y + box.height)}）`);
  assert.deepEqual(errors, []);
  await context.close();
});
