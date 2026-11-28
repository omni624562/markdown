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
  // 只有錨點的那一行：畫面上沒有東西，游標不在時整行藏起來（只留一點空隙）。
  const anchor = page.locator(".cm-line.cm-lp-anchor");
  assert.equal(await anchor.count(), 1);
  assert.equal((await anchor.textContent()).trim(), "", "看不到 <a id>");
  assert.ok((await anchor.boundingBox()).height < 10, "只留一點空隙");
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

test("段落裡的 <img>：預覽、即時預覽都畫出圖片（危險的屬性拿掉），游標移過去顯示原始碼", async () => {
  const opened = await open();
  const { page, context, errors } = opened;
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText('## 2.7. 資料流程圖\n\n<img src="data:image/png;base64,iVBORw0KGgo=" style="width:6.88194in;height:3.5in" onerror="window.__pwned=1" />\n> 各 API 的說明\n\n文字 <img src="https://ado.test/a.png" alt="圖"> 文字\n\n最後一行');
  await page.click('.statusbar [data-view="live"]');
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".cm-content img:not(.cm-widgetBuffer)").count(), 2, "兩張圖片都畫出來");
  assert.equal(await page.locator(".cm-content [onerror]").count(), 0);
  assert.equal(await page.locator(".cm-line", { hasText: "<img" }).count(), 0, "看不到 <img 原始碼");
  // 點段落裡的圖片：游標移過去，顯示原始碼。
  await page.locator(".cm-lp-html-inline").last().dispatchEvent("mousedown", { button: 0 });
  await page.locator(".cm-line", { hasText: '<img src="https://ado.test/a.png"' }).waitFor();
  await page.click('.statusbar [data-view="preview"]');
  await page.locator("#preview img").first().waitFor({ state: "attached" });
  assert.equal(await page.locator("#preview img").count(), 2);
  assert.equal(await page.locator("#preview [onerror]").count(), 0);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.deepEqual(errors, []);
  await context.close();
});

test("段落裡的 <span style>、<font color>：預覽、即時預覽都套用顏色（危險的樣式拿掉），游標移進去顯示原始碼", async () => {
  const { page, context, errors } = await open();
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText('請注意 <span style="color: red; position: fixed">紅字</span> 與 <font color="#c00">重點</font>。\n\n最後一行');
  await page.click('.statusbar [data-view="live"]');
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(300);
  const first = page.locator(".cm-line").first();
  assert.equal(await first.textContent(), "請注意 紅字 與 重點。", "看不到標籤");
  const styles = await first.locator("[style]").evaluateAll((els) => els.map((e) => [e.textContent, getComputedStyle(e).color, getComputedStyle(e).position]));
  assert.deepEqual(styles, [
    ["紅字", "rgb(255, 0, 0)", "static"],
    ["重點", "rgb(204, 0, 0)", "static"],
  ]);
  // 游標移進那一組標籤裡才顯示原始碼（和 <mark> 一樣），同一行其他地方照樣顯示排版。
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector(".cm-line")?.textContent.includes("<span style="));
  await page.click('.statusbar [data-view="preview"]');
  const span = page.locator("#preview span[style]");
  await span.waitFor();
  assert.equal(await span.getAttribute("style"), "color: red");
  assert.equal(await page.locator('#preview font[color="#c00"]').textContent(), "重點");
  assert.deepEqual(errors, []);
  await context.close();
});
