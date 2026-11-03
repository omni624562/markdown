/**
 * 工作項目的狀態篩選：列出伺服器上實際的狀態（New、Active、Resolved…），可以只看某幾個狀態；
 * 勾的剛好是所有還沒結束的狀態時，按鈕寫「進行中」，條件和以前一樣。用假的原生端（見 helpers.mjs）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

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
    projects: ["產品"],
    kinds: ["Task"],
    states: [
      { name: "New", closed: false },
      { name: "Active", closed: false },
      { name: "Resolved", closed: false },
      { name: "Closed", closed: true },
      { name: "Removed", closed: true },
    ],
  },
};

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
  const rows = () =>
    pop.locator(".multi-select-list .multi-select-item").evaluateAll((ls) => ls.map((l) => `${l.querySelector("input").checked ? "✓" : " "}${l.textContent.replace("只選這個", "")}`));
  // 預設「進行中」：還沒結束的狀態都勾著。
  assert.deepEqual(await rows(), ["✓New", "✓Active", "✓Resolved", " Closed", " Removed"]);

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
  await pop.locator(".multi-select-item", { hasText: "New" }).locator("input").check();
  await pop.locator(".multi-select-item", { hasText: "Resolved" }).locator("input").check();
  await page.keyboard.press("Escape");
  await page.locator("#workitems-host .multi-select", { hasText: /^進行中$/ }).waitFor();
  await waitFilter(page, { state: "open", states: [] });
  // 記住選擇：存起來的是 open。
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("md-editor:workitem-filter"))).state, "open");
  assert.deepEqual(errors, []);
  await context.close();
});
