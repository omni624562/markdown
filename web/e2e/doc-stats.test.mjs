/**
 * 文件統計：狀態列的字數、統計面板、字數目標（進度、達成提示、重新整理後還記得）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, runCommand, setText } from "./helpers.mjs";

const statusText = (page) => page.textContent("#status-stats");
/**
 * 統計面板的「項目：值」。在同一次 evaluate 裡找元素、讀內容：`$$eval` 是先找元素、再另外執行一次讀取，
 * 中間面板如果剛好重畫（字數停手後才重算），找到的舊元素已經拿掉，讀不到後面的值。
 */
const rows = (page) =>
  page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll(".stats-pop .stats-grid dt")].map((dt) => [dt.textContent, dt.nextElementSibling.textContent])),
  );

test("狀態列的字數可以打開文件統計：中英文字數、閱讀與朗讀時間、今天新增", async () => {
  const { page, context, errors } = await open();
  await setText(page, "# 週報\n\n本週完成 Markdown editor 的測試。\n");
  await page.waitForFunction(() => document.querySelector("#status-stats").textContent === "11 字");
  await page.click("#status-stats");
  await page.waitForSelector(".stats-pop:popover-open");
  const r = await rows(page);
  // 週報(2) + 本週完成(4) + 的測試(3) = 9 個中文字；Markdown、editor 兩個英文字。
  assert.match(r["字數"], /^11/);
  assert.match(r["字數"], /中文 9、英文 2/);
  assert.equal(r["標題數"], "1");
  assert.match(r["閱讀時間"], /約 1 分鐘/);
  assert.match(r["朗讀時間"], /約 1 分鐘/);
  // 空白的新文件今天從 0 字開始，打的字都算今天新增的。
  assert.equal(r["今天"], "+11 字");
  assert.equal(await page.getAttribute("#status-stats", "aria-expanded"), "true");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".stats-pop:not(:popover-open)", { state: "attached" });
  // 繼續寫：今天新增的字數跟著增加。
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("下週繼續。\n");
  await page.waitForFunction(() => document.querySelector("#status-stats").textContent === "15 字");
  await page.click("#status-stats");
  assert.equal((await rows(page))["今天"], "+15 字");
  assert.deepEqual(errors, []);
  await context.close();
});

test("選取文字時，統計面板另外列出選取範圍的字數", async () => {
  const { page, context, errors } = await open();
  // 最後一行不換行：游標在文件結尾就是在這一行，選取時不必上下移動
  // （即時預覽裡游標移動時行高會變，上下移動可能落在別行）。
  await setText(page, "第一段文字。\n\n第二段 hello world。");
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Shift+Home");
  await page.waitForFunction(() => document.querySelector("#status-cursor")?.textContent.includes("已選取"));
  await page.click("#status-stats");
  await page.waitForSelector(".stats-pop:popover-open");
  // 字數是停手一下子後才算的；面板比較早打開時，算好了才會多出「選取範圍」這一列（電腦忙的時候會晚一點）。
  await page.waitForFunction(() => [...document.querySelectorAll(".stats-pop .stats-grid dt")].some((dt) => dt.textContent === "選取範圍"));
  assert.match((await rows(page))["選取範圍"], /^5 字/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("字數目標：狀態列顯示進度，達成時提示，重新整理後還記得", async () => {
  const { page, context, errors } = await open();
  await setText(page, "一二三四五六七八九十");
  await runCommand(page, "字數目標");
  await page.waitForSelector(".stats-pop:popover-open");
  assert.equal(await page.evaluate(() => document.activeElement.id), "stats-goal-input");
  // 看不懂的值不接受。
  await page.keyboard.type("很多");
  await page.keyboard.press("Enter");
  assert.match(await page.textContent(".stats-goal-note"), /請輸入/);
  await page.fill("#stats-goal-input", "20");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#status-stats").textContent === "10 / 20 字");
  assert.match(await page.textContent(".stats-goal-note"), /已完成 50%，還差 10 字/);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".stats-mini-bar")).getPropertyValue("--progress")), "0.5");
  await page.keyboard.press("Escape");
  // 寫到目標：恭喜一下，狀態列換成達成的樣子。
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("一二三四五六七八九十");
  await page.waitForSelector(".toast", { hasText: "達成字數目標" });
  assert.match(await page.textContent(".toast"), /達成字數目標：20 字/);
  assert.ok(await page.evaluate(() => document.querySelector("#status-stats").classList.contains("reached")));
  // 重新整理：同一份文件的目標還在。
  await page.waitForTimeout(800);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#status-stats")?.textContent === "20 / 20 字");
  // 清除目標。
  await page.click("#status-stats");
  await page.click(".stats-goal-row button");
  await page.waitForFunction(() => document.querySelector("#status-stats").textContent === "20 字");
  assert.deepEqual(errors, []);
  await context.close();
});

test("JSON 文件：狀態列是行數與字元，統計面板沒有字數目標", async () => {
  const { page, context, errors } = await open();
  await page.click("#doc-kind");
  await page.locator("#doc-kind-popover button", { hasText: "JSON" }).click();
  await setText(page, '{\n  "a": 1\n}\n');
  await page.waitForFunction(() => document.querySelector("#status-stats").textContent.includes("行"));
  await page.click("#status-stats");
  await page.waitForSelector(".stats-pop:popover-open");
  assert.deepEqual(Object.keys(await rows(page)), ["行數", "字元"]);
  assert.ok(await page.locator(".stats-goal").isHidden());
  assert.deepEqual(errors, []);
  await context.close();
});

test("字數目標：輸入看不懂的值的提示，不會被晚一點才更新的字數蓋掉", async () => {
  const { page, context, errors } = await open();
  await setText(page, "一二三四五六七八九十");
  await runCommand(page, "字數目標");
  await page.waitForSelector(".stats-pop:popover-open");
  await page.keyboard.type("很多");
  await page.keyboard.press("Enter");
  assert.match(await page.textContent(".stats-goal-note"), /請輸入/);
  // 打完字後字數晚一點才重新計算（CI 這種慢的機器常見）：改編輯區的內容但焦點留在字數目標，讓統計重畫。
  // EditorView 從 .cm-content 取得（CodeMirror 內部的屬性，改版時名稱可能不同）。
  const changed = await page.evaluate(() => {
    const content = document.querySelector(".cm-content");
    const tile = content?.cmView ?? content?.cmTile;
    const view = tile?.view ?? tile?.root?.view;
    if (!view) return false;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "十一" } });
    return true;
  });
  assert.ok(changed, "找不到 CodeMirror 的 EditorView");
  await page.waitForFunction(() => document.querySelector("#status-stats").textContent.startsWith("12"));
  assert.equal(await page.evaluate(() => document.activeElement.id), "stats-goal-input");
  assert.match(await page.textContent(".stats-goal-note"), /請輸入/, "字數重畫後提示還在");
  // 改了輸入框：提示收起來，回到原本的說明。
  await page.keyboard.press("Backspace");
  assert.match(await page.textContent(".stats-goal-note"), /設定這份文件要寫多少字/);
  assert.deepEqual(errors, []);
  await context.close();
});
