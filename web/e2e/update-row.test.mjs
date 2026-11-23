/**
 * 設定 → 關於 → 更新：下載新版時，版本列寫「正在下載 x（n%）」、下面有進度條，按鈕是灰色的「下載中…」；
 * 下載完成後換成「重新啟動並更新」。用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const LATEST = { build: 900, version: "9.9.0", commit: "", date: "", notes: "", changes: "", url: "", sha256: "", signature: "", size: 31457280 };
const desktop = {
  app_version: { version: "1.0.0", build: 1, commit: null, date: "2026-11-18", updatable: true },
  update_check: { current: { version: "1.0.0", build: 1, commit: null, updatable: true }, latest: LATEST },
  // 下載要一點時間：這段時間裡設定頁要顯示進度。
  update_install: { $delay: 1500, value: null },
};

test("下載新版時，設定的版本列顯示進度、按鈕不能按；下載完成換成「重新啟動並更新」", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.keyboard.press("Control+,");
  const dialog = page.locator("dialog[open].settings");
  await dialog.waitFor();
  await dialog.locator("[role=tab]", { hasText: "關於" }).click();
  const button = dialog.locator("#setting-check-update");
  await button.click();
  await page.locator("dialog.release[open]").getByRole("button", { name: "下載並更新" }).click();
  const row = dialog.locator(".settings-row", { has: page.locator("#setting-check-update") });
  await row.locator("small", { hasText: "正在下載 9.9.0（0%）" }).waitFor();
  assert.equal(await button.textContent(), "下載中…");
  assert.equal(await button.isDisabled(), true);
  assert.equal(await row.locator(".settings-progress").isVisible(), true);
  // 原生端回報進度：設定頁跟著更新。
  await page.evaluate(() => window.__fake.emit("update-progress", { downloaded: 35, total: 100 }));
  await row.locator("small", { hasText: "正在下載 9.9.0（35%）" }).waitFor();
  assert.equal(await row.locator(".settings-progress").getAttribute("aria-valuenow"), "35");
  // 下載完成。
  await row.locator("small", { hasText: "9.9.0 已下載完成" }).waitFor();
  assert.equal(await button.textContent(), "重新啟動並更新");
  assert.equal(await button.isDisabled(), false);
  assert.equal(await row.locator(".settings-progress").isVisible(), false);
  assert.deepEqual(errors, []);
  await context.close();
});
