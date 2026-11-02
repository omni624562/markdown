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
  // 「已移除」不顯示成一欄。
  ado_work_item_states: [["New", "Active", "Resolved", "Closed", "Removed"]],
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
  const heads = await page.$$eval(".tb-head .tb-col-head", (els) => els.map((e) => e.firstChild?.nextSibling?.textContent));
  assert.deepEqual(heads, ["New", "Active", "Resolved", "Closed"]);
  // 欄位標題後面是卡片數量。
  assert.equal(await page.textContent(".tb-head .tb-col-head:nth-child(2) .tb-count"), "2");
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

test("工作板：連不上伺服器時用上次存下的副本，標出是幾點的資料", async () => {
  const fail = { $error: "連不上伺服器" };
  const copy = (value) => JSON.stringify({ $copy: 1, savedAt: Date.now() - 600_000, value });
  const board = "board:產品/t1/i2";
  const { page, context, errors } = await open({
    desktop: {
      ado_account: desktop.ado_account,
      ado_work_item_filters: fail,
      ado_teams: fail,
      ado_team_iterations: fail,
      ado_board: fail,
      ado_work_items_by_ids: fail,
      ado_work_item_states: fail,
      offline_get: {
        $by: "key",
        values: {
          "list:wi-filters": copy(desktop.ado_work_item_filters),
          "list:teams:產品": copy(desktop.ado_teams[0]),
          "list:sprints:產品/t1": copy(desktop.ado_team_iterations[0]),
          [`list:board:${board}`]: copy(ITEMS),
          [`list:board-parents:${board}`]: copy(desktop.ado_work_items_by_ids[0]),
          "list:states:產品|Task": copy(desktop.ado_work_item_states[0]),
        },
      },
    },
  });
  await openBoard(page);
  assert.equal(await page.locator(".taskboard .tb-cell .tb-card").count(), 4);
  await page.getByText(/連不上伺服器，顯示 .* 存下的資料/).first().waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test("工作板：專案選單只列常用的，最下面可以顯示全部", async () => {
  const { page, context, errors } = await open({
    desktop: { ...desktop, ado_work_item_filters: { projects: ["ALM", "產品", "CUB"], kinds: [] } },
  });
  await page.keyboard.press("Control+Shift+P");
  await page.locator("dialog[open] input").first().fill("顯示工作板");
  await page.keyboard.press("Enter");
  await page.locator("#board-project option").first().waitFor({ state: "attached" });
  const options = () => page.$$eval("#board-project option", (l) => l.map((o) => o.textContent));
  assert.deepEqual(await options(), ["ALM", "產品", "CUB"], "沒設常用時全部列出");
  // 星號：只選「產品」當常用的。
  await page.locator("#board-host .favorite-toggle").click();
  const row = page.locator(".multi-select-pop:popover-open .multi-select-item", { hasText: "產品" });
  await row.hover();
  await row.locator(".multi-select-only").click();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelectorAll("#board-project option").length === 4);
  const shown = await options();
  assert.equal(shown[0], "ALM", "目前選的不是常用的也留著");
  assert.equal(shown[1], "產品");
  assert.match(shown[3], /顯示全部（3）/);
  await page.selectOption("#board-project", { label: shown[3] });
  await page.waitForFunction(() => [...document.querySelectorAll("#board-project option")].some((o) => o.textContent === "只顯示常用"));
  assert.equal(await page.inputValue("#board-project"), "ALM", "切換顯示全部時選的不變");
  assert.equal(await page.locator("#board-host .favorite-toggle.active").count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test("工作板：改卡片的指派與工時、在上層項目底下新增 Task（放進這個 Sprint）", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ...desktop,
      ado_team_members: [[
        { name: "王小明", unique: "CORP\\ming" },
        { name: "梁朝為", unique: "CORP\\liang" },
      ]],
      ado_work_item_create: { ...ITEMS[1], id: 9001, title: "新的工作" },
    },
  });
  await openBoard(page);
  // 改指派與工時。
  const target = page.locator('.tb-card[data-id="1936947"]');
  await target.hover();
  await target.locator(".tb-edit").click();
  const dialog = page.locator("dialog.tb-edit-dialog[open]");
  await dialog.locator("select").selectOption("CORP\\ming");
  await dialog.locator("input[type=number]").first().fill("2.5");
  await dialog.locator("button[type=submit]").click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_work_item_update"));
  const update = (await calls(page)).find((c) => c.cmd === "ado_work_item_update").args;
  assert.equal(update.id, 1936947);
  assert.equal(update.change.assignedTo, "CORP\\ming");
  assert.equal(update.change.remaining, 2.5);
  assert.equal(update.change.completed, undefined, "沒改的不送");
  assert.equal(update.change.rev, 3);
  // 新增 Task。
  const row = page.locator(".tb-row", { hasText: "SP102 值機" });
  await row.hover();
  await row.locator(".tb-add").click();
  const add = page.locator("dialog.tb-edit-dialog[open]");
  await add.locator("input[type=text]").fill("新的工作");
  await add.locator("input[type=number]").fill("4");
  await add.locator("button[type=submit]").click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_work_item_create"));
  const item = (await calls(page)).find((c) => c.cmd === "ado_work_item_create").args.item;
  assert.equal(item.kind, "Task");
  assert.equal(item.parent, 1931940);
  assert.equal(item.iteration, "產品\\Sprint 102");
  assert.equal(item.remaining, 4);
  assert.equal(item.assignToMe, true, "預設指派給自己");
  assert.deepEqual(errors, []);
  await context.close();
});
