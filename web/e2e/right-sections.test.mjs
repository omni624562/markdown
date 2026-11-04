/**
 * 右側欄的分區（像 VS Code）：大綱、反向連結、Wiki 各有一列標題，按一下（或用鍵盤）收合、展開；
 * 收合的分區只剩標題列，其他展開的分區撐滿整欄。大綱與 Wiki 都在右側、都展開時中間有一條分隔線，
 * 可以拖曳、用方向鍵調整，雙擊恢復一半一半。收合狀態與分隔線的位置重新載入後還記得。
 * 只改右側欄：面板移回左邊時恢復原本的樣子。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const ROOT = { kind: "folder", path: "/notes", name: "notes" };
const COBALT = "/notes/COBALT Release Channel.md";
const DEPLOY = "/notes/IRIS/部署流程.md";
const WEEKLY = "/notes/週報/2026-W44.md";
const COBALT_TEXT = ["# COBALT Release Channel", "", "## 使用方式", "", "## 本版摘要", "", "### 新增或改善", "", "### 修正", "", "## 檔案說明", "", "## 注意", ""].join("\n");
const DEPLOY_TEXT = "# 部署流程\n\n完成後到 [[COBALT Release Channel]] 下載安裝檔。\n";
const WEEKLY_TEXT = "# 2026-W44 週報\n\nCOMET 1.4 版已經上線，見 [[COBALT Release Channel]]。\n";
const info = (links) => ({ tasks: [], tags: [], links });
const file = (path, text) => ({ path, name: path.slice(path.lastIndexOf("/") + 1), text, encoding: "utf-8" });
const entry = (path, isDir = false) => ({ name: path.slice(path.lastIndexOf("/") + 1), path, isDir });
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
const desktop = (settings) => ({
  load_settings: JSON.stringify(settings),
  startup_target: ROOT,
  list_dir: {
    $by: "path",
    values: { "/notes": [entry("/notes/IRIS", true), entry("/notes/週報", true), entry(COBALT)], "/notes/IRIS": [entry(DEPLOY)], "/notes/週報": [entry(WEEKLY)] },
  },
  // 陣列是依序用掉的回應（見 helpers.mjs），回傳陣列時要再包一層。
  list_files: [
    [
      { path: COBALT, rel: "COBALT Release Channel.md" },
      { path: DEPLOY, rel: "IRIS/部署流程.md" },
      { path: WEEKLY, rel: "週報/2026-W44.md" },
    ],
  ],
  scan_docs: [
    [
      { path: COBALT, rel: "COBALT Release Channel.md", mtime: 1, info: info([]) },
      { path: DEPLOY, rel: "IRIS/部署流程.md", mtime: 1, info: info([{ line: 3, target: "COBALT Release Channel", kind: "wiki" }]) },
      { path: WEEKLY, rel: "週報/2026-W44.md", mtime: 1, info: info([{ line: 3, target: "COBALT Release Channel", kind: "wiki" }]) },
    ],
  ],
  read_docs: { $by: "paths", values: { [WEEKLY]: [WEEKLY_TEXT], [DEPLOY]: [DEPLOY_TEXT], [`${DEPLOY},${WEEKLY}`]: [DEPLOY_TEXT, WEEKLY_TEXT] } },
  reopen_file: { $by: "path", values: { [COBALT]: file(COBALT, COBALT_TEXT), [DEPLOY]: file(DEPLOY, DEPLOY_TEXT), [WEEKLY]: file(WEEKLY, WEEKLY_TEXT) } },
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_wikis: [[WIKI]],
  ado_wiki_pages: [[{ path: "/IRIS專區", id: 1, children: [{ path: "/IRIS專區/部署流程", id: 2, children: [] }] }]],
});

/** 用 Ctrl+P 開啟檔案。 */
async function openFile(page, name) {
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill(name);
  await page.locator("dialog[open] [role=option]", { hasText: name }).first().waitFor();
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent?.startsWith(n), name);
}

/** 大綱放在右邊（設定），Wiki 也移到右側（`wikiRight`），開著連到「COBALT Release Channel」的文件。 */
async function setup({ outlineRight = true, wikiRight = true } = {}) {
  const opened = await open({ desktop: desktop({ outlineRight }) });
  const { page } = opened;
  await page.evaluate((on) => localStorage.setItem("md-editor:wiki-right", on ? "1" : ""), wikiRight);
  await page.reload();
  await page.waitForSelector("#file-tree .tree-row");
  // 先開連過來的那份（用掉一開始的空白分頁），再開目標文件（反向連結有兩份）。
  await openFile(page, "部署流程");
  await openFile(page, "COBALT");
  if (wikiRight) await page.locator('#outline-right .wiki-page[data-path="/IRIS專區"]').waitFor();
  return opened;
}

const toggle = (page, id) => page.locator(`#outline-right .rs-toggle[data-section="${id}"]`);
const expanded = async (page, id) => (await toggle(page, id).getAttribute("aria-expanded")) === "true";

/** 右側欄與各分區的高度。 */
const heights = (page) =>
  page.evaluate(() => {
    const box = (sel) => document.querySelector(sel).getBoundingClientRect();
    return {
      column: box("#outline-right").height,
      columnBottom: box("#outline-right").bottom,
      outline: box("#panel-outline").height,
      outlineList: box("#panel-outline > .side-body").height,
      wiki: box("#panel-wiki").height,
      wikiBottom: box("#panel-wiki").bottom,
      splitterShown: !!document.querySelector(".rs-splitter")?.getClientRects().length,
    };
  });

test("大綱、反向連結、Wiki 各有標題列：收合後只剩標題列、其他分區撐滿，重新載入後還記得", async () => {
  const { page, context, errors } = await setup();
  await page.locator('#outline-right .rs-toggle[data-section="backlinks"] .rs-badge', { hasText: "2" }).waitFor();
  // 三列標題，都展開；標題列上的按鈕照舊（大綱的「全部收合」、Wiki 的移到左邊與重新整理）。
  const labels = await page.locator("#outline-right .rs-toggle .rs-label").allTextContents();
  assert.deepEqual(labels, ["大綱", "反向連結", "Wiki"]);
  for (const id of ["outline", "backlinks", "wiki"]) assert.equal(await expanded(page, id), true, `${id} 展開`);
  assert.equal(await page.locator("#panel-outline > .side-head .side-actions .btn").count(), 1, "大綱的「全部收合」還在標題列");
  assert.equal(await page.locator("#panel-wiki > .side-head #wiki-dock").isVisible(), true);
  assert.equal(await page.locator("#panel-wiki > .side-head #wiki-refresh").isVisible(), true);
  // 反向連結自己一區（標題列寫了數字，原本的小標題不重複顯示）。
  assert.equal(await page.locator("#outline-right .rs-backlinks #backlinks li").count(), 2);
  assert.equal(await page.locator("#backlinks > h3").isVisible(), false);
  const before = await heights(page);
  assert.equal(before.splitterShown, true, "大綱與 Wiki 都展開：中間有分隔線");

  // 收合大綱：只剩標題列，Wiki 撐滿（變高），分隔線不見。
  await toggle(page, "outline").click();
  assert.equal(await expanded(page, "outline"), false);
  assert.equal(await page.locator("#panel-outline > .side-body").isVisible(), false);
  assert.equal(await page.locator("#panel-outline > .side-head .side-actions").isVisible(), false, "收合時不顯示「全部收合」");
  const outlineClosed = await heights(page);
  assert.equal(outlineClosed.splitterShown, false);
  assert.ok(outlineClosed.wiki > before.wiki + 100, `Wiki 變高（${before.wiki} → ${outlineClosed.wiki}）`);
  assert.ok(Math.abs(outlineClosed.wikiBottom - outlineClosed.columnBottom) < 1, "Wiki 一路到底");

  // 反向連結也收合：Wiki 再變高。
  await toggle(page, "backlinks").click();
  assert.equal(await page.locator("#backlinks").isVisible(), false);
  const bothClosed = await heights(page);
  assert.ok(bothClosed.wiki > outlineClosed.wiki + 40, "收合反向連結後 Wiki 再變高");

  // 只剩反向連結展開：反向連結撐滿，Wiki 的標題列在最下面。
  await toggle(page, "backlinks").click();
  await toggle(page, "wiki").click();
  const onlyBacklinks = await heights(page);
  assert.ok(onlyBacklinks.wiki < 30, `Wiki 只剩標題列（${onlyBacklinks.wiki}）`);
  assert.ok(Math.abs(onlyBacklinks.wikiBottom - onlyBacklinks.columnBottom) < 1, "Wiki 的標題列在最下面");
  assert.ok(onlyBacklinks.outline > onlyBacklinks.column - 40, "反向連結撐滿");

  // 收合反向連結、展開大綱：大綱撐滿，Wiki 只剩標題列。
  await toggle(page, "backlinks").click();
  await toggle(page, "outline").click();
  const wikiClosed = await heights(page);
  assert.ok(wikiClosed.wiki < 30, `Wiki 只剩標題列（${wikiClosed.wiki}）`);
  assert.ok(wikiClosed.outline > before.outline + 100, "大綱變高");
  assert.ok(wikiClosed.outlineList > before.outlineList + 100, "大綱的清單變高");
  assert.equal(wikiClosed.splitterShown, false);

  // 重新載入：收合狀態還在。
  await page.reload();
  await page.locator('#outline-right .rs-toggle[data-section="wiki"]').waitFor();
  assert.equal(await expanded(page, "outline"), true);
  assert.equal(await expanded(page, "wiki"), false);
  assert.equal(await expanded(page, "backlinks"), false);

  // 鍵盤：標題是按鈕，Tab 到它按 Enter 或空白鍵就能展開。
  await toggle(page, "wiki").focus();
  await page.keyboard.press("Enter");
  assert.equal(await expanded(page, "wiki"), true);
  await page.locator('#outline-right .wiki-page[data-path="/IRIS專區"]').waitFor();
  await toggle(page, "backlinks").focus();
  await page.keyboard.press("Space");
  assert.equal(await expanded(page, "backlinks"), true);
  assert.equal((await heights(page)).splitterShown, true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("Wiki 收合時按圖示列的 Wiki：展開 Wiki（不是收起整個右側欄）", async () => {
  const { page, context, errors } = await setup();
  await toggle(page, "wiki").click();
  await page.click("#side-tab-wiki");
  assert.equal(await expanded(page, "wiki"), true);
  assert.equal(await page.locator("#outline-right").isVisible(), true);
  // 已經展開：再按一下不收起右側欄，游標放進 Wiki 的搜尋框。
  await page.click("#side-tab-wiki");
  assert.equal(await page.locator("#outline-right").isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement?.matches("#panel-wiki input[type=search]")), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("分隔線：拖曳調整大綱與 Wiki 的高度，重新載入後還記得；方向鍵調整、雙擊恢復", async () => {
  const { page, context, errors } = await setup();
  const splitter = page.locator("#outline-right .rs-splitter");
  assert.equal(await splitter.getAttribute("role"), "separator");
  assert.equal(await splitter.getAttribute("aria-orientation"), "horizontal");
  assert.equal(await splitter.evaluate((el) => getComputedStyle(el).cursor), "row-resize");
  const start = await heights(page);
  assert.ok(Math.abs(start.outline - start.wiki) < 2, `預設一半一半（${start.outline}、${start.wiki}）`);

  // 往上拖 120 像素：大綱變矮、Wiki 變高。
  const box = await splitter.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 120, { steps: 6 });
  await page.mouse.up();
  const dragged = await heights(page);
  assert.ok(Math.abs(dragged.outline - (start.outline - 120)) < 2, `大綱變矮 120（${start.outline} → ${dragged.outline}）`);
  assert.ok(Math.abs(dragged.wiki - (start.wiki + 120)) < 2, "Wiki 變高 120");
  assert.ok(Number(await page.evaluate(() => localStorage.getItem("md-editor:right-split"))) < 0.5);

  // 重新載入：位置還在。
  await page.reload();
  await page.locator('#outline-right .wiki-page[data-path="/IRIS專區"]').waitFor();
  const reloaded = await heights(page);
  assert.ok(Math.abs(reloaded.outline - dragged.outline) < 2, `重新載入後一樣高（${dragged.outline}、${reloaded.outline}）`);

  // 方向鍵：↓ 大綱變高 16，Shift+↑ 變矮 48；aria-valuenow 跟著變。
  await splitter.focus();
  const now = () => splitter.getAttribute("aria-valuenow");
  const v0 = Number(await now());
  await page.keyboard.press("ArrowDown");
  assert.ok(Math.abs((await heights(page)).outline - (reloaded.outline + 16)) < 2, "↓ 往下 16 像素");
  assert.ok(Number(await now()) > v0);
  await page.keyboard.press("Shift+ArrowUp");
  assert.ok(Math.abs((await heights(page)).outline - (reloaded.outline - 32)) < 2, "Shift+↑ 往上 48 像素");

  // 拖到最上面：大綱至少留標題列和幾列內容。
  const b2 = await splitter.boundingBox();
  await page.mouse.move(b2.x + b2.width / 2, b2.y + 2);
  await page.mouse.down();
  await page.mouse.move(b2.x + b2.width / 2, 0, { steps: 6 });
  await page.mouse.up();
  assert.ok((await heights(page)).outline >= 95, "大綱不會被拖到看不見");

  // 雙擊恢復一半一半。
  await splitter.dblclick();
  const reset = await heights(page);
  assert.ok(Math.abs(reset.outline - reset.wiki) < 2, "雙擊恢復一半一半");
  assert.deepEqual(errors, []);
  await context.close();
});

test("只有大綱或只有 Wiki 在右側：照樣有標題列、沒有分隔線；移回左邊時恢復原本的樣子", async () => {
  // 只有 Wiki 在右側。
  {
    const { page, context, errors } = await setup({ outlineRight: false });
    assert.deepEqual(await page.locator("#outline-right .rs-toggle .rs-label").allTextContents(), ["Wiki"]);
    assert.equal((await heights(page)).splitterShown, false);
    // 左邊的大綱面板照舊：標題是文字，反向連結在大綱清單底下。
    await page.click("#side-tab-outline");
    assert.equal(await page.locator("#panel-outline > .side-head h2").textContent(), "大綱");
    assert.equal(await page.locator("#panel-outline .rs-toggle").count(), 0);
    assert.equal(await page.locator("#panel-outline > .side-body > #backlinks").count(), 1);
    // Wiki 移回左邊：標題換回文字。
    await page.click("#wiki-dock");
    await page.locator('#panel-wiki:not([hidden]) .wiki-page[data-path="/IRIS專區"]').waitFor();
    assert.equal(await page.locator("#panel-wiki > .side-head h2").textContent(), "Wiki");
    assert.equal(await page.locator("#panel-wiki .rs-toggle").count(), 0);
    assert.equal(await page.locator("#panel-wiki > .side-body").isVisible(), true);
    assert.deepEqual(errors, []);
    await context.close();
  }
  // 只有大綱在右側；視窗變窄時大綱回到左邊的側邊欄，反向連結放回大綱底下。
  {
    const { page, context, errors } = await setup({ wikiRight: false });
    await page.locator('#outline-right .rs-toggle[data-section="backlinks"] .rs-badge', { hasText: "2" }).waitFor();
    assert.deepEqual(await page.locator("#outline-right .rs-toggle .rs-label").allTextContents(), ["大綱", "反向連結"]);
    assert.equal((await heights(page)).splitterShown, false);
    // 收合大綱：反向連結接在標題列下面。
    await toggle(page, "outline").click();
    const tops = await page.evaluate(() => ({
      head: document.querySelector("#panel-outline > .side-head").getBoundingClientRect().bottom,
      backlinks: document.querySelector(".rs-backlinks").getBoundingClientRect().top,
    }));
    assert.ok(Math.abs(tops.head - tops.backlinks) < 1);
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.waitForFunction(() => document.getElementById("outline-right").hidden);
    await page.click("#side-tab-outline");
    assert.equal(await page.locator("#panel-outline > .side-head h2").textContent(), "大綱");
    assert.equal(await page.locator("#panel-outline .rs-toggle, #panel-outline .rs-backlinks").count(), 0);
    assert.equal(await page.locator("#panel-outline > .side-body > #backlinks").count(), 1);
    assert.equal(await page.locator("#outline-list").isVisible(), true, "左邊的大綱不受右側欄收合的影響");
    assert.equal(await page.locator("#backlinks > h3").isVisible(), true);
    // 再變寬：回到右側，還是收合著。
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForFunction(() => !document.getElementById("outline-right").hidden);
    assert.equal(await expanded(page, "outline"), false);
    assert.equal(await page.locator("#outline-right .rs-backlinks #backlinks").count(), 1);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
