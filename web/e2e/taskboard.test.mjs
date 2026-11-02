/**
 * Sprint 工作板（左側圖示列的「工作板」）：用假的原生端（helpers.mjs）模擬 Azure DevOps。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open, runCommand } from "./helpers.mjs";

const base = { project: "產品", changed: "2026-10-30T00:00:00Z", priority: null, webUrl: "https://ado.test/x", rev: 3, remaining: null, completed: null, original: null };
const w = (id, kind, title, state, parent, assignedTo, extra = {}) => ({ ...base, id, kind, title, state, parent, assignedTo, ...extra });

const ITEMS = [
  w(1931940, "User Story", "SP102 值機", "Active", null, "梁朝為", { priority: 1 }),
  w(1936947, "Task", "提供 SRE 監控的方式", "New", 1931940, "梁朝為", { remaining: 6 }),
  w(1929183, "Task", "CUBE Beta 測試用 WIFI", "Resolved", 1931940, "黃昭翔"),
  w(1691088, "Task", "批次壓縮程式開發", "New", 1673120, "許晉嘉"),
  w(1700846, "Task", "沒有上層的工作", "Active", null, "王小明"),
];

// 回應是陣列時要再包一層（helpers.mjs 把陣列當成「依序回傳」）。
const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_work_item_filters: { projects: ["產品"], kinds: [] },
  ado_teams: [
    [
      { id: "t1", name: "ITA", default: true },
      { id: "t2", name: "前端", default: false },
    ],
  ],
  ado_team_iterations: [[
    { id: "i1", name: "Sprint 101", path: "產品\\Sprint 101", start: "2026-10-12T00:00:00Z", finish: "2026-10-23T00:00:00Z", current: false },
    { id: "i2", name: "Sprint 102", path: "產品\\Sprint 102", start: "2026-10-26T00:00:00Z", finish: "2026-11-06T00:00:00Z", current: true },
  ]],
  ado_board: [ITEMS],
  // 上層不在這個 Sprint：另外讀標題。
  ado_work_items_by_ids: [[w(1673120, "User Story", "SP83 新人臉辨識", "New", null, "許晉嘉")]],
  ado_work_item_states: [["New", "Active", "Resolved", "Closed"]],
};

async function openBoard(page) {
  await page.keyboard.press("Control+Shift+P");
  await page.locator("dialog[open] input").first().fill("顯示工作板");
  await page.keyboard.press("Enter");
  const button = page.locator("#board-host button", { hasText: "開啟工作板" });
  await button.waitFor();
  await page.waitForFunction(() => !document.querySelector("#board-host button.btn-primary")?.disabled);
  await button.click();
  await page.waitForSelector(".taskboard .tb-card");
}

test("工作板：上層項目一列、狀態一欄，選了目前的 Sprint", async () => {
  const { page, context, errors } = await open({ desktop });
  await openBoard(page);
  assert.equal(await page.inputValue("#board-sprint"), "i2", "預設選目前的 Sprint");
  const heads = await page.$$eval(".tb-head .tb-col-head", (els) => els.map((e) => e.textContent));
  assert.deepEqual(heads, ["New", "Active", "Resolved", "Closed"]);
  const rows = await page.$$eval(".taskboard .tb-row:not(.tb-head) .tb-parent", (els) => els.map((e) => e.textContent ?? ""));
  assert.equal(rows.length, 3);
  assert.match(rows[0], /SP102 值機/);
  assert.match(rows[1], /SP83 新人臉辨識/, "上層不在 Sprint 裡也讀得到標題");
  assert.match(rows[2], /沒有上層/);
  const resolved = page.locator(".tb-row").nth(1).locator('.tb-cell[data-state="Resolved"] .tb-card');
  assert.match(await resolved.textContent(), /CUBE Beta/);
  assert.match(await page.locator('.tb-card[data-id="1936947"]').textContent(), /剩 6 小時/);
  // 只看我：只剩王小明的卡片。
  await page.selectOption("#board-person", "@me");
  await page.waitForFunction(() => document.querySelectorAll(".taskboard .tb-cell .tb-card").length === 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test("工作板：拖曳卡片到別的欄就改狀態（帶修訂版本）", async () => {
  const { page, context, errors } = await open({ desktop });
  await openBoard(page);
  const card = page.locator('.tb-card[data-id="1936947"]');
  const target = page.locator(".tb-row").nth(1).locator('.tb-cell[data-state="Active"]');
  await card.dragTo(target);
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_work_item_update"));
  const sent = (await calls(page)).find((c) => c.cmd === "ado_work_item_update").args;
  assert.equal(sent.id, 1936947);
  assert.equal(sent.change.state, "Active");
  assert.equal(sent.change.rev, 3);
  assert.deepEqual(errors, []);
  await context.close();
});

test("工作板：點卡片開啟工作項目，按 Alt+← 回到工作板", async () => {
  const detail = { ...ITEMS[1], createdBy: null, area: null, iteration: null, tags: [], description: null, details: null, relations: [], attachments: [], comments: [] };
  const { page, context, errors } = await open({ desktop: { ...desktop, ado_work_item: detail } });
  await openBoard(page);
  await page.click('.tb-card[data-id="1936947"]');
  await page.waitForSelector(".ado-hero");
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForSelector(".taskboard .tb-card");
  assert.deepEqual(errors, []);
  await context.close();
});
