/**
 * Wiki 搜尋照樹狀目錄的範圍：篩選了最上層頁面（「顯示哪些最上層頁面」）時，頁面名稱與內容的搜尋
 * 只在勾選的最上層頁面底下找，下面提示藏了幾個最上層頁面；按「全部顯示」就找整個 Wiki。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const WIKI = {
  id: "w1",
  name: "Mgt.wiki",
  project: "Mgt",
  projectId: "p1",
  code: false,
  repositoryId: "r1",
  mappedPath: "/",
  version: "wikiMaster",
  webUrl: "https://ado.test/c/Mgt/_wiki/wikis/Mgt.wiki",
};
const PAGES = [
  { path: "/首頁", id: 1, children: [] },
  {
    path: "/產品",
    id: 2,
    children: [
      { path: "/產品/安裝說明", id: 21, children: [] },
      { path: "/產品/規格", id: 22, children: [] },
    ],
  },
  { path: "/文件", id: 3, children: [{ path: "/文件/安裝手冊", id: 31, children: [] }] },
];
const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_wikis: [[WIKI]],
  ado_wiki_pages: [PAGES],
  // 伺服器的內容搜尋找的是整個 Wiki（路徑是 Wiki 儲存庫裡的檔案）。
  ado_wiki_search: {
    available: true,
    results: [
      { path: "/產品/規格.md", snippet: "先看<highlighthit>安裝</highlighthit>" },
      { path: "/首頁.md", snippet: "<highlighthit>安裝</highlighthit>前" },
    ],
  },
};

const found = (p) => p.locator("#wiki-host .wiki-tree .wiki-page").evaluateAll((bs) => bs.map((b) => b.dataset.path));
const content = (p) => p.locator("#wiki-host .wiki-content .wiki-page").evaluateAll((bs) => bs.map((b) => b.dataset.path));

test("篩選了最上層頁面：名稱與內容的搜尋都只在勾選的頁面底下找；全部顯示後找整個 Wiki", async () => {
  const { page: p, context, errors } = await open({ desktop });
  await p.click("#side-tab-wiki");
  await p.locator('#wiki-host .wiki-page[data-path="/首頁"]').waitFor();
  // 只顯示「產品」。
  await p.click("#wiki-host .wiki-filter-toggle");
  const row = p.locator(".multi-select-pop:popover-open .multi-select-item", { hasText: "產品" });
  await row.hover();
  await row.locator(".multi-select-only").click();
  await p.keyboard.press("Escape");
  await p.locator("#wiki-host .wiki-hidden-note", { hasText: "已隱藏 2 個最上層頁面" }).waitFor();

  await p.fill("#wiki-host .workitems-search", "安裝");
  await p.locator("#wiki-host .workitems-status", { hasText: "找到 1 頁" }).waitFor();
  assert.deepEqual(await found(p), ["/產品/安裝說明"]);
  // 搜尋時也提示還有藏起來的最上層頁面。
  assert.ok(await p.locator("#wiki-host .wiki-hidden-note").isVisible());
  await p.locator("#wiki-host .wiki-content h3", { hasText: "內容符合（1）" }).waitFor();
  assert.deepEqual(await content(p), ["/產品/規格"]);

  // 全部顯示：找整個 Wiki。
  await p.click("#wiki-host .wiki-hidden-note .wiki-hidden-show");
  await p.locator("#wiki-host .workitems-status", { hasText: "找到 2 頁" }).waitFor();
  assert.deepEqual(await found(p), ["/產品/安裝說明", "/文件/安裝手冊"]);
  await p.locator("#wiki-host .wiki-content h3", { hasText: "內容符合（2）" }).waitFor();
  assert.deepEqual((await content(p)).sort(), ["/產品/規格", "/首頁"].sort());
  assert.deepEqual(errors, []);
  await context.close();
});
