/**
 * Wiki 頁面和工作項目一樣：標頭只留一列位置，頁名在內容最上面大字出現一次（內容沒有同名的大標題時補上）；
 * 往下捲到看不到大標題時，標頭的位置縮成「… › 上一層」，後面接著頁名；按頁名捲回最上面。
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
const A = "/需求專區";
const B = `${A}/阿發3.0`;
const C = `${B}/轉真人客服`;
const D = `${B}/訪談紀錄`;
const long = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 段：轉接條件與排隊規則。`).join("\n\n");
const page = (content) => ({ content, webUrl: null, etag: null });
const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_wikis: [[WIKI]],
  ado_wiki_pages: [[{ path: A, id: 1, children: [{ path: B, id: 2, children: [{ path: C, id: 3, children: [] }, { path: D, id: 4, children: [] }] }] }]],
  ado_wiki_page: { $by: "path", values: { [C]: page(`# 轉真人客服\n\n${long}`), [D]: page(`訪談日期：2026-10-28\n\n${long}`) } },
};

async function openPage(p, path) {
  // 再按一次圖示會收起側邊欄：沒開著才按。
  if (!(await p.locator("#panel-wiki").isVisible())) await p.click("#side-tab-wiki");
  for (const parent of [A, B]) {
    const row = p.locator("#wiki-host li", { has: p.locator(`.wiki-page[data-path="${parent}"]`) }).first();
    if ((await row.getAttribute("aria-expanded")) !== "true") await row.locator(".wiki-toggle").first().click();
  }
  await p.click(`#wiki-host .wiki-page[data-path="${path}"]`);
  await p.locator(".issue-body > h1.page-hero").waitFor();
}

/** 標頭看得到的樣子：位置裡看得到的文字、頁名是否顯示。 */
const head = (p) =>
  p.evaluate(() => {
    const pane = document.querySelector(".issue-pane");
    const label = pane.querySelector(".issue-label");
    const visible = [...label.children].filter((el) => el.getClientRects().length).map((el) => el.textContent.trim());
    const title = pane.querySelector(".issue-head .issue-title");
    return {
      hero: pane.classList.contains("issue-page-hero"),
      away: pane.classList.contains("issue-title-away"),
      crumbs: visible.filter((s) => s !== "›"),
      title: getComputedStyle(title).visibility === "visible" ? title.textContent : null,
      top: Math.round(title.getBoundingClientRect().top),
      labelTop: Math.round(label.getBoundingClientRect().top),
    };
  });

test("Wiki 頁面：標頭一列位置，頁名只在內容最上面出現一次；往下捲時標頭帶出頁名，按頁名捲回最上面", async () => {
  const { page: p, context, errors } = await open({ desktop });
  await openPage(p, C);
  assert.equal(await p.locator(".issue-body h1").count(), 1, "內容的大標題就是頁名，不再多補一個");
  // 進入這種標頭時，頁名淡出（有轉場）：等它藏好。
  await p.waitForFunction(() => getComputedStyle(document.querySelector(".issue-head .issue-title")).visibility === "hidden");
  let h = await head(p);
  assert.equal(h.hero, true);
  assert.deepEqual(h.crumbs, ["Mgt.wiki", "需求專區", "阿發3.0"], "標頭是完整的位置");
  assert.equal(h.title, null, "還看得到大標題時，標頭不重複顯示頁名");

  await p.locator(".issue-scroll").evaluate((el) => (el.scrollTop = 600));
  await p.waitForFunction(() => document.querySelector(".issue-pane").classList.contains("issue-title-away"));
  await p.waitForFunction(() => getComputedStyle(document.querySelector(".issue-head .issue-title")).visibility === "visible");
  h = await head(p);
  assert.deepEqual(h.crumbs, ["阿發3.0"], "位置縮成「… › 上一層」");
  assert.equal(h.title, "轉真人客服", "標頭帶出頁名");
  assert.ok(Math.abs(h.top - h.labelTop) < 6, "頁名和位置在同一列");

  await p.locator(".issue-head .issue-title").click();
  await p.waitForFunction(() => document.querySelector(".issue-scroll").scrollTop === 0);
  await p.waitForFunction(() => !document.querySelector(".issue-pane").classList.contains("issue-title-away"));
  assert.deepEqual(errors, []);
  await context.close();
});

test("Wiki 頁面內容沒有同名的大標題：最上面補上頁名", async () => {
  const { page: p, context, errors } = await open({ desktop });
  await openPage(p, D);
  const first = p.locator(".issue-body > :first-child");
  assert.equal(await first.evaluate((el) => el.tagName), "H1");
  assert.equal(await first.textContent(), "訪談紀錄");
  assert.equal(await p.locator(".issue-body h1").count(), 1);
  // 切到另一頁再回來（重畫）：還是只有一個大標題。
  await openPage(p, C);
  await p.locator(".issue-body > h1.page-hero", { hasText: "轉真人客服" }).waitFor();
  await openPage(p, D);
  assert.equal(await p.locator(".issue-body h1.page-hero").count(), 1);
  assert.equal(await p.locator(".issue-body h1.page-hero").textContent(), "訪談紀錄");
  assert.deepEqual(errors, []);
  await context.close();
});
