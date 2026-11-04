/**
 * Wiki 放在右側時，左側圖示列的 Wiki 圖示照樣顯示：按一下顯示或隱藏右側欄；圖示右邊一條線標出 Wiki 在右側。
 * （原本放到右側後圖示就藏起來，右側欄又收起來時找不到 Wiki，連設定也救不回來。）
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
/** 圖示右邊的那條線（Wiki 在右側欄才有）與圖示的底色。 */
const rightBar = (page) =>
  page.locator("#side-tab-wiki").evaluate((el) => {
    const after = getComputedStyle(el, "::after");
    return { content: after.content, right: after.right, color: after.backgroundColor, tab: getComputedStyle(el).backgroundColor };
  });

const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_wikis: [[WIKI]],
  ado_wiki_pages: [[{ path: "/首頁", id: 1, children: [] }]],
};

test("Wiki 在右側、右側欄收起來：圖示列還有 Wiki，按一下打開右側欄，再按一下收起來", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.evaluate(() => {
    localStorage.setItem("md-editor:wiki-right", "1");
    localStorage.setItem("md-editor:outline-right", "hidden");
  });
  await page.reload();
  const tab = page.locator("#side-tab-wiki");
  await tab.waitFor({ state: "visible" });
  assert.match(await tab.getAttribute("aria-label"), /在右側欄/);
  const right = page.locator("#outline-right");
  assert.equal(await right.isVisible(), false, "右側欄收著");
  // 圖示右邊有一條線（看得出 Wiki 在右側）；右側欄收著時是淡灰色、圖示沒有底色。
  const hidden = await rightBar(page);
  assert.equal(hidden.content, '""', "Wiki 在右側：圖示右邊有一條線");
  assert.equal(hidden.right, "-4px", "線在圖示的右邊");
  assert.equal(hidden.tab, "rgba(0, 0, 0, 0)", "右側欄收著：圖示沒有底色");
  await tab.click();
  await page.locator('#outline-right .wiki-page[data-path="/首頁"]').waitFor();
  assert.equal(await right.isVisible(), true, "按一下打開右側欄，Wiki 在裡面");
  const shown = await rightBar(page);
  assert.notEqual(shown.color, hidden.color, "右側欄顯示著 Wiki：線換成強調色");
  assert.notEqual(shown.tab, "rgba(0, 0, 0, 0)", "右側欄顯示著 Wiki：圖示有底色");
  // Wiki 那一區收合：和右側欄收著一樣是淡灰色的線。
  await page.locator('#outline-right .rs-toggle[data-section="wiki"]').click();
  assert.equal((await rightBar(page)).color, hidden.color, "Wiki 收合：線變回淡灰色");
  await page.locator('#outline-right .rs-toggle[data-section="wiki"]').click();
  assert.equal((await rightBar(page)).color, shown.color);
  await tab.click();
  await page.waitForFunction(() => document.getElementById("outline-right").hidden);
  // 移回左邊：圖示照常是左邊的面板。
  await tab.click();
  await page.click("#wiki-dock");
  await page.locator('#panel-wiki:not([hidden]) .wiki-page[data-path="/首頁"]').waitFor();
  assert.equal(await page.locator("#side-tab-wiki").getAttribute("aria-selected"), "true");
  assert.equal((await rightBar(page)).content, "none", "移回左邊：右邊沒有線（照常是左邊一條）");
  assert.deepEqual(errors, []);
  await context.close();
});
