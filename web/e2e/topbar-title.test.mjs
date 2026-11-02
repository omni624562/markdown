/**
 * 頂端列中間只顯示目前分頁的名稱，不顯示專案名稱（側邊欄就看得到）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, setText } from "./helpers.mjs";

test("頂端列：只有目前分頁的名稱，空白文件時不顯示", async () => {
  const { page, context, errors } = await open();
  await page.setViewportSize({ width: 1400, height: 800 });
  const title = page.locator(".topbar-title-inner");
  assert.equal((await title.textContent()).trim(), "");
  await setText(page, "內容");
  await page.waitForFunction(() => document.querySelector(".topbar-title-inner")?.textContent?.trim() === "未命名.md");
  assert.equal(await page.locator(".topbar-title .project-dot, .topbar-project").count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
