/**
 * 即時預覽：`&emsp;`、`&nbsp;`、`&lt;` 之類的字元代碼顯示成實際的字（和預覽一樣），游標移到那一行時顯示原文。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

test("即時預覽：字元代碼顯示成實際的字；游標在那一行時顯示原文", async () => {
  const { page, context, errors } = await open();
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText("&emsp;&emsp;9.1.2 0001：回傳結果代碼。\n\n&lt;王小明&gt; &#x2003;A&nbsp;B &unknownthing;\n\n最後一行");
  await page.click('.statusbar [data-view="live"]');
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(300);
  const line = (s) => page.locator(".cm-line", { hasText: s }).first();
  assert.equal(await line("9.1.2").textContent(), "  9.1.2 0001：回傳結果代碼。");
  assert.equal(await line("王小明").textContent(), "<王小明>  A B &unknownthing;", "認不得的照原文");
  // 游標移到第一行：顯示原文，可以編輯。
  await page.keyboard.press("Control+Home");
  await page.waitForFunction(() => document.querySelector(".cm-line")?.textContent.startsWith("&emsp;&emsp;9.1.2"));
  assert.deepEqual(errors, []);
  await context.close();
});
