/**
 * 左側圖示列的捷徑：開著的那一個和上面開著的面板圖示一樣（淡淡的強調色底、左邊一條強調色），
 * 那一條不會被捷徑區的捲動範圍切掉。用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const ITEM = {
  id: 1895963,
  title: "消費明細查詢及爭議帳申請",
  state: "Active",
  kind: "Feature",
  project: "產品",
  assignedTo: "王小明",
  changed: "2026-10-30T00:00:00Z",
  priority: 2,
  webUrl: "https://ado.test/c/產品/_workitems/edit/1895963",
  createdBy: "王小明",
  area: "產品",
  iteration: "產品",
  tags: [],
  description: "<p>說明</p>",
  details: null,
  rev: 3,
  relations: [],
  attachments: [],
  comments: [],
};

test("開著的捷徑和開著的面板圖示同一種樣子，左邊那一條沒有被切掉", async () => {
  const { page, context, errors } = await open({
    desktop: { ado_account: { url: "https://ado.test/c", name: "王小明" }, ado_work_item: ITEM },
  });
  await page.evaluate((item) => {
    localStorage.setItem("md-editor:wiki-shortcuts", JSON.stringify([{ workItem: item.id, kind: item.kind, title: item.title }]));
  }, ITEM);
  await page.reload();
  // 開一個面板，當成比較的對象。
  await page.click("#side-tab-workitems");
  const shortcut = page.locator(".activity-wiki-page").first();
  await shortcut.click();
  await page.waitForSelector(".ado-hero");
  await page.waitForFunction(() => document.querySelector(".activity-wiki-page")?.getAttribute("aria-current") === "page");
  const look = await page.evaluate(() => {
    const tab = document.querySelector('.activity-tabs button[aria-selected="true"]');
    const sc = document.querySelector('.activity-wiki-page[aria-current="page"]');
    const bar = (el) => {
      const s = getComputedStyle(el, "::before");
      const r = el.getBoundingClientRect();
      return { width: s.width, color: s.backgroundColor, left: Math.round(r.left + parseFloat(s.left)) };
    };
    const area = document.querySelector(".activity-wiki").getBoundingClientRect();
    return {
      tabBg: getComputedStyle(tab).backgroundColor,
      scBg: getComputedStyle(sc).backgroundColor,
      tabBar: bar(tab),
      scBar: bar(sc),
      areaLeft: Math.round(area.left),
      ring: getComputedStyle(sc.querySelector(".wiki-badge")).boxShadow,
    };
  });
  assert.equal(look.scBg, look.tabBg, "底色一樣");
  assert.deepEqual(look.scBar, look.tabBar, "左邊那一條的寬度、顏色、位置一樣");
  assert.ok(look.scBar.left >= look.areaLeft, "那一條在捷徑區裡面（不會被捲動範圍切掉）");
  assert.equal(look.ring, "none", "不再用方塊外框");
  assert.deepEqual(errors, []);
  await context.close();
});
