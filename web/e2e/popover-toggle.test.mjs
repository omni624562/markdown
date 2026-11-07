/**
 * 按一下打開的浮動視窗，再按一次同一個按鈕要關上（不用另外點別的地方）：
 * 工作項目的篩選下拉選單、狀態列的文件統計。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, setText } from "./helpers.mjs";

test("工作項目的篩選：再按一次同一個下拉選單就關上", async () => {
  const { page, context, errors } = await open({
    desktop: { ado_account: { url: "https://ado.test/tfs/DefaultCollection", name: "王小明" }, ado_work_items: [[]] },
  });
  await page.locator("#side-tab-workitems").click();
  const button = page.locator("#workitems-host .multi-select", { hasText: "指派給我" });
  await button.click();
  const pop = page.locator(".multi-select-pop:popover-open");
  await pop.waitFor();
  assert.equal(await button.getAttribute("aria-expanded"), "true");
  await button.click();
  await page.waitForFunction(() => !document.querySelector(".multi-select-pop:popover-open"));
  assert.equal(await button.getAttribute("aria-expanded"), "false");
  // 第三次又打開。
  await button.click();
  await pop.waitFor();
  // 鍵盤也一樣：Enter 關上。
  await button.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector(".multi-select-pop:popover-open"));
  assert.deepEqual(errors, []);
  await context.close();
});

test("狀態列的文件統計：再按一次字數就關上", async () => {
  const { page, context, errors } = await open();
  await setText(page, "# 週報\n\n本週完成登入頁。\n");
  const stats = page.locator("#status-stats");
  await stats.click();
  const pop = page.locator(".stats-pop:popover-open");
  await pop.waitFor();
  assert.equal(await stats.getAttribute("aria-expanded"), "true");
  await stats.click();
  await page.waitForFunction(() => document.querySelector("#status-stats")?.getAttribute("aria-expanded") === "false");
  assert.equal(await page.locator("[popover]:popover-open").count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
