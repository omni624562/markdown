/**
 * 提示文字對得上實際的選單與名稱：提示裡說的指令在「⋯」選單找得到，名稱和指令面板、設定頁一致。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, runCommand } from "./helpers.mjs";

/** 打開「⋯」裡的子選單 `label`，回傳子選單裡的項目名稱；`pick` 是要按的項目。 */
async function submenu(page, label, pick) {
  await page.click("#main-menu");
  const menu = page.locator("#main-menu-popover");
  await menu.waitFor();
  await menu.locator(":scope > button", { hasText: label }).click();
  const sub = menu.locator(":scope > .submenu:popover-open");
  await sub.waitFor();
  const items = await sub.locator(":scope > button").allTextContents();
  if (pick) await sub.locator(":scope > button", { hasText: pick }).click();
  else await page.keyboard.press("Escape");
  return items;
}

test("錯誤提示說的「說明：複製錯誤紀錄」：「⋯」→「說明」裡就有", async () => {
  const { page, context, errors } = await open();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => void (window.__copied = text) } });
  });
  await page.evaluate(() => {
    void Promise.reject(new Error("測試用的錯誤"));
  });
  await page.locator(".toast", { hasText: "可以用「說明：複製錯誤紀錄」把細節貼給開發者" }).waitFor();
  // 子選單省略和子選單同名的前綴：「說明」裡是「複製錯誤紀錄」。
  const items = await submenu(page, "說明", "複製錯誤紀錄");
  assert.ok(items.includes("複製錯誤紀錄"), items.join("、"));
  await page.locator(".toast", { hasText: "已複製 1 筆錯誤紀錄" }).waitFor();
  assert.match(await page.evaluate(() => window.__copied), /測試用的錯誤/);
  assert.deepEqual(
    errors.filter((m) => !m.includes("測試用的錯誤")),
    [],
  );
  await context.close();
});

test("「把目前文件存成範本…」在「⋯」→「文件工具」；每日筆記範本的說明指的就是那裡", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  const items = await submenu(page, "文件工具");
  assert.ok(items.includes("把目前文件存成範本…"), items.join("、"));
  await page.keyboard.press("Control+,");
  const dialog = page.locator("dialog.settings[open]");
  await dialog.waitFor();
  assert.match(await dialog.textContent(), /自訂範本可以用「⋯」→「文件工具」→「把目前文件存成範本…」新增/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("整份修正後的提示：說的設定名稱和設定頁上的一樣", async () => {
  const { page, context, errors } = await open({ desktop: { load_settings: JSON.stringify({ termCheck: false }) } });
  await page.focus(".cm-content");
  await page.keyboard.type("這個質量很好");
  await runCommand(page, "修正兩國用語、錯字與標點");
  const toast = page.locator(".toast", { hasText: "依文意判斷" });
  await toast.waitFor();
  const setting = (await toast.textContent()).match(/在設定中開啟「(.+?)」/)?.[1];
  assert.equal(setting, "檢查兩國用語、錯字與標點");
  await page.keyboard.press("Control+,");
  const dialog = page.locator("dialog.settings[open]");
  await dialog.waitFor();
  assert.equal(await dialog.locator(".settings-row label", { hasText: setting }).count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
});
