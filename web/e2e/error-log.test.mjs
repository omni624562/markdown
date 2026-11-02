/**
 * 錯誤看得到：沒接住的錯誤會提示，「說明：複製錯誤紀錄」把細節放到剪貼簿。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, runCommand } from "./helpers.mjs";

test("沒接住的錯誤：提示一次，可以複製錯誤紀錄", async () => {
  const { page, context, errors } = await open();
  // 測試用的網址不是安全來源，沒有剪貼簿：換成記下內容的假剪貼簿（桌面版有真的剪貼簿）。
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => void (window.__copied = text) } });
  });
  await page.evaluate(() => {
    void Promise.reject(new Error("測試用的錯誤"));
  });
  await page.locator(".toast", { hasText: "發生錯誤：測試用的錯誤" }).waitFor();
  await runCommand(page, "複製錯誤紀錄");
  await page.locator(".toast", { hasText: "已複製 1 筆錯誤紀錄" }).waitFor();
  const text = await page.evaluate(() => window.__copied);
  assert.match(text, /^oMarker /);
  assert.match(text, /未處理的錯誤: 測試用的錯誤/);
  // 頁面上的錯誤只有這一個（是測試自己丟的）。
  assert.deepEqual(
    errors.filter((m) => !m.includes("測試用的錯誤")),
    [],
  );
  await context.close();
});
