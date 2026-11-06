/**
 * 即時預覽的表格是畫出來的：搜尋列開著時，儲存格裡符合的文字也要和其他地方一樣標色，
 * 換搜尋文字時跟著換，關掉搜尋列就拿掉。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const MD = "# 工作分配\n\n| 項目 | 負責人 |\n| --- | --- |\n| 登入頁 | 王小明 |\n| 報表 | 李大同 |\n\n王小明下週休假。\n";

test("搜尋時，即時預覽的表格裡符合的文字也標色", async () => {
  const { page, context, errors } = await open();
  await page.click(".cm-content");
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(MD);
  // 游標移到表格外面，表格才會畫成表格。
  await page.keyboard.press("Control+End");
  const table = page.locator(".cm-content .cm-lp-table");
  await table.waitFor();
  const marks = table.locator(".cm-searchMatch");
  assert.equal(await marks.count(), 0);

  await page.keyboard.press("Control+f");
  const input = page.locator(".find-panel input.cm-textfield").first();
  await input.waitFor();
  await input.fill("王小明");
  await marks.first().waitFor();
  assert.deepEqual(await marks.allTextContents(), ["王小明"]);
  // 表格外面的文字照樣由編輯器標色。
  assert.ok((await page.locator(".cm-content > .cm-line .cm-searchMatch").count()) >= 1);

  // 換搜尋文字：表格裡的標色跟著換。
  await input.fill("大同");
  await page.waitForFunction(() => [...document.querySelectorAll(".cm-lp-table .cm-searchMatch")].map((m) => m.textContent).join() === "大同");

  // 表格還是可以點儲存格編輯，存回去的是原本的文字（標色不會跑進文件）。
  await input.fill("報表");
  await marks.first().waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelectorAll(".cm-lp-table .cm-searchMatch").length === 0);
  const doc = await page.evaluate(() => document.querySelector(".cm-content").innerText);
  assert.match(doc, /報表/);
  assert.deepEqual(errors, []);
  await context.close();
});
