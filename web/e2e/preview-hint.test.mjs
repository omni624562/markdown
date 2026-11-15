/**
 * 「預覽」模式打字時提示「預覽不能編輯」，按通知上的按鈕切換到可以編輯的模式（app/preview-hint.ts）。
 * 快速鍵、捲動的按鍵、在輸入框裡打字都不提示。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, setText } from "./helpers.mjs";

const hint = (page) => page.locator(".toast", { hasText: "預覽不能編輯" });

test("在預覽裡打字：提示不能編輯，按按鈕切到即時預覽、焦點在編輯區；快速鍵、空白鍵、輸入框裡打字不提示", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  await setText(page, "# 筆記\n\n第一段。\n");
  await page.click('.statusbar [data-view="preview"]');
  await page.locator("#preview h1").waitFor();
  // 不算打字的按鍵。
  await page.click("#preview p");
  for (const k of ["Space", "ArrowDown", "PageDown", "Control+C", "Escape"]) await page.keyboard.press(k);
  // 尋找列（輸入框）裡打字不提示。
  await page.keyboard.press("Control+F");
  await page.locator(".preview-find input").fill("第一");
  await page.keyboard.type("段");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  assert.equal(await hint(page).count(), 0);
  // 在預覽裡打字。
  await page.click("#preview p");
  await page.keyboard.press("a");
  await hint(page).waitFor();
  await page.keyboard.press("b");
  assert.equal(await hint(page).count(), 1, "連打好幾個字只有一則");
  await hint(page).locator("button", { hasText: "切換到即時預覽" }).click();
  await page.waitForFunction(() => document.querySelector('.statusbar [data-view="live"]').getAttribute("aria-checked") === "true");
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest(".cm-content")), true, "焦點在編輯區，可以直接打字");
  // 其他模式打字不提示。
  await page.keyboard.type("字");
  await page.waitForTimeout(150);
  assert.equal(await hint(page).count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
