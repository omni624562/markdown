/**
 * 刪除專案：專案總覽的卡片、「☰」→「專案」→「刪除專案…」。只問一次，用系統的對話框（project_delete_ask，
 * 勾選框「同時把資料夾移到資源回收筒」也在裡面）；答應了才關閉開著的專案再刪。用假的原生端（見 helpers.mjs）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const project = (path, label, extra = {}) => ({ path, label, name: label, color: null, group: null, pinned: false, lastOpened: 0, ...extra });
const PROJECTS = [project("C:\\work\\cobalt", "鈷藍計畫"), project("C:\\work\\notes", "notes")];
const DESKTOP = { projects_list: [PROJECTS], recent: { files: [], folders: PROJECTS.map((p) => p.path) } };

async function openOverview(page) {
  await page.click("#main-menu");
  const menu = page.locator("#main-menu-popover");
  await menu.locator(":scope > button", { hasText: "專案" }).click();
  await menu.locator(":scope > .submenu:popover-open > button", { hasText: "專案總覽" }).click();
  const overview = page.locator("dialog.project-overview[open]");
  await overview.waitFor();
  return overview;
}

const askArgs = async (page) => (await calls(page)).filter((c) => c.cmd === "project_delete_ask").map((c) => c.args);
const deleteArgs = async (page) => (await calls(page)).filter((c) => c.cmd === "project_delete").map((c) => c.args);

test("專案總覽：刪除只問一次（系統的對話框，勾選框在裡面）；勾了就移到資源回收筒，下次記住這個選擇", async () => {
  // 假的原生端：使用者在系統的對話框按「刪除」並勾了「同時把資料夾移到資源回收筒」。
  const { page, context, errors } = await open({ desktop: { ...DESKTOP, project_delete_ask: true } });
  const overview = await openOverview(page);
  const card = overview.locator(".po-card", { hasText: "鈷藍計畫" });
  // 刪除按鈕有文字，滑鼠不用移上去也看得到。
  const del = card.locator(".po-delete");
  assert.equal((await del.textContent()).trim(), "刪除");
  assert.equal(await del.isVisible(), true);
  await del.click();
  await page.locator(".toast", { hasText: "已刪除專案「鈷藍計畫」，資料夾移到資源回收筒了" }).waitFor();
  // 網頁沒有自己的提示窗（不用輸入名稱）；勾選框第一次預設不勾。
  assert.equal(await page.locator("dialog.project-delete").count(), 0);
  assert.deepEqual(await askArgs(page), [{ path: "C:\\work\\cobalt", trash: false, unsaved: false }]);
  assert.deepEqual(await deleteArgs(page), [{ path: "C:\\work\\cobalt", trashFolder: true }]);
  // 下一次：勾選框預設是上次的選擇。
  await overview.locator(".po-card", { hasText: "notes" }).locator(".po-delete").click();
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "project_delete_ask").length === 2);
  assert.equal((await askArgs(page))[1].trash, true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("在系統的對話框按「取消」：什麼都不做", async () => {
  const { page, context, errors } = await open({ desktop: { ...DESKTOP, project_delete_ask: null } });
  const overview = await openOverview(page);
  await overview.locator(".po-card", { hasText: "notes" }).locator(".po-delete").click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "project_delete_ask"));
  await page.waitForTimeout(200);
  assert.deepEqual(await deleteArgs(page), []);
  assert.equal(await page.locator(".toast", { hasText: /已刪除專案|從專案清單移除/ }).count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("刪除失敗（例如沒有資源回收筒）時說原因", async () => {
  const { page, context, errors } = await open({
    desktop: { ...DESKTOP, project_delete_ask: true, project_delete: { $error: "無法把資料夾移到資源回收筒：找不到回收筒" } },
  });
  const overview = await openOverview(page);
  await overview.locator(".po-card", { hasText: "notes" }).locator(".po-delete").click();
  await page.locator(".toast", { hasText: "找不到回收筒" }).waitFor();
  assert.equal(await page.locator(".toast", { hasText: /已刪除專案/ }).count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("「☰」→「專案」→「刪除專案…」刪除目前的專案：按了「刪除」才關閉專案，只從清單移除", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ...DESKTOP,
      project_delete_ask: false,
      startup_target: { kind: "folder", path: "C:\\work\\notes", name: "notes" },
      list_dir: [[]],
    },
  });
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "projects_list"));
  await page.click("#main-menu");
  const menu = page.locator("#main-menu-popover");
  await menu.locator(":scope > button", { hasText: "專案" }).click();
  const sub = menu.locator(":scope > .submenu:popover-open");
  await sub.locator(":scope > button", { hasText: "刪除專案…" }).click();
  await page.locator(".toast", { hasText: "已把「notes」從專案清單移除" }).waitFor();
  const order = (await calls(page)).map((c) => c.cmd);
  // 先問，答應了才關閉專案，再刪。
  assert.ok(order.indexOf("project_delete_ask") < order.lastIndexOf("close_folder"));
  assert.ok(order.lastIndexOf("close_folder") < order.indexOf("project_delete"));
  assert.deepEqual(await deleteArgs(page), [{ path: "C:\\work\\notes", trashFolder: false }]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("沒有開資料夾時「專案」選單沒有「刪除專案…」", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  await page.click("#main-menu");
  const menu = page.locator("#main-menu-popover");
  await menu.locator(":scope > button", { hasText: "專案" }).click();
  const sub = menu.locator(":scope > .submenu:popover-open");
  await sub.waitFor();
  assert.equal(await sub.getByText("刪除專案…").count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
