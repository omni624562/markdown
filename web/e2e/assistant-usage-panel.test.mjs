/**
 * 助理的用量面板（app/assistant-usage.ts）：按助理面板下方的「本月 已用 / 上限」打開，看今天、最近 7 天、
 * 這個月、上個月和最近 14 天每天的費用；再按一次關上；最下面的按鈕打開 Claude Console。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\旅遊";
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const now = new Date();
const TODAY = iso(now);
const MONTH = TODAY.slice(0, 7);
const daysAgo = (n) => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const LAST_MONTH = lastMonthDate.getFullYear() + "-" + pad(lastMonthDate.getMonth() + 1);

const desktop = (history) => ({
  startup_target: { kind: "folder", path: ROOT, name: "旅遊" },
  list_dir: { $by: "path", values: { [ROOT]: [] } },
  load_settings: JSON.stringify({ claudeApiEnabled: true, assistantProjects: [ROOT] }),
  assistant_key_status: true,
  assistant_usage: { month: MONTH, usd: history.usd, limit: 10 },
  assistant_usage_history: history,
});

async function openAssistant(history) {
  const opened = await open({ desktop: desktop(history) });
  const { page } = opened;
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText("# 筆記\n");
  await page.keyboard.press("Control+Shift+L");
  await page.locator("#assistant-panel .assistant-usage:not([hidden])").waitFor();
  return opened;
}

const rows = (page) =>
  page.$$eval(".usage-pop .usage-grid dt", (dts) => Object.fromEntries(dts.map((dt) => [dt.textContent, dt.nextElementSibling.firstChild.textContent])));

test("按「本月 已用 / 上限」打開用量面板：今天、最近 7 天、本月、上個月，和最近 14 天每天的費用；再按一次關上", async () => {
  // 今天 0.75、昨天 0.5、8 天前 1.0（不在最近 7 天裡）；這個月總額等於每日紀錄的加總。
  const days = [
    { date: daysAgo(8), usd: 1.0 },
    { date: daysAgo(1), usd: 0.5 },
    { date: TODAY, usd: 0.75 },
  ];
  const inMonth = days.filter((d) => d.date.startsWith(MONTH)).reduce((n, d) => n + d.usd, 0);
  const { page, context, errors } = await openAssistant({ today: TODAY, month: MONTH, usd: inMonth, limit: 10, days, months: [{ month: LAST_MONTH, usd: 6.2 }] });
  const button = page.locator("#assistant-panel .assistant-usage");
  assert.equal(await button.evaluate((b) => b.tagName), "BUTTON");
  await button.click();
  const pop = page.locator(".usage-pop:popover-open");
  await pop.locator(".usage-grid").waitFor();
  assert.equal(await button.getAttribute("aria-expanded"), "true");
  const r = await rows(page);
  assert.equal(r["今天"], "US$0.75");
  assert.equal(r["最近 7 天"], "US$1.25");
  assert.equal(r["本月"], "US$" + inMonth.toFixed(2));
  const last = Object.entries(r).find(([k]) => k.startsWith("上個月"));
  assert.deepEqual(last, ["上個月（" + Number(LAST_MONTH.slice(5)) + " 月）", "US$6.20"]);
  // 最近 14 天：由新到舊，第一列是今天；沒有用量的日子是「–」；長條依金額比例。
  const list = await page.$$eval(".usage-days li", (lis) =>
    lis.map((li) => ({ date: li.querySelector(".usage-date").textContent, amount: li.querySelector(".usage-amount").textContent, width: li.querySelector(".usage-bar i").style.width })),
  );
  assert.equal(list.length, 14);
  assert.deepEqual(list[0], { date: "今天", amount: "US$0.75", width: "75%" });
  assert.deepEqual([list[1].amount, list[1].width], ["US$0.50", "50%"]);
  assert.deepEqual([list[2].amount, list[2].width], ["–", "0%"]);
  assert.deepEqual([list[8].amount, list[8].width], ["US$1.00", "100%"]);
  // 沒有「升級前」的說明；有說明估計與餘額要到 Console 查。
  const notes = await pop.locator(".usage-notes").textContent();
  assert.doesNotMatch(notes, /之前用掉的/);
  assert.match(notes, /沒有提供查詢餘額的 API/);
  // 面板留在視窗裡。
  const box = await pop.boundingBox();
  const view = page.viewportSize();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= view.width && box.y + box.height <= view.height, JSON.stringify(box));
  // 打開 Console。
  await pop.locator("button", { hasText: "打開 Claude Console" }).click();
  const opened = (await calls(page)).filter((c) => c.cmd === "open_external").map((c) => c.args.url);
  assert.deepEqual(opened, ["https://platform.claude.com/usage"]);
  // 再按一次關上。
  await button.click();
  await page.waitForFunction(() => !document.querySelector(".usage-pop:popover-open"));
  assert.equal(await button.getAttribute("aria-expanded"), "false");
  assert.deepEqual(errors, []);
  await context.close();
});

test("升級前的用量沒有每日紀錄：說明本月有多少只算在總額裡；上個月沒有紀錄時寫「沒有紀錄」", async () => {
  const { page, context, errors } = await openAssistant({ today: TODAY, month: MONTH, usd: 3.5, limit: 10, days: [{ date: TODAY, usd: 0.5 }], months: [] });
  await page.locator("#assistant-panel .assistant-usage").click();
  await page.locator(".usage-pop:popover-open .usage-grid").waitFor();
  const r = await rows(page);
  assert.equal(r["本月"], "US$3.50");
  assert.equal(Object.entries(r).find(([k]) => k.startsWith("上個月"))[1], "沒有紀錄");
  assert.match(await page.locator(".usage-pop .usage-notes").textContent(), /本月有 US\$3\.00 是開始記錄每天用量之前用掉的/);
  assert.deepEqual(errors, []);
  await context.close();
});
