/**
 * Wiki 放在右側時，左側圖示列的 Wiki 圖示照樣顯示：按一下顯示或隱藏右側欄。
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
  await tab.click();
  await page.locator('#outline-right .wiki-page[data-path="/首頁"]').waitFor();
  assert.equal(await right.isVisible(), true, "按一下打開右側欄，Wiki 在裡面");
  await tab.click();
  await page.waitForFunction(() => document.getElementById("outline-right").hidden);
  // 移回左邊：圖示照常是左邊的面板。
  await tab.click();
  await page.click("#wiki-dock");
  await page.locator('#panel-wiki:not([hidden]) .wiki-page[data-path="/首頁"]').waitFor();
  assert.equal(await page.locator("#side-tab-wiki").getAttribute("aria-selected"), "true");
  assert.deepEqual(errors, []);
  await context.close();
});
