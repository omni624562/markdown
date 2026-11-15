/**
 * 助理面板的「本月 已用 / 上限」：開著 app 跨月之後，視窗回到前面時重新讀一次用量（新的月份從 0 開始），
 * 不會一直顯示上個月的數字。同一個月份不會重讀。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\旅遊";
const now = new Date();
const THIS_MONTH = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
const desktop = (usage) => ({
  startup_target: { kind: "folder", path: ROOT, name: "旅遊" },
  list_dir: { $by: "path", values: { [ROOT]: [] } },
  load_settings: JSON.stringify({ claudeApiEnabled: true, assistantProjects: [ROOT] }),
  assistant_key_status: true,
  assistant_usage: usage,
});
const usageCalls = async (page) => (await calls(page)).filter((c) => c.cmd === "assistant_usage").length;

test("面板上是上個月的用量（開著 app 跨月）：視窗回到前面時重新讀一次", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ month: "2000-01", usd: 7.5, limit: 10 }) });
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText("# 筆記\n");
  await page.keyboard.press("Control+Shift+L");
  await page.waitForFunction(() => /7\.50/.test(document.querySelector("#assistant-panel .assistant-usage")?.textContent ?? ""));
  const before = await usageCalls(page);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction((n) => window.__fake.calls.filter((c) => c.cmd === "assistant_usage").length > n, before);
  assert.deepEqual(errors, []);
  await context.close();
});

test("月份沒變：視窗回到前面不會重讀用量", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ month: THIS_MONTH, usd: 1.25, limit: 10 }) });
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText("# 筆記\n");
  await page.keyboard.press("Control+Shift+L");
  await page.waitForFunction(() => /1\.25/.test(document.querySelector("#assistant-panel .assistant-usage")?.textContent ?? ""));
  const before = await usageCalls(page);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(200);
  assert.equal(await usageCalls(page), before);
  assert.deepEqual(errors, []);
  await context.close();
});
