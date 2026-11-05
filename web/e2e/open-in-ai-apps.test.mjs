/**
 * 在 AI 桌面版開啟專案：「☰」→「專案」、指令面板與切換專案的「動作」都有「在 Codex 開啟這個專案」
 * 「在 Claude Code 開啟這個專案」，交給原生端的是目前專案的資料夾（原生端組成 codex://threads/new?path=…、
 * claude://code/new?folder=… 交給系統開啟）；失敗時顯示原因。原生端說沒有安裝（ai_apps_installed）的就不顯示。
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
  list_dir: [[]],
  ai_apps_installed: { codex: true, claude: true },
};
const CODEX = "在 Codex 開啟這個專案";
const CLAUDE = "在 Claude Code 開啟這個專案";

async function openProject(page) {
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ai_apps_installed"));
  await page.locator(".empty-state .start-recent-item", { hasText: "產品筆記" }).click();
  await page.waitForFunction(() => document.querySelector("#folder-name").textContent === "產品筆記");
}

async function projectMenu(page) {
  await page.evaluate(() => document.querySelector("#main-menu").click());
  const menu = page.locator("#main-menu-popover");
  await menu.locator(":scope > button", { hasText: "專案" }).click();
  const sub = menu.locator(":scope > .submenu:popover-open");
  await sub.waitFor();
  return sub;
}

/** 「☰」→「專案」子選單的項目。 */
async function projectMenuItems(page) {
  const sub = await projectMenu(page);
  const items = await sub.locator(":scope > button").allTextContents();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  return items;
}

/** 專案切換器「動作」裡的項目。 */
async function switcherActions(page) {
  await page.keyboard.press("Control+Alt+P");
  const switcher = page.locator("dialog[open]");
  await switcher.locator("[role=option]", { hasText: "關閉專案" }).waitFor();
  const titles = await switcher.locator("[role=option] .palette-title").allTextContents();
  await page.keyboard.press("Escape");
  return titles;
}

/** 指令面板搜尋「開啟這個專案」的結果。 */
async function paletteMatches(page) {
  await page.keyboard.press("Control+Shift+P");
  await page.locator("dialog[open] input").first().fill("開啟這個專案");
  const titles = await page.locator("dialog[open] [role=option] .palette-title").allTextContents();
  await page.keyboard.press("Escape");
  return titles;
}

test("「☰」→「專案」→「在 Codex／Claude Code 開啟這個專案」：把目前專案的資料夾交給原生端", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  // 還沒開專案時沒有這兩項。
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ai_apps_installed"));
  let items = await projectMenuItems(page);
  assert.ok(!items.includes(CODEX) && !items.includes(CLAUDE), items.join("、"));
  await openProject(page);
  // 「在 Claude Code 開啟這個專案」緊接在 Codex 後面。
  items = await projectMenuItems(page);
  assert.equal(items[items.indexOf(CODEX) + 1], CLAUDE, items.join("、"));
  let sub = await projectMenu(page);
  await sub.locator(":scope > button", { hasText: CODEX }).click();
  await page.locator(".toast", { hasText: "正在用 Codex 開啟「產品筆記」" }).waitFor();
  sub = await projectMenu(page);
  await sub.locator(":scope > button", { hasText: CLAUDE }).click();
  await page.locator(".toast", { hasText: "正在用 Claude 開啟「產品筆記」" }).waitFor();
  const opened = (await calls(page)).filter((c) => c.cmd === "project_open_codex" || c.cmd === "project_open_claude");
  assert.deepEqual(opened, [
    { cmd: "project_open_codex", args: { path: ROOT } },
    { cmd: "project_open_claude", args: { path: ROOT } },
  ]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("切換專案的「動作」與指令面板也有；原生端失敗時顯示原因", async () => {
  const { page, context, errors } = await open({
    desktop: { ...DESKTOP, project_open_codex: { $error: "無法開啟 Codex 桌面版（請確認已經安裝）：找不到程式" } },
  });
  await openProject(page);
  assert.deepEqual(await paletteMatches(page), [CODEX, CLAUDE]);
  await page.keyboard.press("Control+Alt+P");
  await page.locator("dialog[open] [role=option]", { hasText: CODEX }).click();
  await page.locator(".toast", { hasText: "無法開啟 Codex 桌面版（請確認已經安裝）" }).waitFor();
  assert.equal(await page.locator(".toast", { hasText: "正在用 Codex 開啟" }).count(), 0);
  await page.keyboard.press("Control+Alt+P");
  await page.locator("dialog[open] [role=option]", { hasText: CLAUDE }).click();
  await page.locator(".toast", { hasText: "正在用 Claude 開啟「產品筆記」" }).waitFor();
  const claude = (await calls(page)).filter((c) => c.cmd === "project_open_claude");
  assert.deepEqual(claude.map((c) => c.args), [{ path: ROOT }]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("沒裝的桌面版不顯示：「☰」→「專案」、切換專案、指令面板都沒有", async () => {
  const { page, context, errors } = await open({ desktop: { ...DESKTOP, ai_apps_installed: { codex: false, claude: false } } });
  await openProject(page);
  const items = await projectMenuItems(page);
  assert.ok(items.includes("專案總覽"), items.join("、"));
  assert.ok(!items.includes(CODEX) && !items.includes(CLAUDE), items.join("、"));
  const actions = await switcherActions(page);
  assert.ok(actions.includes("專案總覽"), actions.join("、"));
  assert.ok(!actions.includes(CODEX) && !actions.includes(CLAUDE), actions.join("、"));
  assert.deepEqual(await paletteMatches(page), []);
  assert.deepEqual(errors, []);
  await context.close();
});

test("只裝了其中一個：只顯示那一個", async () => {
  const { page, context, errors } = await open({ desktop: { ...DESKTOP, ai_apps_installed: { codex: false, claude: true } } });
  await openProject(page);
  const items = await projectMenuItems(page);
  assert.ok(!items.includes(CODEX) && items.includes(CLAUDE), items.join("、"));
  const actions = await switcherActions(page);
  assert.ok(!actions.includes(CODEX) && actions.includes(CLAUDE), actions.join("、"));
  assert.deepEqual(await paletteMatches(page), [CLAUDE]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("原生端沒有回應（舊版或查不到）時當成沒有安裝，也不會出錯", async () => {
  const { ai_apps_installed: _, ...desktop } = DESKTOP;
  const { page, context, errors } = await open({ desktop });
  await openProject(page);
  const items = await projectMenuItems(page);
  assert.ok(!items.includes(CODEX) && !items.includes(CLAUDE), items.join("、"));
  const actions = await switcherActions(page);
  assert.ok(!actions.includes(CODEX) && !actions.includes(CLAUDE), actions.join("、"));
  assert.deepEqual(errors, []);
  await context.close();
});
