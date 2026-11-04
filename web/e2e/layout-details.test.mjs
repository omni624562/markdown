/**
 * 版面小地方：只剩一項的子選單攤平、窄視窗的狀態列不把項目擠出畫面、預覽的表格不從日期中間斷開、
 * 待辦總覽不重複寫截止日。用假的原生端（見 helpers.mjs）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, runCommand, setText } from "./helpers.mjs";

test("⋯ 選單：沒開資料夾時「Git」只剩一項，直接放在第一層；項目多的子選單照舊", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  await page.click("#main-menu");
  const root = page.locator("#main-menu-popover");
  await root.locator(":scope > button").first().waitFor();
  const top = await root
    .locator(":scope > button")
    .evaluateAll((els) => els.map((b) => [b.querySelector("span")?.textContent, b.classList.contains("has-submenu")]));
  assert.ok(top.some(([name, sub]) => name === "顯示原始碼控制（Git）" && !sub), JSON.stringify(top));
  assert.ok(!top.some(([name]) => name === "Git"), JSON.stringify(top));
  assert.ok(top.some(([name, sub]) => name === "外觀" && sub), JSON.stringify(top));
  assert.deepEqual(errors, []);
  await context.close();
});

/** 狀態列上看得到的項目：左右邊界，以及有沒有超出視窗。 */
const statusItems = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".statusbar > *")]
      .filter((el) => el.getClientRects().length)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.id || el.className, left: r.left, right: r.right };
      }),
  );

test("窄視窗的狀態列：項目不會被擠出視窗左邊；存檔狀態只留圖示，完整的文字在 aria-label", async () => {
  const { page, context, errors } = await open({
    desktop: { ado_account: { url: "https://ado.test/c", name: "王小明" }, load_settings: JSON.stringify({ aiEnabled: true }) },
  });
  await page.focus(".cm-content");
  await page.keyboard.type("草稿");
  await page.locator("#status-save:not([hidden])").waitFor();
  // 最長的情況：還在下載更新。
  await page.evaluate(() => {
    const u = document.querySelector("#status-update");
    u.hidden = false;
    u.textContent = "正在下載 1.200.0　45%";
  });
  for (const width of [1024, 720, 600, 480]) {
    await page.setViewportSize({ width, height: 700 });
    const items = await statusItems(page);
    assert.ok(items.length >= 5, JSON.stringify(items));
    for (const it of items) assert.ok(it.left >= 0 && it.right <= width, `${width}px：${JSON.stringify(it)}`);
    // 字數一直完整顯示（不縮）。
    const stats = await page.locator("#status-stats").evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    assert.ok(stats, `${width}px：字數被截掉`);
  }
  const save = page.locator("#status-save");
  assert.equal(await save.locator(".save-state-label").isVisible(), false);
  assert.equal(await save.locator("svg").isVisible(), true);
  assert.match(await save.getAttribute("aria-label"), /^尚未存成檔案/);
  await page.setViewportSize({ width: 1280, height: 800 });
  assert.equal(await save.locator(".save-state-label").isVisible(), true);
  assert.equal(await save.locator("svg").isVisible(), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test("手機寬度的狀態列：項目都在畫面裡", async () => {
  const { page, context, errors } = await open();
  await setText(page, "草稿");
  // 最長的存檔狀態：「尚未存成檔案 · 草稿已自動保存」。
  await page.waitForFunction(() => document.querySelector("#status-save")?.textContent?.includes("草稿已自動保存"));
  await page.setViewportSize({ width: 375, height: 700 });
  for (const it of await statusItems(page)) assert.ok(it.left >= 0 && it.right <= 375, JSON.stringify(it));
  assert.deepEqual(errors, []);
  await context.close();
});

test("預覽的表格：短的儲存格與日期不從中間斷開，放不下就左右捲動；即時預覽的表格照舊", async () => {
  const { page, context, errors } = await open();
  await page.setViewportSize({ width: 1024, height: 700 });
  await setText(
    page,
    [
      "| 項目 | 負責人 | 開始日期 | 截止日期 | 狀態 | 進度 |",
      "| --- | --- | --- | --- | --- | --- |",
      "| 客戶回饋報告 | 王小明 | 2026-10-01 | 2026-11-15 | 進行中 | 45% |",
      "| 整理第三季的客戶回饋，2026-11-15 前交給主管 | 陳大文 | 2026-11-02 | 2026-12-20 | 未開始 | 0% |",
      "",
      "結尾",
    ].join("\n"),
  );
  await page.click('button[data-view="split"]');
  await page.waitForSelector("#preview table td");
  const look = await page.evaluate(() => {
    const table = document.querySelector("#preview table");
    /** 一段文字排成幾行。 */
    const lines = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
    };
    const cells = [...table.querySelectorAll("td, th")];
    const dates = cells.filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.textContent));
    const inLong = table.querySelector("td .nobr");
    return {
      scrolls: table.scrollWidth > table.clientWidth,
      overflow: getComputedStyle(table).overflowX,
      dateLines: dates.map(lines),
      shortLines: cells.filter((c) => c.classList.contains("cell-nowrap")).map(lines),
      inLong: inLong ? [inLong.textContent, lines(inLong)] : null,
    };
  });
  assert.equal(look.scrolls, true);
  assert.equal(look.overflow, "auto");
  assert.deepEqual(look.dateLines, [1, 1, 1, 1]);
  assert.ok(look.shortLines.length >= 10 && look.shortLines.every((n) => n === 1), JSON.stringify(look.shortLines));
  assert.deepEqual(look.inLong, ["2026-11-15", 1]);
  // 即時預覽的表格元件不受影響（沒有加上預覽專用的標記，照常顯示）。
  await page.click('button[data-view="live"]');
  await page.focus(".cm-content");
  await page.keyboard.press("Control+End");
  await page.waitForSelector(".cm-lp-table table td");
  assert.equal(await page.locator(".cm-lp-table .cell-nowrap, .cm-lp-table .nobr").count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("待辦總覽：截止日標在右邊，文字裡不再寫一次（負責人照舊、檔案內容不變）", async () => {
  const { page, context, errors } = await open();
  await setText(page, "- [ ] 交報告 @小明 2026-10-25 前\n- [ ] 寫週報");
  await runCommand(page, "顯示待辦總覽");
  const row = page.locator(".task-row", { hasText: "交報告" });
  await row.waitFor();
  assert.equal(await row.locator(".task-text").textContent(), "交報告 @小明");
  assert.equal(await row.locator(".task-owner").textContent(), "@小明");
  assert.equal(await row.locator(".task-due").getAttribute("title"), "截止日 2026-10-25");
  assert.equal(await page.locator(".task-row", { hasText: "寫週報" }).locator(".task-text").textContent(), "寫週報");
  assert.match(await page.textContent(".cm-content"), /交報告 @小明 2026-10-25 前/);
  assert.deepEqual(errors, []);
  await context.close();
});
