/**
 * 並排顯示（左邊編輯、右邊預覽）切換文件分頁：切回來時直接換上之前畫好的預覽，不從頭重畫
 * （長文件、有流程圖時每次切換都整份重畫很慢）；切走的這段時間內容改過的話，照常更新改到的段落。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, setText } from "./helpers.mjs";

test("並排顯示切換分頁：切回來沿用之前畫好的預覽；改過的段落照常更新", async () => {
  const { page, context, errors } = await open();
  await setText(page, "# 會議紀錄\n\n出席：王小明\n");
  await page.click('button[data-view="split"]');
  await page.waitForSelector("#preview h1");
  await page.evaluate(() => (document.querySelector("#preview h1").__kept = true));
  // 開另一份文件，再切回來。
  await page.keyboard.press("Control+Alt+N");
  await setText(page, "# 週報\n\n本週完成\n");
  await page.waitForFunction(() => document.querySelector("#preview h1")?.textContent === "週報");
  await page.locator("#tab-bar .tab").first().click();
  await page.waitForFunction(() => document.querySelector("#preview h1")?.textContent === "會議紀錄");
  assert.equal(await page.evaluate(() => document.querySelector("#preview h1").__kept), true, "沿用之前畫好的預覽");
  // 照常更新：在最後打字，預覽跟著改，標題仍是同一個節點。
  await page.click("#editor .cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("、李大同");
  await page.waitForFunction(() => document.querySelector("#preview")?.textContent.includes("李大同"));
  assert.equal(await page.evaluate(() => document.querySelector("#preview h1").__kept), true);
  assert.deepEqual(errors, []);
  await context.close();
});
