/**
 * 網頁版各項功能的端對端測試（冒煙測試以外）：並排編輯、配色、分頁、待辦。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, runCommand, setText } from "./helpers.mjs";

test("並排編輯：把目前的文件移到右邊，再關掉", async () => {
  const { page, context, errors } = await open();
  await setText(page, "# 左邊的文件");
  await runCommand(page, "新增文件");
  await setText(page, "# 右邊的文件");
  await runCommand(page, "把目前的文件移到右邊");
  await page.waitForSelector("#side-pane-head:not([hidden])");
  assert.equal(await page.locator(".cm-editor").count(), 2);
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".cm-content")].some((c) => c.textContent?.includes("左邊的文件")),
  );
  // 兩邊各自編輯，內容不會混在一起。
  const contents = await page.$$eval(".cm-content", (els) => els.map((e) => e.textContent ?? ""));
  assert.ok(contents.some((c) => c.includes("左邊的文件") && !c.includes("右邊的文件")), contents.join(" | "));
  assert.ok(contents.some((c) => c.includes("右邊的文件") && !c.includes("左邊的文件")), contents.join(" | "));
  // 用滑鼠拖中間的分隔線調整兩邊的寬度（預覽藏起來時，原本一拖左邊就被壓到最窄）。
  const box = async (sel) => page.locator(sel).boundingBox();
  const left = (await box(".editor-pane")).x;
  const right = await box("#side-pane");
  const total = right.x + right.width - left;
  const share = async () => (await box(".editor-pane")).width / ((await box("#side-pane")).x + (await box("#side-pane")).width - left);
  for (const target of [0.7, 0.35]) {
    const splitter = await box("#splitter");
    await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + splitter.height / 2);
    await page.mouse.down();
    await page.mouse.move(left + total * target, splitter.y + splitter.height / 2, { steps: 5 });
    await page.mouse.up();
    const now = await share();
    assert.ok(Math.abs(now - target) < 0.03, `拖到 ${target}：左邊佔 ${now.toFixed(3)}`);
  }
  await runCommand(page, "關閉右邊的文件");
  await page.waitForSelector("#side-pane-head", { state: "hidden" });
  assert.deepEqual(errors, []);
  await context.close();
});

test("配色：在設定換風格馬上套用，重新整理後還在", async () => {
  const { page, context, errors } = await open();
  assert.equal(await page.getAttribute("html", "data-palette"), "forest");
  await runCommand(page, "設定");
  await page.click("dialog[open] [role=tab]:has-text('外觀')");
  await page.click("#setting-palette .palette-card[data-id='matcha']");
  assert.equal(await page.getAttribute("html", "data-palette"), "matcha");
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.keyboard.press("Escape");
  await page.reload();
  await page.waitForSelector(".cm-editor .cm-content");
  assert.equal(await page.getAttribute("html", "data-palette"), "matcha");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), bg);
  assert.deepEqual(errors, []);
  await context.close();
});

test("分頁：新增、切換、關閉，內容各自保留", async () => {
  const { page, context, errors } = await open();
  await setText(page, "第一份");
  await runCommand(page, "新增文件");
  await setText(page, "第二份");
  const tabs = page.locator(".tab");
  assert.equal(await tabs.count(), 2);
  await tabs.first().click();
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent === "第一份");
  await tabs.nth(1).click();
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent === "第二份");
  // 第二份從沒存過、內容不是空的：關閉前會詢問。
  await runCommand(page, "關閉分頁");
  const dialog = page.locator("dialog[open]");
  if (await dialog.count()) await dialog.locator("button", { hasText: /不存檔|關閉/ }).first().click();
  await page.waitForFunction(() => document.querySelectorAll(".tab").length === 1);
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent === "第一份");
  assert.deepEqual(errors, []);
  await context.close();
});

test("待辦：在即時預覽勾選待辦會改回原文", async () => {
  const { page, context, errors } = await open();
  await setText(page, "- [ ] 買牛奶\n- [ ] 寫週報\n\n結尾");
  await page.click('button[data-view="live"]');
  // 游標移到最後一行，待辦那兩行才會顯示成核取方塊。
  await page.keyboard.press("Control+End");
  await page.waitForSelector(".cm-content .cm-lp-checkbox");
  await page.locator(".cm-content .cm-lp-checkbox").nth(1).click();
  // 即時預覽把待辦畫成核取方塊，換到原始碼檢視看原文。
  await page.click('button[data-view="editor"]');
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("[x] 寫週報"));
  assert.match(await page.textContent(".cm-content"), /\[ \] 買牛奶/);
  assert.deepEqual(errors, []);
  await context.close();
});
