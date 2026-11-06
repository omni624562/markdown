/**
 * 已經有的專案設定成 COMET 專案：「☰」→「專案」→「設定成 COMET 專案…」只有「COMET 設定」一張，
 * 在專案資料夾執行 comet setup（沒有建立資料夾、Git 儲存庫這兩步），完成後重新讀專案清單。
 * 已經是 COMET 專案時是「重新設定 COMET…」；這台電腦沒有 COMET 時兩個都不出現。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\產品筆記";
const project = (comet) => ({ path: ROOT, label: "產品筆記", name: null, color: "blue", group: null, pinned: false, lastOpened: 0, comet });
const desktop = (comet, extra = {}) => ({
  projects_list: [[project(comet)]],
  reopen_folder: { path: ROOT, name: "產品筆記" },
  list_dir: [[]],
  comet_installed: true,
  ...extra,
});

async function openProject(page) {
  await page.locator(".empty-state .start-recent-item", { hasText: "產品筆記" }).click();
  await page.waitForFunction(() => document.querySelector("#folder-name").textContent === "產品筆記");
}

/** 「☰」→「專案」子選單的項目名稱。 */
async function projectMenu(page) {
  await page.evaluate(() => document.querySelector("#main-menu").click());
  const menu = page.locator("#main-menu-popover");
  await menu.locator(":scope > button", { hasText: "專案" }).click();
  const sub = menu.locator(":scope > .submenu:popover-open");
  await sub.waitFor();
  return sub;
}

const projectCalls = async (page) => (await calls(page)).filter((c) => c.cmd === "projects_list").length;

test("設定成 COMET 專案：只有 COMET 設定一張，在專案資料夾執行 comet setup，完成後重新讀專案清單", async () => {
  const { page, context, errors } = await open({ desktop: desktop(false) });
  await openProject(page);
  const sub = await projectMenu(page);
  const items = await sub.locator(":scope > button").allTextContents();
  assert.ok(items.includes("設定成 COMET 專案…"), items.join("|"));
  assert.ok(!items.includes("重新設定 COMET…"));
  await sub.locator(":scope > button", { hasText: "設定成 COMET 專案…" }).click();

  const dialog = page.locator("dialog.comet-only[open]");
  await dialog.waitFor();
  assert.equal(await dialog.locator("#cp-title").textContent(), "設定成 COMET 專案");
  assert.equal(await dialog.locator(".cp-hint").textContent(), "在「產品筆記」資料夾執行 comet setup，設定好就是 COMET 專案。");
  assert.equal(await dialog.locator(".cp-warn").isVisible(), false);
  // 沒有新專案的「① 專案」那一張，只有 COMET 設定。
  assert.equal(await dialog.locator(".np-card").count(), 1);
  const start = dialog.getByRole("button", { name: "開始設定" });
  // oMarker 沒有連線 Azure DevOps：貼上 Sprint 網址、填指派給才能按。
  await dialog.locator("input[name=nc-url]").waitFor();
  assert.equal(await start.isDisabled(), true);
  await dialog.locator("input[name=nc-url]").fill("https://ado.test/tfs/DefaultCollection/產品/_sprints/taskboard/Contoso/產品/Sprint%2012");
  await dialog.locator("input[name=nc-assigned]").fill("王小明");
  await dialog.locator("input[name=nc-smoke]").uncheck();
  assert.equal(await start.isDisabled(), false);
  await start.click();

  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "comet_setup_run"));
  const req = (await calls(page)).find((c) => c.cmd === "comet_setup_run").args.req;
  assert.equal(req.dir, ROOT);
  assert.equal(req.assignedTo, "王小明");
  const progress = dialog.locator(".np-progress");
  // 已經有資料夾：只有執行 comet setup 這一步。
  assert.deepEqual(await progress.locator(".nc-steps li").allTextContents(), ["執行 comet setup"]);
  const before = await projectCalls(page);
  await page.evaluate(() => window.__fake.emit("comet-setup", { kind: "done", ok: true, code: 0, error: null }));
  await progress.locator(".nc-badge[data-state=ok]").waitFor();
  assert.equal(await progress.locator("#nc-title").textContent(), "「產品筆記」設定好了");
  assert.equal(await progress.locator(".nc-hint").textContent(), "已經是 COMET 專案了。");
  // 完成後重新讀專案清單（名稱旁邊的 COMET 小標籤、選單跟著更新）。
  await page.waitForFunction((n) => window.__fake.calls.filter((c) => c.cmd === "projects_list").length > n, before);
  await dialog.getByRole("button", { name: "完成" }).click();
  assert.deepEqual(errors, []);
  await context.close();
});

test("已經是 COMET 專案：選單是「重新設定 COMET…」，對話框說明會再執行一次", async () => {
  const { page, context, errors } = await open({ desktop: desktop(true) });
  await openProject(page);
  const sub = await projectMenu(page);
  const items = await sub.locator(":scope > button").allTextContents();
  assert.ok(items.includes("重新設定 COMET…"), items.join("|"));
  assert.ok(!items.includes("設定成 COMET 專案…"));
  await sub.locator(":scope > button", { hasText: "重新設定 COMET…" }).click();
  const dialog = page.locator("dialog.comet-only[open]");
  await dialog.waitFor();
  assert.equal(await dialog.locator("#cp-title").textContent(), "重新設定 COMET");
  assert.match(await dialog.locator(".cp-hint").textContent(), /再執行一次 comet setup/);
  // 提醒 comet 可能會改寫它產生的檔案（例如 AGENTS.md）。
  assert.match(await dialog.locator(".cp-warn").textContent(), /可能會依新的規則更新 AGENTS\.md/);
  assert.equal(await dialog.locator(".cp-warn").isVisible(), true);
  await dialog.getByRole("button", { name: "取消" }).click();
  assert.deepEqual(errors, []);
  await context.close();
});

test("這台電腦沒有 COMET：選單沒有設定 COMET 的項目", async () => {
  const { page, context, errors } = await open({ desktop: desktop(false, { comet_installed: false }) });
  await openProject(page);
  const sub = await projectMenu(page);
  const items = await sub.locator(":scope > button").allTextContents();
  assert.ok(!items.some((s) => s.includes("COMET")), items.join("|"));
  assert.deepEqual(errors, []);
  await context.close();
});
