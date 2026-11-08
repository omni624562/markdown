/**
 * 右側欄的分頁（app/right-tabs.ts）：大綱、反向連結、Wiki（、助理）放在同一欄，一次顯示一頁；分頁列是右側欄自己的第一列
 * （頂端列右上角只有開關）。選了哪一頁記住；Wiki 在右側時圖示列不顯示 Wiki，「Azure DevOps：Wiki」指令切到 Wiki 那一頁。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, runCommand } from "./helpers.mjs";

const ROOT = { kind: "folder", path: "/notes", name: "notes" };
const COBALT = "/notes/COBALT Release Channel.md";
const DEPLOY = "/notes/IRIS/部署流程.md";
const WEEKLY = "/notes/週報/2026-W44.md";
const COBALT_TEXT = ["# COBALT Release Channel", "", "## 使用方式", "", "## 本版摘要", "", "## 注意", ""].join("\n");
const DEPLOY_TEXT = "# 部署流程\n\n完成後到 [[COBALT Release Channel]] 下載安裝檔。\n";
const WEEKLY_TEXT = "# 2026-W44 週報\n\nCOMET 1.4 版已經上線，見 [[COBALT Release Channel]]。\n";
const info = (links) => ({ tasks: [], tags: [], links });
const file = (path, text) => ({ path, name: path.slice(path.lastIndexOf("/") + 1), text, encoding: "utf-8" });
const entry = (path, isDir = false) => ({ name: path.slice(path.lastIndexOf("/") + 1), path, isDir });
const WIKI = { id: "w1", name: "Contoso.wiki", project: "Contoso", projectId: "p1", code: false, repositoryId: "r1", mappedPath: "/", version: "wikiMaster", webUrl: "https://ado.test/c/Contoso/_wiki/wikis/Contoso.wiki" };
const desktop = (settings) => ({
  load_settings: JSON.stringify(settings),
  startup_target: ROOT,
  list_dir: { $by: "path", values: { "/notes": [entry("/notes/IRIS", true), entry("/notes/週報", true), entry(COBALT)], "/notes/IRIS": [entry(DEPLOY)], "/notes/週報": [entry(WEEKLY)] } },
  list_files: [[{ path: COBALT, rel: "COBALT Release Channel.md" }, { path: DEPLOY, rel: "IRIS/部署流程.md" }, { path: WEEKLY, rel: "週報/2026-W44.md" }]],
  scan_docs: [[
    { path: COBALT, rel: "COBALT Release Channel.md", mtime: 1, info: info([]) },
    { path: DEPLOY, rel: "IRIS/部署流程.md", mtime: 1, info: info([{ line: 3, target: "COBALT Release Channel", kind: "wiki" }]) },
    { path: WEEKLY, rel: "週報/2026-W44.md", mtime: 1, info: info([{ line: 3, target: "COBALT Release Channel", kind: "wiki" }]) },
  ]],
  read_docs: { $by: "paths", values: { [WEEKLY]: [WEEKLY_TEXT], [DEPLOY]: [DEPLOY_TEXT], [`${DEPLOY},${WEEKLY}`]: [DEPLOY_TEXT, WEEKLY_TEXT] } },
  reopen_file: { $by: "path", values: { [COBALT]: file(COBALT, COBALT_TEXT), [DEPLOY]: file(DEPLOY, DEPLOY_TEXT), [WEEKLY]: file(WEEKLY, WEEKLY_TEXT) } },
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_wikis: [[WIKI]],
  ado_wiki_pages: [[{ path: "/IRIS專區", id: 1, children: [{ path: "/IRIS專區/部署流程", id: 2, children: [] }] }]],
});

async function openFile(page, name) {
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill(name);
  await page.locator("dialog[open] [role=option]", { hasText: name }).first().waitFor();
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent?.startsWith(n), name);
}

/** 大綱放在右邊（設定），Wiki 也移到右側（`wikiRight`），開著連到「COBALT Release Channel」的文件。 */
async function setup({ outlineRight = true, wikiRight = true, panelStyle } = {}) {
  const opened = await open({ desktop: desktop({ outlineRight, ...(panelStyle ? { panelStyle } : {}) }) });
  const { page } = opened;
  await page.evaluate((on) => localStorage.setItem("md-editor:wiki-right", on ? "1" : ""), wikiRight);
  await page.reload();
  await page.waitForSelector("#file-tree .tree-row");
  await openFile(page, "部署流程");
  await openFile(page, "COBALT");
  await page.locator("#outline-right:not([hidden])").waitFor();
  return opened;
}

const tab = (page, id) => page.locator(`#outline-right .right-tab[data-tab="${id}"]`);
const selected = async (page, id) => (await tab(page, id).getAttribute("aria-selected")) === "true";
const shownTabs = (page) => page.locator("#outline-right .right-tab:not([hidden]) .right-tab-label").allTextContents();

test("分頁列在右側欄最上面：大綱、反向連結（有數字）、Wiki；一次顯示一頁，點一下切換，重新載入後還記得；左右鍵切換", async () => {
  const { page, context, errors } = await setup();
  await page.locator('#outline-right .right-tab[data-tab="backlinks"] .right-tab-badge', { hasText: "2" }).waitFor();
  assert.deepEqual(await shownTabs(page), ["大綱", "反向連結", "Wiki"]);
  assert.equal(await selected(page, "outline"), true, "預設是大綱");
  assert.equal(await page.locator("#outline-right #panel-outline").isVisible(), true);
  assert.equal(await page.locator("#outline-right #panel-wiki").isVisible(), false, "Wiki 那一頁藏著");
  assert.equal(await page.locator("#panel-outline > .side-head h2").isVisible(), false, "標題列不重複寫名稱（分頁就是名稱）");
  assert.equal(await page.locator("#panel-outline > .side-head .side-actions .btn").count(), 1, "大綱的「全部收合」還在標題列");
  // 反向連結自己一頁：清單在裡面，原本的小標題不重複顯示。
  await tab(page, "backlinks").click();
  assert.equal(await selected(page, "backlinks"), true);
  assert.equal(await page.locator("#outline-right .right-backlinks #backlinks li").count(), 2);
  assert.equal(await page.locator("#backlinks > h3").isVisible(), false);
  assert.equal(await page.locator("#outline-right #panel-outline").isVisible(), false);
  // Wiki：切過去才讀頁面，標題列上的移到左邊、重新整理都在。
  await tab(page, "wiki").click();
  await page.locator('#outline-right .wiki-page[data-path="/IRIS專區"]').waitFor();
  assert.equal(await page.locator("#panel-wiki > .side-head #wiki-dock").isVisible(), true);
  assert.equal(await page.locator("#panel-wiki > .side-head #wiki-refresh").isVisible(), true);
  // 重新載入：還是 Wiki。
  await page.reload();
  await page.locator('#outline-right .wiki-page[data-path="/IRIS專區"]').waitFor();
  assert.equal(await selected(page, "wiki"), true);
  // 鍵盤：焦點在分頁上按 ← 切到前一頁。
  await tab(page, "wiki").focus();
  await page.keyboard.press("ArrowLeft");
  assert.equal(await selected(page, "backlinks"), true);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.tab), "backlinks");
  assert.deepEqual(errors, []);
  await context.close();
});

test("Wiki 在右側欄：圖示列不顯示 Wiki；看著別頁時用「Azure DevOps：Wiki」指令切到 Wiki（不是收起右側欄）；收起右側欄後分頁列藏起來", async () => {
  const { page, context, errors } = await setup();
  assert.equal(await page.locator("#side-tab-wiki").isVisible(), false, "右側欄開著：圖示列沒有 Wiki");
  await tab(page, "outline").click();
  await runCommand(page, "Azure DevOps：Wiki");
  assert.equal(await selected(page, "wiki"), true);
  assert.equal(await page.locator("#outline-right").isVisible(), true);
  // 收起右側欄：分頁列跟著藏起來，右上角只剩開關；再打開回到 Wiki。
  await page.keyboard.press("Control+Alt+B");
  await page.locator("#outline-right").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#outline-right .right-tabs").isVisible(), false);
  assert.equal(await page.locator('.top-actions [data-command="toggle-outline-right"]').isVisible(), true);
  await page.keyboard.press("Control+Alt+B");
  await page.locator("#outline-right:not([hidden])").waitFor();
  assert.equal(await selected(page, "wiki"), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("只有大綱在右側：兩個分頁（大綱、反向連結）；大綱移回左邊時標題列恢復、反向連結回到大綱底下", async () => {
  const { page, context, errors } = await setup({ wikiRight: false });
  assert.deepEqual(await shownTabs(page), ["大綱", "反向連結"]);
  assert.equal(await page.locator("#side-tab-wiki").isVisible(), true, "Wiki 在左邊的側邊欄");
  // 設定關掉「大綱放在右邊」：右側欄沒有分頁就整個收起；大綱回到左邊，標題列有名稱，反向連結在大綱底下。
  await runCommand(page, "設定");
  await page.click("dialog[open] [role=tab]:has-text('版面')");
  await page.locator("dialog[open]").getByLabel("大綱放在右邊").uncheck();
  await page.keyboard.press("Escape");
  await page.locator("#outline-right").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".top-actions").isVisible(), false, "右上角那塊整個藏起來");
  await page.click("#side-tab-outline");
  assert.equal(await page.locator("#sidebar #panel-outline > .side-head h2").textContent(), "大綱");
  assert.equal(await page.locator("#sidebar #panel-outline > .side-body #backlinks").count(), 1, "反向連結回到大綱底下");
  assert.deepEqual(errors, []);
  await context.close();
});
