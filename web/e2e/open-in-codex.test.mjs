/**
 * 在 Codex 桌面版開啟專案：「☰」→「專案」與切換專案的「動作」都有「在 Codex 開啟這個專案」，
 * 交給原生端的是目前專案的資料夾（原生端組成 codex://threads/new?path=… 交給系統開啟）；失敗時顯示原因。
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
};

async function openProject(page) {
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

test("「☰」→「專案」→「在 Codex 開啟這個專案」：把目前專案的資料夾交給原生端", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  // 還沒開專案時沒有這一項。
  let sub = await projectMenu(page);
  assert.equal(await sub.locator(":scope > button", { hasText: "在 Codex 開啟這個專案" }).count(), 0);
  await page.keyboard.press("Escape");
  await openProject(page);
  sub = await projectMenu(page);
  await sub.locator(":scope > button", { hasText: "在 Codex 開啟這個專案" }).click();
  await page.locator(".toast", { hasText: "正在用 Codex 開啟「產品筆記」" }).waitFor();
  const call = (await calls(page)).filter((c) => c.cmd === "project_open_codex");
  assert.deepEqual(call.map((c) => c.args), [{ path: ROOT }]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("切換專案的「動作」也有；原生端失敗時顯示原因", async () => {
  const { page, context, errors } = await open({
    desktop: { ...DESKTOP, project_open_codex: { $error: "無法開啟 Codex 桌面版（請確認已經安裝）：找不到程式" } },
  });
  await openProject(page);
  await page.keyboard.press("Control+Alt+P");
  await page.locator(".palette [role=option]", { hasText: "在 Codex 開啟這個專案" }).click();
  await page.locator(".toast", { hasText: "無法開啟 Codex 桌面版（請確認已經安裝）" }).waitFor();
  assert.equal(await page.locator(".toast", { hasText: "正在用 Codex 開啟" }).count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
