/**
 * 左側圖示列的捷徑：按了工作項目、Wiki 頁面的捷徑，內容開好後側邊欄也換到「工作項目」或「Wiki」面板，
 * 看得到它在清單、樹上的位置；側邊欄收起來時不會自己打開。用假的原生端（見 helpers.mjs）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const ITEM = {
  id: 1895963,
  title: "訂單明細查詢",
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
  ado_work_item: ITEM,
  ado_wikis: [[WIKI]],
  ado_wiki_pages: [[{ path: "/首頁", id: 1, children: [] }]],
  ado_wiki_page: { content: "# 首頁", webUrl: null, etag: '"1"' },
};

test("按捷徑：側邊欄換到工作項目或 Wiki 面板；側邊欄收起來時不打開", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.evaluate((item) => {
    localStorage.setItem(
      "md-editor:wiki-shortcuts",
      JSON.stringify([
        { workItem: item.id, kind: item.kind, title: item.title },
        { wiki: "w1", wikiName: "Contoso.wiki", path: "/首頁" },
      ]),
    );
  }, ITEM);
  await page.reload();
  await page.click("#side-tab-files");
  const selected = () => page.evaluate(() => document.querySelector('.activity-tabs [role="tab"][aria-selected="true"]')?.id);
  const sidebarShown = () => page.evaluate(() => !document.querySelector(".workspace").classList.contains("outline-hidden"));
  assert.equal(await selected(), "side-tab-files");

  const [workItem, wikiPage] = [page.locator(".activity-wiki-page").nth(0), page.locator(".activity-wiki-page").nth(1)];
  await workItem.click();
  await page.waitForSelector(".ado-hero");
  await page.waitForFunction(() => document.querySelector('.activity-tabs [role="tab"][aria-selected="true"]')?.id === "side-tab-workitems");
  await wikiPage.click();
  await page.waitForFunction(() => document.querySelector('.activity-tabs [role="tab"][aria-selected="true"]')?.id === "side-tab-wiki");
  assert.ok(await sidebarShown());

  // 收起側邊欄後再按捷徑：內容照樣開，側邊欄不會自己打開。
  await page.click(".activity-toggle");
  await page.waitForFunction(() => document.querySelector(".workspace").classList.contains("outline-hidden"));
  await workItem.click();
  await page.waitForFunction(() => document.querySelector(".activity-wiki-page")?.getAttribute("aria-current") === "page");
  await page.waitForTimeout(200);
  assert.equal(await sidebarShown(), false, "側邊欄收起來時不打開");
  assert.deepEqual(errors, []);
  await context.close();
});
