/**
 * 工作項目、Wiki 面板上方的篩選區可以收合：標題列的按鈕收合後，篩選區換成一行摘要（工作項目是目前的條件，
 * Wiki 是目前的 Wiki），按一下摘要展開；重新開啟後還記得。要把游標放進搜尋框時（例如從圖示列打開右側的 Wiki），
 * 收合著也會先展開。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const item = (id, title) => ({
  id,
  title,
  state: "Active",
  kind: "Task",
  project: "產品",
  assignedTo: "王小明",
  changed: "2026-11-01T00:00:00Z",
  priority: 2,
  webUrl: `https://ado.test/c/產品/_workitems/edit/${id}`,
});
const WIKI = {
  id: "w1",
  name: "Contoso.wiki",
  project: "Contoso",
  projectId: "p1",
  code: false,
  repositoryId: "r1",
  mappedPath: "/",
  version: "wikiMaster",
  webUrl: "https://ado.test/c/Contoso/_wiki/wikis/Contoso.wiki",
};
const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_work_items: [[item(1, "登入頁面跑版"), item(2, "匯出加上頁碼")]],
  ado_work_item_filters: { projects: ["產品", "平台"], kinds: ["Task", "Bug"] },
  ado_work_item_scope: { areas: ["產品", "產品\\前端"], people: ["王小明", "陳大文"] },
  ado_wikis: [[WIKI]],
  ado_wiki_pages: [[{ path: "/首頁", id: 1, children: [] }]],
};

const visible = (page, sel) => page.locator(sel).first().evaluate((el) => el.getClientRects().length > 0);

test("工作項目：篩選區收合成一行摘要，按摘要展開；重新開啟後還記得", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.click("#side-tab-workitems");
  await page.locator("#workitems-host .workitem", { hasText: "登入頁面跑版" }).first().waitFor();
  const toggle = page.locator("#panel-workitems .side-head .filters-toggle");
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", "預設展開");
  assert.equal(await visible(page, "#workitems-host .workitems-filters"), true);
  assert.equal(await visible(page, "#workitems-host .filters-summary"), false, "展開時沒有摘要");
  // 標題列的按鈕排在「建立工作項目」「重新整理」前面。
  assert.deepEqual(
    await page.locator("#panel-workitems .side-head .side-actions > button").evaluateAll((els) => els.map((b) => b.id || b.className)),
    ["btn icon-only filters-toggle", "ado-new", "workitems-refresh"],
  );

  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(await visible(page, "#workitems-host .workitems-filters"), false, "收合：篩選區藏起來");
  const summary = page.locator("#workitems-host .filters-summary");
  assert.equal(await visible(page, "#workitems-host .filters-summary"), true, "收合：換成一行摘要");
  const text = await summary.locator(".filters-summary-text").textContent();
  for (const part of ["所有專案", "指派給我", "所有類型", "進行中"]) assert.ok(text.includes(part), `摘要列出「${part}」：${text}`);
  assert.equal(await visible(page, "#workitems-host .workitem"), true, "清單照樣顯示");

  // 重新開啟：還是收合著。
  await page.reload();
  // 重新開啟時面板還是工作項目（不用再點圖示，點了反而收起側邊欄）。
  await page.locator('#side-tab-workitems[aria-selected="true"]').waitFor();
  await page.locator("#workitems-host .workitem").first().waitFor();
  assert.equal(await visible(page, "#workitems-host .workitems-filters"), false, "重新開啟後還是收合");
  assert.equal(await visible(page, "#workitems-host .filters-summary"), true);

  // 按摘要展開，游標放在篩選區的第一個選項。
  await page.locator("#workitems-host .filters-summary").click();
  assert.equal(await visible(page, "#workitems-host .workitems-filters"), true, "按摘要展開");
  assert.equal(await visible(page, "#workitems-host .filters-summary"), false);
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest("#workitems-host .workitems-filters")), true, "游標在篩選區");
  assert.equal(await page.locator("#panel-workitems .filters-toggle").getAttribute("aria-expanded"), "true");
  assert.deepEqual(errors, []);
  await context.close();
});

test("Wiki：上方的選單與搜尋收合成 Wiki 名稱一行；從圖示列打開右側的 Wiki 時會先展開，游標放進搜尋框", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.click("#side-tab-wiki");
  await page.locator('#panel-wiki .wiki-page[data-path="/首頁"]').waitFor();
  const toggle = page.locator("#panel-wiki .side-head .filters-toggle");
  await toggle.click();
  assert.equal(await visible(page, "#wiki-host .wiki-filters"), false, "Wiki 選單藏起來");
  assert.equal(await visible(page, "#wiki-host .workitems-searchrow"), false, "搜尋框藏起來");
  assert.match(await page.locator("#wiki-host .filters-summary-text").textContent(), /Contoso\.wiki/, "摘要是目前的 Wiki");
  assert.equal(await visible(page, '#wiki-host .wiki-page[data-path="/首頁"]'), true, "頁面樹照樣顯示");

  // Wiki 放到右側、右側欄收著：從圖示列打開時，游標要放進搜尋框，所以先展開。
  await page.evaluate(() => {
    localStorage.setItem("md-editor:wiki-right", "1");
    localStorage.setItem("md-editor:outline-right", "hidden");
  });
  await page.reload();
  await page.locator("#side-tab-wiki").click();
  await page.locator('#outline-right .wiki-page[data-path="/首頁"]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.matches("#panel-wiki .workitems-search")), true, "游標在 Wiki 的搜尋框");
  assert.equal(await visible(page, "#wiki-host .workitems-searchrow"), true, "搜尋框展開了");
  assert.equal(await visible(page, "#wiki-host .filters-summary"), false);
  assert.deepEqual(errors, []);
  await context.close();
});
