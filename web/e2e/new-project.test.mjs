/**
 * 新專案：「專案」選單、起始頁、專案切換器、專案總覽都能開「新專案」對話框；
 * 名稱不能用的字元馬上提示、顯示會建立的路徑；建立後切換到新專案、存顏色、開啟 README.md。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const DOCS = "C:\\Users\\me\\Documents";
const PICKED = "D:\\筆記";
const ROOT = `${DOCS}\\產品筆記`;
const README = `${ROOT}\\README.md`;
const DESKTOP = {
  project_default_parent: DOCS,
  pick_project_parent: PICKED,
  create_project: { path: ROOT, name: "產品筆記" },
  project_update: { path: ROOT, name: "產品筆記", label: "產品筆記", color: "blue", group: null, pinned: false, lastOpened: 0 },
  list_dir: [[{ name: "README.md", path: README, isDir: false }]],
  reopen_file: { path: README, name: "README.md", text: "# 產品筆記\n", encoding: "utf-8" },
};

async function openFromMenu(page) {
  await page.click("#main-menu");
  const menu = page.locator("#main-menu-popover");
  await menu.locator(":scope > button", { hasText: "專案" }).click();
  const sub = menu.locator(":scope > .submenu:popover-open");
  await sub.waitFor();
  assert.equal((await sub.locator(":scope > button").first().textContent()).trim(), "新專案…");
  await sub.locator(":scope > button", { hasText: "新專案…" }).click();
  const dialog = page.locator("dialog.new-project[open]");
  await dialog.waitFor();
  return dialog;
}

test("專案 → 新專案…：名稱不能用的字元馬上提示；建立後切換到新專案、存顏色、開啟 README.md", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  const dialog = await openFromMenu(page);
  const name = dialog.getByRole("textbox", { name: "專案名稱" });
  const create = dialog.getByRole("button", { name: "建立並開啟" });
  assert.equal(await dialog.locator("input[name=parent]").inputValue(), DOCS);
  // 還沒輸入名稱：不能建立，也還不提示錯誤。
  assert.equal(await create.isDisabled(), true);
  assert.equal(await dialog.locator(".dav-error").isHidden(), true);
  await name.fill("產品:筆記");
  await dialog.locator(".dav-error", { hasText: "專案名稱不能有這些字元" }).waitFor();
  assert.equal(await create.isDisabled(), true);
  await name.fill("CON");
  await dialog.locator(".dav-error", { hasText: "Windows 保留的名稱" }).waitFor();
  await name.fill("產品筆記");
  assert.equal(await dialog.locator(".dav-error").isHidden(), true);
  assert.equal(await dialog.locator(".np-preview").textContent(), `會建立「${ROOT}」`);
  await dialog.getByLabel("筆記本：README.md、每日筆記、assets（圖片）資料夾").check();
  assert.equal(await dialog.getByLabel(/同時建立 Git 儲存庫/).isChecked(), true);
  await dialog.getByRole("radio", { name: "藍" }).check({ force: true });
  await create.click();
  await page.locator(".toast", { hasText: "已建立專案「產品筆記」" }).waitFor();
  assert.equal(await page.locator("dialog.new-project[open]").count(), 0);
  const all = await calls(page);
  assert.deepEqual(all.find((c) => c.cmd === "create_project").args, {
    parent: DOCS,
    name: "產品筆記",
    notebook: true,
    git: true,
    dailyFolder: "每日筆記",
  });
  assert.deepEqual(all.find((c) => c.cmd === "project_update").args, {
    path: ROOT,
    change: { name: null, color: "blue", group: null, pinned: false },
  });
  // 先存顏色，再切換專案、開 README.md。
  const order = all.map((c) => c.cmd);
  assert.ok(order.indexOf("project_update") < order.lastIndexOf("reopen_file"));
  assert.equal(all.filter((c) => c.cmd === "reopen_file").at(-1).args.path, README);
  await page.waitForFunction(() => document.querySelector(".tab[aria-selected=true] .tab-name")?.textContent?.includes("README.md"));
  assert.equal(await page.locator("#panel-files").isVisible(), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("新專案：「瀏覽…」換位置；建立失敗（資料夾已經存在）時留在對話框顯示原因", async () => {
  const exists = `「${PICKED}\\產品筆記」已經存在，換一個名稱或位置`;
  const { page, context, errors } = await open({ desktop: { ...DESKTOP, create_project: { $error: exists } } });
  const dialog = await openFromMenu(page);
  await dialog.getByRole("button", { name: "瀏覽…" }).click();
  await page.waitForFunction((p) => document.querySelector("dialog.new-project input[name=parent]")?.value === p, PICKED);
  await dialog.getByRole("textbox", { name: "專案名稱" }).fill("產品筆記");
  assert.equal(await dialog.locator(".np-preview").textContent(), `會建立「${PICKED}\\產品筆記」`);
  await dialog.getByLabel(/同時建立 Git 儲存庫/).uncheck();
  await dialog.getByRole("button", { name: "建立並開啟" }).click();
  await dialog.locator(".dav-error", { hasText: exists }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "建立並開啟" }).isDisabled(), false);
  const args = (await calls(page)).find((c) => c.cmd === "create_project").args;
  assert.equal(args.parent, PICKED);
  assert.equal(args.notebook, false);
  assert.equal(args.git, false);
  assert.equal((await calls(page)).some((c) => c.cmd === "project_update"), false);
  // 取消再打開：名稱清空、位置留著上次選的。
  await dialog.getByRole("button", { name: "取消" }).click();
  const again = await openFromMenu(page);
  assert.equal(await again.getByRole("textbox", { name: "專案名稱" }).inputValue(), "");
  assert.equal(await again.locator("input[name=parent]").inputValue(), PICKED);
  assert.deepEqual(errors, []);
  await context.close();
});

test("新專案的其他入口：起始頁、專案切換器、專案總覽", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  const dialog = page.locator("dialog.new-project[open]");
  await page.locator(".empty-state").getByRole("button", { name: "新專案…" }).click();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "取消" }).click();
  await page.keyboard.press("Control+Alt+P");
  const switcher = page.locator("dialog[open]");
  await switcher.locator("[role=option]", { hasText: "新 COMET 專案…" }).waitFor();
  await switcher.locator("[role=option]", { hasText: /^新專案…/ }).click();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "取消" }).click();
  await page.click("#main-menu");
  const menu = page.locator("#main-menu-popover");
  await menu.locator(":scope > button", { hasText: "專案" }).click();
  await menu.locator(":scope > .submenu:popover-open > button", { hasText: "專案總覽" }).click();
  const overview = page.locator("dialog.project-overview[open]");
  await overview.getByRole("button", { name: "新專案…" }).click();
  await dialog.waitFor();
  assert.equal(await overview.count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

/** 從「☰」→「專案」開「新 COMET 專案…」。 */
async function openComet(page) {
  await page.click("#main-menu");
  const menu = page.locator("#main-menu-popover");
  await menu.locator(":scope > button", { hasText: "專案" }).click();
  const sub = menu.locator(":scope > .submenu:popover-open");
  await sub.waitFor();
  assert.deepEqual((await sub.locator(":scope > button").allTextContents()).slice(0, 2), ["新專案…", "新 COMET 專案…"]);
  await sub.locator(":scope > button", { hasText: "新 COMET 專案…" }).click();
  const dialog = page.locator("dialog.new-project[open]");
  await dialog.waitFor();
  return dialog;
}

const cometSetups = async (page) =>
  (await calls(page)).filter((c) => c.cmd === "term_forward" && c.args.request.kind === "cometSetup").length;

test("新 COMET 專案：建立後在終端機執行 comet setup", async () => {
  const { page, context, errors } = await open({ desktop: { ...DESKTOP, comet_installed: true } });
  const dialog = await openComet(page);
  assert.equal(await dialog.locator("h2").textContent(), "新 COMET 專案");
  assert.equal(await dialog.getByLabel(/COMET 專案：/).isChecked(), true);
  assert.equal(await dialog.locator(".np-warn").isHidden(), true);
  await dialog.getByRole("textbox", { name: "專案名稱" }).fill("產品筆記");
  await dialog.getByRole("button", { name: "建立並開啟" }).click();
  await page.locator(".toast", { hasText: "請在下方的終端機照畫面的指示完成 comet setup" }).waitFor();
  const all = await calls(page);
  const created = all.find((c) => c.cmd === "create_project").args;
  assert.equal(created.notebook, false);
  assert.equal(created.git, true);
  // 先切換到新專案（終端機的工作目錄）、開 README.md，最後才執行 comet setup。
  const order = all.map((c) => c.cmd);
  assert.ok(order.lastIndexOf("reopen_file") < order.lastIndexOf("term_forward"));
  assert.equal(await cometSetups(page), 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test("新 COMET 專案：找不到 comet 指令時先提醒，專案照樣建立、不執行 comet setup", async () => {
  const { page, context, errors } = await open({ desktop: { ...DESKTOP, comet_installed: false } });
  const dialog = await openComet(page);
  await dialog.locator(".np-warn", { hasText: "這台電腦找不到 comet 指令" }).waitFor();
  // 換成空白就不提醒、標題換回「新專案」。
  await dialog.getByLabel("空白：只有一份 README.md").check();
  assert.equal(await dialog.locator("h2").textContent(), "新專案");
  assert.equal(await dialog.locator(".np-warn").isHidden(), true);
  await dialog.getByLabel(/COMET 專案：/).check();
  await dialog.locator(".np-warn").waitFor();
  await dialog.getByRole("textbox", { name: "專案名稱" }).fill("產品筆記");
  await dialog.getByRole("button", { name: "建立並開啟" }).click();
  await page.locator(".toast", { hasText: "裝好 COMET CLI 之後，在終端機執行 comet setup" }).waitFor();
  assert.ok((await calls(page)).some((c) => c.cmd === "create_project"));
  assert.equal(await cometSetups(page), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("網頁版沒有新專案", async () => {
  const { page, context, errors } = await open();
  await page.click("#main-menu");
  const menu = page.locator("#main-menu-popover");
  await menu.waitFor();
  assert.equal(await menu.getByText("新專案…").count(), 0);
  assert.equal(await menu.getByText("新 COMET 專案…").count(), 0);
  assert.equal(await page.locator(".empty-state").getByRole("button", { name: "新專案…" }).count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
