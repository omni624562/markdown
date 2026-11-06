/**
 * Wiki 放在右側時：右側欄開著，左側圖示列就不顯示 Wiki 的圖示（Wiki 就在右邊）；
 * 右側欄收起來時才顯示（不然找不到 Wiki），按一下打開右側欄，圖示又藏起來。圖示右邊一條線標出 Wiki 在右側。
 * （更早以前放到右側後圖示一律藏起來，右側欄又收起來時找不到 Wiki，連設定也救不回來。）
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

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
/** 圖示右邊的那條線（Wiki 在右側欄才有）。 */
const rightBar = (page) =>
  page.locator("#side-tab-wiki").evaluate((el) => {
    const after = getComputedStyle(el, "::after");
    return { content: after.content, right: after.right };
  });

const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_wikis: [[WIKI]],
  ado_wiki_pages: [[{ path: "/首頁", id: 1, children: [] }]],
};

test("Wiki 在右側：右側欄開著時圖示列沒有 Wiki；收起來時才有，按一下打開右側欄", async () => {
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
  // 右側欄收著：圖示列有 Wiki，圖示右邊一條線（看得出 Wiki 在右側）。
  const bar = await rightBar(page);
  assert.equal(bar.content, '""', "Wiki 在右側：圖示右邊有一條線");
  assert.equal(bar.right, "-4px", "線在圖示的右邊");
  await tab.click();
  await page.locator('#outline-right .wiki-page[data-path="/首頁"]').waitFor();
  assert.equal(await right.isVisible(), true, "按一下打開右側欄，Wiki 在裡面");
  // 右側欄開著：圖示列不顯示 Wiki（Wiki 就在右邊），游標放進 Wiki 的搜尋框。
  await tab.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.matches("#outline-right #panel-wiki input[type=search]")), true, "游標在 Wiki 的搜尋框");
  // 用方向鍵在圖示列移動時也跳過看不到的 Wiki 圖示。
  // （排在 Wiki 前面的是看板；只放焦點不切換面板。）
  await page.locator("#side-tab-board").focus();
  await page.keyboard.press("ArrowDown");
  assert.notEqual(await page.evaluate(() => document.activeElement?.id), "side-tab-wiki");
  // 收起右側欄：圖示又出現。
  await page.keyboard.press("Control+Alt+B");
  await tab.waitFor({ state: "visible" });
  assert.equal(await right.isVisible(), false);
  // 打開右側欄後把 Wiki 移回左邊：圖示照常是左邊的面板。
  await tab.click();
  await tab.waitFor({ state: "hidden" });
  await page.click("#wiki-dock");
  await page.locator('#panel-wiki:not([hidden]) .wiki-page[data-path="/首頁"]').waitFor();
  assert.equal(await tab.isVisible(), true, "移回左邊：圖示列有 Wiki");
  assert.equal(await tab.getAttribute("aria-selected"), "true");
  assert.equal((await rightBar(page)).content, "none", "移回左邊：右邊沒有線（照常是左邊一條）");
  assert.deepEqual(errors, []);
  await context.close();
});
