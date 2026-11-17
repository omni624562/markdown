/**
 * 文件裡有流程圖時，並排預覽打字也只換改到的段落，不整頁重畫（每次重畫整頁很慢：流程圖、表格都要重來）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, setText } from "./helpers.mjs";

const DOC = ["# 會議紀錄", "", "第一段。", "", "```mermaid", "graph TD", "  A[王小明]-->B[李大同]", "```", "", "最後一段"].join("\n");

test("有流程圖的文件：並排預覽打字時，沒改到的段落與流程圖不重畫", async () => {
  const { page, context, errors } = await open();
  await setText(page, DOC);
  await page.click('button[data-view="split"]');
  await page.waitForSelector("#preview figure.mermaid-diagram > svg", { timeout: 30000 });
  // 在畫好的標題與流程圖上做記號：整頁重畫的話記號就不見了。
  await page.evaluate(() => {
    document.querySelector("#preview h1").__kept = true;
    document.querySelector("#preview figure.mermaid-diagram").__kept = true;
  });
  // 在最後一段打字。
  await page.keyboard.press("Control+End");
  for (const ch of "，補充") {
    await page.keyboard.type(ch);
    await page.waitForTimeout(150);
  }
  await page.waitForFunction(() => document.querySelector("#preview")?.textContent.includes("補充"));
  assert.equal(await page.evaluate(() => document.querySelector("#preview h1").__kept), true, "標題沒有重畫");
  assert.equal(await page.evaluate(() => document.querySelector("#preview figure.mermaid-diagram").__kept), true, "流程圖沒有重畫");
  assert.equal(await page.locator("#preview figure.mermaid-diagram > svg").count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
});
