/**
 * 標題列右上角的右側欄開關（◨）：剛打開程式和開關一次之後，圖示一樣（右側欄開著時是同一個「開著」的圖示）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

test("右側欄開關：剛打開和關開一次之後，圖示一樣", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  const toggle = page.locator("[data-command='toggle-outline-right']");
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute("aria-pressed"), "true", "右側欄預設開著");
  const first = await toggle.innerHTML();
  await toggle.click();
  await page.waitForFunction(() => document.querySelector("[data-command='toggle-outline-right']").getAttribute("aria-pressed") === "false");
  await toggle.click();
  await page.waitForFunction(() => document.querySelector("[data-command='toggle-outline-right']").getAttribute("aria-pressed") === "true");
  assert.equal(await toggle.innerHTML(), first);
  assert.deepEqual(errors, []);
  await context.close();
});
