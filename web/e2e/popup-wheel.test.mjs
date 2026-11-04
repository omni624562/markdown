/**
 * 滑鼠在下拉選單（篩選的複選選單）上捲動滾輪時，只捲選單本身：選單不用捲、或已經捲到底時，
 * 後面的工作項目清單不能跟著捲。用假的原生端（見 helpers.mjs）。
 * 測試用的 Chromium 本來就不會捲到後面（Windows 的 WebView2 會），所以也檢查選單有沒有把滾輪擋下來。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const item = (id) => ({
  id,
  title: `工作 ${id}`,
  state: "Active",
  kind: "Task",
  project: "產品",
  assignedTo: "王小明",
  changed: "2026-11-01T00:00:00Z",
  priority: 2,
  webUrl: `https://ado.test/c/產品/_workitems/edit/${id}`,
});
// 清單夠長（要捲動）；類型夠多（類型選單自己也要捲動）。
const KINDS = Array.from({ length: 40 }, (_, i) => `類型 ${String(i + 1).padStart(2, "0")}`);
const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_work_items: [Array.from({ length: 80 }, (_, i) => item(i + 1))],
  ado_work_item_filters: { projects: ["產品"], kinds: KINDS },
};

/** 工作項目面板裡會捲動的元素（清單）目前捲到哪裡。 */
const listScroll = (page) =>
  page.locator("#workitems-host").evaluate((host) => {
    const scroller = [...host.querySelectorAll("*")].find((el) => el.scrollHeight > el.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(el).overflowY));
    return scroller ? scroller.scrollTop : null;
  });

/** 在 `locator` 上捲動滾輪；回傳這次的滾輪有沒有被擋下來（不交給瀏覽器捲動）。 */
async function wheelOver(page, locator, deltaY) {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => {
    window.__wheel = [];
    window.addEventListener("wheel", (e) => window.__wheel.push(e.defaultPrevented), { passive: true, once: true });
  });
  await page.mouse.wheel(0, deltaY);
  // 捲動是非同步的，等一下再看。
  await page.waitForTimeout(300);
  return page.evaluate(() => window.__wheel[0]);
}

test("滾輪在下拉選單上：選單不用捲時後面的清單不動；選單捲到底後也不會捲到後面", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.locator("#side-tab-workitems").click();
  await page.locator("#workitems-host .workitem-title", { hasText: "工作 80" }).waitFor({ state: "attached" });
  // 篩選一直顯示在清單上面，不用先展開。
  assert.equal(await listScroll(page), 0, "清單一開始在最上面");

  // 狀態選單只有幾項，不用捲：滾輪不能捲到後面的清單。
  await page.locator("#workitems-host .multi-select", { hasText: "進行中" }).click();
  const pop = page.locator(".multi-select-pop:popover-open");
  await pop.waitFor();
  assert.equal(await wheelOver(page, pop, 400), true, "選單不用捲：滾輪擋在選單上");
  assert.equal(await listScroll(page), 0, "狀態選單上捲動，後面的清單不能動");
  await page.keyboard.press("Escape");

  // 類型選單很長：滾輪捲選單本身，捲到底之後再捲也不會捲到後面的清單。
  await page.locator("#workitems-host .multi-select", { hasText: "所有類型" }).click();
  await pop.waitFor();
  const list = pop.locator(".multi-select-list");
  assert.equal(await wheelOver(page, list, 300), false, "選單捲得動：照常捲");
  assert.ok((await list.evaluate((el) => el.scrollTop)) > 0, "類型選單自己會捲");
  for (let i = 0; i < 5; i++) await wheelOver(page, list, 600);
  assert.ok(await list.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1), "類型選單捲到底");
  assert.equal(await wheelOver(page, list, 600), true, "選單捲到底：滾輪擋在選單上");
  assert.equal(await listScroll(page), 0, "選單捲到底後再捲，後面的清單也不能動");
  await page.keyboard.press("Escape");

  // 選單關上後，滾輪照常捲清單。
  assert.equal(await wheelOver(page, page.locator("#workitems-host .workitem-title", { hasText: /^工作 3$/ }), 400), false);
  assert.ok((await listScroll(page)) > 0, "沒有選單時清單照常捲");
  assert.deepEqual(errors, []);
  await context.close();
});
