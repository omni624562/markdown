/**
 * 刪除專案：專案總覽的卡片、「☰」→「專案」→「刪除專案…」。提示窗要輸入專案的資料夾名稱才能刪除；
 * 可以勾選同時把資料夾移到資源回收筒；目前開著的專案先關閉再刪。用假的原生端（見 helpers.mjs）。
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

test("專案總覽：刪除要輸入資料夾名稱；勾選後資料夾移到資源回收筒", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  const overview = await openOverview(page);
  const card = overview.locator(".po-card", { hasText: "鈷藍計畫" });
  // 刪除按鈕有文字，滑鼠不用移上去也看得到。
  const del = card.locator(".po-delete");
  assert.equal((await del.textContent()).trim(), "刪除");
  assert.equal(await del.isVisible(), true);
  await del.click();
  const dialog = page.locator("dialog.project-delete[open]");
  await dialog.waitFor();
  assert.equal(await dialog.locator(".pd-lead").textContent(), "「鈷藍計畫」會從專案清單移除。");
  assert.match(await dialog.locator(".pd-type").textContent(), /請輸入專案的資料夾名稱「cobalt」確認刪除/);
  const submit = dialog.getByRole("button", { name: "刪除" });
  assert.equal(await submit.isDisabled(), true);
  await dialog.locator("input[name=confirm]").fill("cobal");
  assert.equal(await submit.isDisabled(), true);
  await dialog.getByLabel(/同時把資料夾移到資源回收筒/).check();
  assert.match(await dialog.locator(".pd-note").textContent(), /都會移到資源回收筒/);
  await dialog.locator("input[name=confirm]").fill(" cobalt ");
  assert.equal(await submit.isDisabled(), false);
  await submit.click();
  await page.locator(".toast", { hasText: "已刪除專案「鈷藍計畫」，資料夾移到資源回收筒了" }).waitFor();
  assert.deepEqual((await calls(page)).filter((c) => c.cmd === "project_delete").map((c) => c.args), [
    { path: "C:\\work\\cobalt", trashFolder: true },
  ]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("刪除失敗（例如沒有資源回收筒）時留在提示窗說原因", async () => {
  const { page, context, errors } = await open({ desktop: { ...DESKTOP, project_delete: { $error: "無法把資料夾移到資源回收筒：找不到回收筒" } } });
  const overview = await openOverview(page);
  await overview.locator(".po-card", { hasText: "notes" }).locator(".po-delete").click();
  const dialog = page.locator("dialog.project-delete[open]");
  await dialog.getByLabel(/同時把資料夾移到資源回收筒/).check();
  await dialog.locator("input[name=confirm]").fill("notes");
  await dialog.getByRole("button", { name: "刪除" }).click();
  await dialog.locator(".dav-error", { hasText: "找不到回收筒" }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "刪除" }).isDisabled(), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test("「☰」→「專案」→「刪除專案…」刪除目前的專案：先關閉，只從清單移除", async () => {
  const { page, context, errors } = await open({
    desktop: { ...DESKTOP, startup_target: { kind: "folder", path: "C:\\work\\notes", name: "notes" }, list_dir: [[]] },
  });
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "projects_list"));
  await page.click("#main-menu");
  const menu = page.locator("#main-menu-popover");
  await menu.locator(":scope > button", { hasText: "專案" }).click();
  const sub = menu.locator(":scope > .submenu:popover-open");
  await sub.locator(":scope > button", { hasText: "刪除專案…" }).click();
  const dialog = page.locator("dialog.project-delete[open]");
  await dialog.waitFor();
  assert.match(await dialog.locator(".pd-note").textContent(), /這是目前開著的專案，會先關閉。/);
  // 不分大小寫。
  await dialog.locator("input[name=confirm]").fill("NOTES");
  await dialog.getByRole("button", { name: "刪除" }).click();
  await page.locator(".toast", { hasText: "已把「notes」從專案清單移除" }).waitFor();
  const order = (await calls(page)).map((c) => c.cmd);
  assert.ok(order.includes("close_folder"));
  assert.ok(order.lastIndexOf("close_folder") < order.indexOf("project_delete"));
  assert.deepEqual((await calls(page)).filter((c) => c.cmd === "project_delete").map((c) => c.args), [
    { path: "C:\\work\\notes", trashFolder: false },
  ]);
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
