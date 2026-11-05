/**
 * 「預覽」檢視時按「新增文件」：換成可以打字的檢視（Markdown 是即時預覽），打的字進到新文件。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, setText } from "./helpers.mjs";

test("「預覽」檢視時按「新增文件」：換成即時預覽，可以直接打字", async () => {
  const { page, context, errors } = await open();
  await setText(page, "# 週報");
  await page.click('button[data-view="preview"]');
  await page.waitForFunction(() => document.querySelector('button[data-view="preview"]')?.getAttribute("aria-checked") === "true");
  await page.keyboard.press("Control+Alt+N");
  await page.waitForFunction(() => [...document.querySelectorAll("#tab-bar .tab-name")].some((n) => n.textContent === "未命名"));
  // 換成即時預覽：編輯器看得到、游標在裡面，打的字進到新文件。
  assert.equal(await page.locator('button[data-view="live"]').getAttribute("aria-checked"), "true");
  assert.equal(await page.locator(".cm-content").first().isVisible(), true);
  await page.keyboard.type("新的內容");
  await page.waitForFunction(() => [...document.querySelectorAll("#tab-bar .tab-name")].some((n) => n.textContent === "新的內容"));
  assert.deepEqual(errors, []);
  await context.close();
});
