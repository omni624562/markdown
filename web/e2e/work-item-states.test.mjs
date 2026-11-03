/**
 * 工作項目的狀態篩選：列出伺服器上實際的狀態（New、Active、Resolved…），可以只看某幾個狀態；
 * 勾的剛好是所有還沒結束的狀態時，按鈕寫「進行中」，條件和以前一樣。用假的原生端（見 helpers.mjs）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const st = (name, stage, closed = false) => ({ name, stage, closed });
const item = (id, state) => ({
  id,
  title: `工作 ${id}`,
  state,
  kind: "Task",
  project: "產品",
  assignedTo: "王小明",
  changed: "2026-11-01T00:00:00Z",
  priority: 2,
  webUrl: `https://ado.test/c/產品/_workitems/edit/${id}`,
});
const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_work_items: [[item(1, "Active"), item(2, "New")]],
  ado_work_item_filters: {
    projects: ["產品", "維運"],
    kinds: ["Bug", "Task"],
    stateSets: [
      { project: "產品", kind: "Task", states: [st("New", 0), st("Active", 1), st("Resolved", 2), st("Closed", 3, true), st("Removed", 4, true)] },
      { project: "產品", kind: "Bug", states: [st("New", 0), st("Active", 1), st("Resolved", 2), st("Closed", 3, true)] },
      { project: "維運", kind: "Task", states: [st("To Do", 0), st("Doing", 1), st("Done", 3, true)] },
    ],
  },
  ado_work_item_scope: { areas: [], people: [] },
};

/** 狀態選單裡每一列：勾了的前面加 ✓。 */
const rows = (pop) =>
  pop.locator(".multi-select-list .multi-select-item").evaluateAll((ls) => ls.map((l) => `${l.querySelector("input").checked ? "✓" : " "}${l.textContent.replace("只選這個", "")}`));

/** 等到最後一次讀清單用的是這個狀態條件。 */
const waitFilter = (page, want) =>
  page.waitForFunction((want) => {
    const list = window.__fake.calls.filter((c) => c.cmd === "ado_work_items");
    const { state, states } = list[list.length - 1].args.filter;
    return JSON.stringify({ state, states }) === JSON.stringify(want);
  }, want);

test("狀態篩選：列出伺服器上的狀態；只看某幾個狀態；勾回所有還沒結束的就是「進行中」", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.click("#side-tab-workitems");
  await page.locator("#workitems-host .workitem-title", { hasText: "工作 1" }).waitFor();
  await page.locator("#workitems-host .workitems-filter-toggle:not(.workitems-query)").click();
  const button = page.locator("#workitems-host .multi-select", { hasText: "進行中" });
  await button.click();
  const pop = page.locator(".multi-select-pop:popover-open");
  // 預設「進行中」：還沒結束的狀態都勾著（沒選專案：兩個專案的狀態都列）。
  assert.deepEqual(await rows(pop), ["✓New", "✓To Do", "✓Active", "✓Doing", "✓Resolved", " Closed", " Done", " Removed"]);

  // 只看 Active。
  const active = pop.locator(".multi-select-item", { hasText: "Active" });
  await active.hover();
  await active.locator(".multi-select-only").click();
  await page.keyboard.press("Escape");
  const picked = page.locator("#workitems-host .multi-select", { hasText: /^Active$/ });
  await picked.waitFor();
  await waitFilter(page, { state: "all", states: ["Active"] });

  // 再勾回 New、Resolved：剛好是還沒結束的，按鈕寫「進行中」，條件回到 open。
  await picked.click();
  for (const name of ["New", "To Do", "Doing", "Resolved"]) await pop.locator(".multi-select-item", { hasText: name }).locator("input").check();
  await page.keyboard.press("Escape");
  await page.locator("#workitems-host .multi-select", { hasText: /^進行中$/ }).waitFor();
  await waitFilter(page, { state: "open", states: [] });
  // 記住選擇：存起來的是 open。
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("md-editor:workitem-filter"))).state, "open");
  assert.deepEqual(errors, []);
  await context.close();
});

test("選了專案、類型：狀態只列那個專案、類型用得到的；篩選列是「專案」「人｜查詢」「類型｜狀態」", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.click("#side-tab-workitems");
  await page.locator("#workitems-host .workitem-title", { hasText: "工作 1" }).waitFor();
  await page.locator("#workitems-host .workitems-filter-toggle:not(.workitems-query)").click();
  // 篩選列的順序：專案（最上面一整列），人（旁邊是已儲存的查詢），類型、狀態。
  const labels = await page
    .locator("#workitems-host .workitems-filters > .multi-select:not([hidden])")
    .evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label").split("：")[0]));
  assert.deepEqual(labels, ["專案", "人", "類型", "狀態"]);

  const pick = async (label, value) => {
    await page.locator(`#workitems-host .multi-select[aria-label^="${label}："]`).click();
    const row = page.locator(".multi-select-pop:popover-open .multi-select-item", { hasText: new RegExp(`^${value}`) });
    await row.hover();
    await row.locator(".multi-select-only").click();
    await page.keyboard.press("Escape");
  };
  const stateRows = async () => {
    await page.locator('#workitems-host .multi-select[aria-label^="狀態："]').click();
    const pop = page.locator(".multi-select-pop:popover-open");
    await pop.waitFor();
    const list = await rows(pop);
    await page.keyboard.press("Escape");
    return list;
  };
  await pick("專案", "維運");
  assert.deepEqual(await stateRows(), ["✓To Do", "✓Doing", " Done"]);
  await pick("專案", "產品");
  await pick("類型", "Bug");
  assert.deepEqual(await stateRows(), ["✓New", "✓Active", "✓Resolved", " Closed"]);
  // 按鈕還是「進行中」（條件沒變）。
  await page.locator("#workitems-host .multi-select", { hasText: /^進行中$/ }).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});
