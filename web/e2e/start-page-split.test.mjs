/**
 * 起始頁不是文件：不分檢視一律佔滿整個區域，狀態列不顯示檢視切換、游標位置、字數與存檔狀態（文件類型留著）。
 * 選了「分割」時，開始打字後才分成左右兩半；清空回到起始頁又佔滿。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const shown = (page, selector) => page.locator(selector).first().isVisible();
const width = async (page, selector) => (await page.locator(selector).first().boundingBox())?.width ?? 0;

test("「分割」時起始頁佔滿、不顯示檢視切換；打字後分成左右兩半", async () => {
  const { page, context, errors } = await open();
  await page.evaluate(() => localStorage.setItem("md-editor:view", "split"));
  await page.reload();
  await page.locator(".empty-state .start-page").waitFor();

  // 起始頁蓋在編輯區上、佔滿整個區域；預覽藏起來。
  assert.equal(await page.locator(".editor-pane > .empty-state:not([hidden])").count(), 1, "起始頁在編輯區");
  assert.equal(await shown(page, ".preview-pane"), false, "沒有右半邊的預覽");
  const full = await width(page, ".editor-pane");
  assert.ok(full > (await width(page, ".workspace")) * 0.7, "編輯區佔滿");
  for (const selector of [".view-switch", "#status-cursor", "#status-stats", "#status-save"]) {
    assert.equal(await shown(page, selector), false, `起始頁不顯示 ${selector}`);
  }
  assert.equal(await shown(page, "#doc-kind"), true, "文件類型留著（可以先選要寫哪一種）");

  // 開始打字：起始頁收起來，照「分割」排成左右兩半，狀態列的項目回來。
  await page.locator(".cm-content").focus();
  await page.keyboard.type("# 週報");
  await page.waitForFunction(() => document.querySelector(".empty-state")?.hidden);
  await page.waitForFunction(() => document.querySelector("#preview h1")?.textContent === "週報");
  assert.equal(await shown(page, ".preview-pane"), true);
  assert.ok((await width(page, ".editor-pane")) < full * 0.7, "編輯區剩左半邊");
  assert.equal(await shown(page, ".view-switch"), true);
  assert.equal(await page.locator('.view-switch [data-view="split"]').getAttribute("aria-checked"), "true");
  assert.equal(await shown(page, "#status-stats"), true);

  // 清空：回到佔滿的起始頁。
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.locator(".editor-pane > .empty-state:not([hidden])").waitFor();
  assert.equal(await shown(page, ".preview-pane"), false);
  assert.equal(await shown(page, ".view-switch"), false);
  assert.deepEqual(errors, []);
  await context.close();
});
