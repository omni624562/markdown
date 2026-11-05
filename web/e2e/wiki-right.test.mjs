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
  name: "Contoso.wiki",
  project: "Contoso",
  projectId: "p1",
  code: false,
  repositoryId: "r1",
  mappedPath: "/",
  version: "wikiMaster",
  webUrl: "https://ado.test/c/Contoso/_wiki/wikis/Contoso.wiki",
};
/** 圖示右邊的那條線（Wiki 在右側欄才有）、圖示的底色，以及右側欄顯示著 Wiki 時的框與斜線。 */
const rightBar = (page) =>
  page.locator("#side-tab-wiki").evaluate((el) => {
    const after = getComputedStyle(el, "::after");
    const before = getComputedStyle(el, "::before");
    return {
      content: after.content,
      right: after.right,
      color: after.backgroundColor,
      tab: getComputedStyle(el).backgroundColor,
      frame: before.content !== "none" && before.borderTopWidth !== "0px" && before.backgroundImage.includes("repeating-linear-gradient"),
    };
  });

const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_wikis: [[WIKI]],
  ado_wiki_pages: [[{ path: "/首頁", id: 1, children: [] }]],
};

test("Wiki 在右側、右側欄收起來：圖示列還有 Wiki，按一下打開右側欄；開著時再按一下只把游標放進 Wiki 的搜尋框", async () => {
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
  assert.equal(hidden.frame, false, "右側欄收著：圖示沒有框與斜線");
  await tab.click();
  await page.locator('#outline-right .wiki-page[data-path="/首頁"]').waitFor();
  assert.equal(await right.isVisible(), true, "按一下打開右側欄，Wiki 在裡面");
  const shown = await rightBar(page);
  assert.notEqual(shown.color, hidden.color, "右側欄顯示著 Wiki：線換成強調色");
  // 和左邊開著的面板（淡綠底）分得開：外面一圈強調色的框、裡面淡淡的斜線，沒有整塊的底色。
  assert.equal(shown.frame, true, "右側欄顯示著 Wiki：圖示有框與斜線");
  assert.equal(shown.tab, "rgba(0, 0, 0, 0)", "右側欄顯示著 Wiki：沒有整塊的底色");
  // Wiki 那一區收合：和右側欄收著一樣是淡灰色的線。
  await page.locator('#outline-right .rs-toggle[data-section="wiki"]').click();
  assert.equal((await rightBar(page)).color, hidden.color, "Wiki 收合：線變回淡灰色");
  await page.locator('#outline-right .rs-toggle[data-section="wiki"]').click();
  assert.equal((await rightBar(page)).color, shown.color);
  // 開著時再按一下：不收起右側欄（大綱也在裡面），游標放進 Wiki 的搜尋框。
  await page.locator(".cm-content").focus();
  await tab.click();
  assert.equal(await right.isVisible(), true, "右側欄沒有收起來");
  assert.equal(await page.evaluate(() => document.activeElement?.closest("#outline-right #panel-wiki") !== null && document.activeElement?.matches("input[type=search]")), true, "游標在 Wiki 的搜尋框");
  await page.keyboard.type("首頁");
  assert.equal(await page.locator("#panel-wiki input[type=search]").inputValue(), "首頁");
  // 移回左邊：圖示照常是左邊的面板。
  await page.click("#wiki-dock");
  await page.locator('#panel-wiki:not([hidden]) .wiki-page[data-path="/首頁"]').waitFor();
  assert.equal(await page.locator("#side-tab-wiki").getAttribute("aria-selected"), "true");
  assert.equal((await rightBar(page)).content, "none", "移回左邊：右邊沒有線（照常是左邊一條）");
  assert.deepEqual(errors, []);
  await context.close();
});
