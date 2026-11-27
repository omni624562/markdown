/**
 * 文件裡直接寫的 HTML 區塊（例如從 Word、Confluence 轉出來的修訂紀錄表格）：預覽、即時預覽都畫出來，
 * 只留安全的標籤與屬性（crates/md-core/src/raw_html.rs）；即時預覽點一下顯示原始碼。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const DOC = [
  "專案名稱：contoso-svc", "", "# 修訂紀錄", "",
  "<table>", "<colgroup>", '<col style="width: 15%" />', '<col style="width: 85%" />', "</colgroup>",
  "<thead>", "<tr>", '<th style="text-align: center;"><strong>修訂時間</strong></th>', '<th style="text-align: center;"><strong>修訂紀錄</strong></th>', "</tr>", "</thead>",
  "",
  "<tbody>", "<tr>", '<td style="text-align: center;">2026/07/21</td>',
  '<td><ul><li><p>初版</p></li></ul><ol type="1"><li><p>王小明建立</p></li></ol><img src=x onerror="window.__pwned=1"></td>',
  "</tr>", "</tbody>", "</table>", "",
  '<a id="資源配置"></a>', "", "## 1.4. 資源配置", "", "最後一段。", "",
].join("\n");

async function setup(view) {
  const opened = await open();
  const { page } = opened;
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText(DOC);
  await page.click(`.statusbar [data-view="${view}"]`);
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(300);
  return opened;
}

test("即時預覽：HTML 表格畫成表格（空行拆開的也合成一張），危險的屬性拿掉；點一下顯示原始碼", async () => {
  const { page, context, errors } = await setup("live");
  const box = page.locator(".cm-lp-html");
  await box.waitFor();
  assert.equal(await box.count(), 1, "空行拆開的兩段合成一張表");
  assert.deepEqual(await box.locator("th").allTextContents(), ["修訂時間", "修訂紀錄"]);
  assert.equal(await box.locator("td").first().textContent(), "2026/07/21");
  assert.equal(await box.locator("th").first().getAttribute("style"), "text-align: center");
  assert.equal(await box.locator("ol").getAttribute("type"), "1");
  assert.equal(await box.locator("[onerror]").count(), 0, "事件屬性拿掉");
  assert.equal(await page.evaluate(() => window.__pwned), undefined, "沒有執行");
  // 只有錨點的那一行：畫面上沒有東西，淡化顯示原始碼。
  assert.equal(await page.locator(".cm-line.cm-lp-comment", { hasText: '<a id="資源配置"></a>' }).count(), 1);
  // 點表格：游標移進去，顯示原始碼。
  await box.locator("td").first().click();
  await page.locator(".cm-line", { hasText: "<colgroup>" }).waitFor();
  assert.equal(await page.locator(".cm-lp-html").count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("預覽：HTML 表格照樣畫出來，危險的內容拿掉", async () => {
  const { page, context, errors } = await setup("preview");
  const table = page.locator("#preview .md-html table");
  await table.waitFor();
  assert.deepEqual(await table.locator("th").allTextContents(), ["修訂時間", "修訂紀錄"]);
  assert.equal(await page.locator("#preview [onerror]").count(), 0);
  assert.equal(await page.locator('#preview a[id="資源配置"]').count(), 1, "錨點留著，目錄的連結跳得到");
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.deepEqual(errors, []);
  await context.close();
});
