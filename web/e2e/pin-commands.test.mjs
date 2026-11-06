/**
 * 釘選指令：「☰」選單裡的指令按右鍵，可以釘到「檔案」面板上方（專案名稱旁邊）或左側圖示列。
 * 檔案面板上方的按鈕在最右邊、跟著專案（沒開專案時那一列不顯示）；釘了按鈕之後，原本的新增檔案等三個按鈕
 * 滑鼠移到面板上才出現（出現時釘上去的按鈕不會移動）。「在 Codex 開啟」「在 Claude Code 開啟」用不同的圖示。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\產品筆記";
const PROJECT = { path: ROOT, label: "產品筆記", name: null, color: "blue", group: null, pinned: false, lastOpened: 0 };
const DESKTOP = {
  projects_list: [[PROJECT]],
  reopen_folder: { path: ROOT, name: "產品筆記" },
  list_dir: [[{ name: "週報.md", path: `${ROOT}\\週報.md`, isDir: false }]],
  ai_apps_installed: { codex: true, claude: true },
};

async function openProject(page) {
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ai_apps_installed"));
  await page.locator(".empty-state .start-recent-item", { hasText: "產品筆記" }).click();
  await page.waitForFunction(() => document.querySelector("#folder-name").textContent === "產品筆記");
}

/** 「☰」→「專案」，在名稱是 `title` 的項目上按右鍵，回傳跳出來的選單。 */
async function rightClickInProjectMenu(page, title) {
  await page.evaluate(() => document.querySelector("#main-menu").click());
  const menu = page.locator("#main-menu-popover");
  await menu.locator(":scope > button", { hasText: "專案" }).click();
  const sub = menu.locator(":scope > .submenu:popover-open");
  await sub.locator(":scope > button", { hasText: title }).click({ button: "right" });
  const pin = page.locator("#pin-menu-anchor-popover");
  await pin.waitFor();
  return pin;
}

const shown = (page, sel) => page.locator(sel).first().isVisible();

test("右鍵釘到檔案面板上方：顯示在專案名稱旁邊，提示寫出哪個專案，按了在 Codex 開啟這個專案", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  await openProject(page);
  const pin = await rightClickInProjectMenu(page, "在 Codex 開啟這個專案");
  assert.deepEqual(await pin.locator("button").allTextContents(), ["釘到檔案面板上方", "釘到左側圖示列"]);
  await pin.getByRole("menuitem", { name: "釘到檔案面板上方" }).click();
  const button = page.locator("#files-head .head-pin[data-command='open-in-codex']");
  await button.waitFor();
  assert.equal(await button.getAttribute("aria-label"), "在 Codex 開啟「產品筆記」");
  // 釘了按鈕：滑鼠不在面板上時，新增檔案等三個按鈕藏起來，專案名稱才有位置；移上去就出現。
  await page.locator(".cm-content").focus();
  await page.mouse.move(900, 500);
  assert.equal(await shown(page, "#tree-new-file"), false);
  assert.equal(await shown(page, ".head-pin"), true);
  const before = await button.boundingBox();
  await page.hover("#panel-files .side-body");
  assert.equal(await shown(page, "#tree-new-file"), true);
  assert.deepEqual(await button.boundingBox(), before, "新增檔案等按鈕出現時，釘上去的按鈕不會移動（在最右邊）");
  await button.click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "project_open_codex"));
  assert.deepEqual((await calls(page)).find((c) => c.cmd === "project_open_codex").args, { path: ROOT });
  assert.deepEqual(errors, []);
  await context.close();
});

test("檔案面板上方的按鈕跟著專案：關閉專案後不見；右鍵可以移除，三個按鈕又一直顯示", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  await openProject(page);
  await (await rightClickInProjectMenu(page, "在 Claude Code 開啟這個專案")).getByRole("menuitem", { name: "釘到檔案面板上方" }).click();
  const button = page.locator("#files-head .head-pin[data-command='open-in-claude']");
  await button.waitFor();
  // 已經釘了：右鍵選單換成移除。
  const again = await rightClickInProjectMenu(page, "在 Claude Code 開啟這個專案");
  assert.deepEqual(await again.locator("button").allTextContents(), ["從檔案面板上方移除", "釘到左側圖示列"]);
  await page.keyboard.press("Escape");

  // 起始頁蓋在編輯區上：直接用快速鍵開指令面板。
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+Shift+P");
  await page.locator("dialog[open] input").first().fill("關閉專案");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#files-head").hidden);
  assert.equal(await shown(page, ".head-pin"), false, "沒開專案時看不到");
  await page.locator("#files-empty .files-project-list li > button", { hasText: "產品筆記" }).click();
  await button.waitFor();

  await button.click({ button: "right" });
  await page.locator("#pin-menu-anchor-popover").getByRole("menuitem", { name: "從檔案面板上方移除" }).click();
  await page.waitForFunction(() => !document.querySelector("#files-head .head-pin"));
  await page.locator(".cm-content").focus();
  await page.mouse.move(900, 500);
  assert.equal(await shown(page, "#tree-new-file"), true, "沒釘按鈕時照舊一直顯示");
  assert.deepEqual(errors, []);
  await context.close();
});

test("右鍵也能釘到左側圖示列；Codex、Claude Code 的圖示不一樣", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  await openProject(page);
  await (await rightClickInProjectMenu(page, "在 Codex 開啟這個專案")).getByRole("menuitem", { name: "釘到左側圖示列" }).click();
  await page.locator(".activity-cmd[data-command='open-in-codex']").waitFor();

  await page.evaluate(() => document.querySelector("#main-menu").click());
  const menu = page.locator("#main-menu-popover");
  await menu.locator(":scope > button", { hasText: "專案" }).click();
  const sub = menu.locator(":scope > .submenu:popover-open");
  const iconOf = (title) => sub.locator(":scope > button", { hasText: title }).locator("svg").first().getAttribute("data-icon");
  const codex = await iconOf("在 Codex 開啟這個專案");
  const claude = await iconOf("在 Claude Code 開啟這個專案");
  assert.ok(codex && claude && codex !== claude, `${codex} ${claude}`);
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  await context.close();
});
