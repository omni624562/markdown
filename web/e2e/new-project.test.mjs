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
  // 這台電腦裝了 COMET（沒裝時不顯示「新 COMET 專案」，見最後面的測試）。
  comet_installed: true,
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
const setupRuns = async (page) => (await calls(page)).filter((c) => c.cmd === "comet_setup_run").map((c) => c.args.req);
/** 假的原生端送出 comet setup 的輸出與結果。 */
const emitSetup = (page, events) => page.evaluate((list) => list.forEach((e) => window.__fake.emit("comet-setup", e)), events);

/** 已經連線 Azure DevOps：專案、團隊、Sprint（每兩週一個，目前是 Sprint 12）。 */
const ADO = {
  ado_account: { url: "https://ado.test/tfs/DefaultCollection", name: "王小明", account: "CONTOSO\\wang" },
  ado_work_item_filters: { projects: ["產品", "Contoso"], kinds: [] },
  ado_teams: [[{ id: "t1", name: "產品團隊", default: true }, { id: "t2", name: "Contoso", default: false }]],
  ado_team_iterations: [
    [
      { id: "i11", name: "Sprint 11", path: "產品\\Sprint 11", start: "2026-10-19T00:00:00Z", finish: "2026-10-30T00:00:00Z", current: false },
      { id: "i12", name: "Sprint 12", path: "產品\\Sprint 12", start: "2026-11-02T00:00:00Z", finish: "2026-11-13T00:00:00Z", current: true },
      { id: "i13", name: "Sprint 13", path: "產品\\Sprint 13", start: "2026-11-16T00:00:00Z", finish: "2026-11-27T00:00:00Z", current: false },
    ],
  ],
  comet_installed: true,
};

test("新 COMET 專案：從 Azure DevOps 帶入設定，在對話框裡執行 comet setup，完成後列出建立的檔案", async () => {
  const { page, context, errors } = await open({ desktop: { ...DESKTOP, ...ADO } });
  const dialog = await openComet(page);
  assert.equal(await dialog.locator("h2").textContent(), "新 COMET 專案");
  // 專門的「新 COMET 專案」不列「一開始放什麼」。
  assert.equal(await dialog.locator(".np-content").isHidden(), true);
  const section = dialog.locator(".np-comet");
  await section.waitFor();
  await page.waitForFunction(() => document.querySelector("select[name=nc-sprint]")?.value === "i12");
  assert.equal(await section.locator("select[name=nc-project]").inputValue(), "產品");
  assert.equal(await section.locator("select[name=nc-team]").inputValue(), "t1");
  assert.equal(await section.locator("select[name=nc-sprint] option:checked").textContent(), "Sprint 12（目前）");
  // Sprint 天數：和下一個 Sprint 開始日相差 14 天。
  assert.equal(await section.locator("input[name=nc-cadence]").inputValue(), "14");
  assert.equal(await section.locator("input[name=nc-assigned]").inputValue(), "CONTOSO\\wang");
  await section.locator("select[name=nc-team]").selectOption("t2");
  await dialog.getByRole("textbox", { name: "專案名稱" }).fill("產品筆記");
  const create = dialog.getByRole("button", { name: "建立並設定" });
  await page.waitForFunction(() => !document.querySelector("dialog.new-project button[type=submit]")?.disabled);
  await create.click();
  const progress = dialog.locator(".np-progress");
  await progress.locator(".nc-steps li[data-state=run]", { hasText: "執行 comet setup" }).waitFor();
  assert.equal(await dialog.locator("form").isHidden(), true);
  assert.deepEqual(await setupRuns(page), [
    {
      dir: ROOT,
      assignedTo: "CONTOSO\\wang",
      cadenceDays: 14,
      connectionTest: true,
      localTools: true,
      collectionUrl: "https://ado.test/tfs/DefaultCollection",
      project: "產品",
      team: "Contoso",
      iterationPath: "產品\\Sprint 12",
      sprintNumber: 12,
    },
  ]);
  // 先切換到新專案、開 README.md，才執行 comet setup。
  const order = (await calls(page)).map((c) => c.cmd);
  assert.ok(order.lastIndexOf("reopen_file") < order.indexOf("comet_setup_run"));
  await emitSetup(page, [
    { kind: "line", text: "COMET setup" },
    { kind: "line", text: `已建立 / 更新：${ROOT}\\.comet.json` },
    { kind: "line", text: `已建立 / 更新：${ROOT}\\.comet\\contexts\\sprint-context.json` },
    { kind: "line", text: "查詢中：Sprint=產品\\Sprint 12" },
  ]);
  await progress.locator(".nc-steps li[data-state=run]", { hasText: "查詢我的工作" }).waitFor();
  assert.match(await progress.locator(".nc-log").textContent(), /COMET setup\n已建立 \/ 更新/);
  await emitSetup(page, [
    { kind: "line", text: `已產生 AGENTS.md（COMET bootstrap）：${ROOT}\\AGENTS.md` },
    { kind: "done", ok: true, code: 0, error: null },
  ]);
  await progress.locator(".nc-result.ok", { hasText: "「產品筆記」設定完成" }).waitFor();
  assert.deepEqual(await progress.locator(".nc-steps li").evaluateAll((li) => li.map((x) => x.dataset.state)), ["done", "done", "done", "done"]);
  assert.equal(await progress.locator(".nc-files pre").textContent(), ".comet.json\n.comet/contexts/sprint-context.json\nAGENTS.md");
  // 成功時輸出收起來，按一下才展開。
  assert.equal(await progress.locator(".nc-log").isHidden(), true);
  await progress.getByRole("button", { name: "顯示完整輸出" }).click();
  assert.equal(await progress.locator(".nc-log").isVisible(), true);
  assert.equal(await progress.getByRole("button", { name: "開啟 AGENTS.md" }).count(), 1);
  await progress.getByRole("button", { name: "完成" }).click();
  assert.equal(await page.locator("dialog.new-project[open]").count(), 0);
  assert.equal(await cometSetups(page), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("新 COMET 專案：對話框改成橫的；名稱很長的團隊也不會撐出框外；Sprint 名稱沒有編號時改傳工作板網址", async () => {
  const longTeam = "產品團隊（很長很長的團隊名稱，用來確認選單不會撐出框外）";
  const { page, context, errors } = await open({
    desktop: {
      ...DESKTOP,
      ...ADO,
      ado_teams: [[{ id: "t1", name: longTeam, default: true }]],
      ado_team_iterations: [[{ id: "r1", name: "發佈衝刺", path: "產品\\Release\\發佈衝刺", start: null, finish: null, current: true }]],
    },
  });
  const dialog = await openComet(page);
  await page.waitForFunction(() => document.querySelector("select[name=nc-sprint]")?.value === "r1");
  const box = await page.evaluate(() => {
    const d = document.querySelector("dialog.new-project").getBoundingClientRect();
    const section = document.querySelector(".np-comet").getBoundingClientRect();
    const fields = [...document.querySelectorAll(".np-comet select, .np-comet input:not([type=checkbox])")].map((el) => el.getBoundingClientRect().right);
    const name = document.querySelector("input[name=name]").getBoundingClientRect();
    return { width: d.width, height: d.height, sectionRight: section.right, maxField: Math.max(...fields), sectionLeft: section.left, nameRight: name.right };
  });
  // 橫的：比高還寬，COMET 設定在右邊一欄，欄位都在框裡。
  assert.ok(box.width > box.height, JSON.stringify(box));
  assert.ok(box.sectionLeft > box.nameRight, JSON.stringify(box));
  assert.ok(box.maxField <= box.sectionRight, JSON.stringify(box));
  await dialog.getByRole("textbox", { name: "專案名稱" }).fill("產品筆記");
  await dialog.getByRole("button", { name: "建立並設定" }).click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "comet_setup_run"));
  const [req] = await setupRuns(page);
  assert.equal(req.sprintUrl, `https://ado.test/tfs/DefaultCollection/${encodeURIComponent("產品")}/_sprints/taskboard/${encodeURIComponent(longTeam)}/${["產品", "Release", "發佈衝刺"].map(encodeURIComponent).join("/")}`);
  assert.equal(req.sprintNumber, undefined);
  assert.equal(req.project, undefined);
  assert.deepEqual(errors, []);
  await context.close();
});

test("新 COMET 專案：comet setup 失敗時說原因，可以改在終端機一問一答", async () => {
  const { page, context, errors } = await open({ desktop: { ...DESKTOP, ...ADO } });
  const dialog = await openComet(page);
  await page.waitForFunction(() => document.querySelector("select[name=nc-sprint]")?.value === "i12");
  await dialog.getByRole("textbox", { name: "專案名稱" }).fill("產品筆記");
  await dialog.getByRole("button", { name: "建立並設定" }).click();
  const progress = dialog.locator(".np-progress");
  await progress.locator(".nc-steps").waitFor();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "comet_setup_run"));
  await emitSetup(page, [
    { kind: "line", text: "找不到使用者 CONTOSO\\wang" },
    { kind: "done", ok: false, code: 1, error: null },
  ]);
  await progress.locator(".nc-result.fail", { hasText: "comet setup 沒有完成（結束代碼 1）" }).waitFor();
  // 失敗時輸出留著，看得到原因。
  assert.equal(await progress.locator(".nc-log").isVisible(), true);
  assert.equal(await progress.locator(".nc-steps li[data-state=fail]").textContent(), "執行 comet setup");
  await progress.getByRole("button", { name: "在終端機重試" }).click();
  assert.equal(await page.locator("dialog.new-project[open]").count(), 0);
  assert.equal(await cometSetups(page), 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test("新 COMET 專案：在背景繼續，完成時用通知告訴使用者；再打開看得到結果", async () => {
  const { page, context, errors } = await open({ desktop: { ...DESKTOP, ...ADO } });
  const dialog = await openComet(page);
  await page.waitForFunction(() => document.querySelector("select[name=nc-sprint]")?.value === "i12");
  await dialog.getByRole("textbox", { name: "專案名稱" }).fill("產品筆記");
  await dialog.getByRole("button", { name: "建立並設定" }).click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "comet_setup_run"));
  await dialog.locator(".np-progress").getByRole("button", { name: "在背景繼續" }).click();
  assert.equal(await page.locator("dialog.new-project[open]").count(), 0);
  await emitSetup(page, [{ kind: "done", ok: true, code: 0, error: null }]);
  const toastEl = page.locator(".toast", { hasText: "「產品筆記」的 COMET 設定完成" });
  await toastEl.waitFor();
  await toastEl.getByRole("button", { name: "查看" }).click();
  await page.locator("dialog.new-project[open] .nc-result.ok").waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test("新 COMET 專案：oMarker 沒有連線 Azure DevOps 時貼上 Sprint 網址", async () => {
  const { page, context, errors } = await open({ desktop: { ...DESKTOP, comet_installed: true } });
  const dialog = await openComet(page);
  const section = dialog.locator(".np-comet");
  await section.locator(".nc-url").waitFor();
  assert.equal(await section.locator(".nc-ado").isHidden(), true);
  await dialog.getByRole("textbox", { name: "專案名稱" }).fill("產品筆記");
  const create = dialog.getByRole("button", { name: "建立並設定" });
  // 網址與指派給都要填。
  assert.equal(await create.isDisabled(), true);
  await section.locator("input[name=nc-url]").fill("https://ado.test/tfs/DefaultCollection/產品/_sprints/taskboard/Contoso/產品/Sprint%2012");
  assert.equal(await create.isDisabled(), true);
  await section.locator("input[name=nc-assigned]").fill("王小明");
  await section.locator("input[name=nc-smoke]").uncheck();
  assert.equal(await create.isDisabled(), false);
  await create.click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "comet_setup_run"));
  assert.deepEqual(await setupRuns(page), [
    {
      dir: ROOT,
      assignedTo: "王小明",
      cadenceDays: 14,
      connectionTest: false,
      localTools: true,
      sprintUrl: "https://ado.test/tfs/DefaultCollection/產品/_sprints/taskboard/Contoso/產品/Sprint%2012",
    },
  ]);
  // 沒勾「查詢我的工作」就沒有那一步。
  assert.deepEqual(await dialog.locator(".nc-steps li").allTextContents(), ["建立資料夾與 README.md", "建立 Git 儲存庫", "執行 comet setup"]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("沒裝 COMET 的電腦不顯示「新 COMET 專案」；開著 oMarker 時裝好，再打開就會出現", async () => {
  // 第一次（啟動時）找不到，之後找得到（使用者在 oMarker 開著的時候裝好 COMET）。
  const { page, context, errors } = await open({ desktop: { ...DESKTOP, comet_installed: [false, true] } });
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "comet_installed"));
  // 「☰」→「專案」沒有。
  await page.click("#main-menu");
  const menu = page.locator("#main-menu-popover");
  await menu.locator(":scope > button", { hasText: "專案" }).click();
  const sub = menu.locator(":scope > .submenu:popover-open");
  await sub.waitFor();
  assert.equal(await sub.locator(":scope > button", { hasText: "新 COMET 專案…" }).count(), 0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // 專案切換器的「動作」沒有。
  await page.keyboard.press("Control+Alt+P");
  const switcher = page.locator("dialog[open]");
  await switcher.locator("[role=option]", { hasText: /^新專案…/ }).waitFor();
  assert.equal(await switcher.locator("[role=option]", { hasText: "新 COMET 專案…" }).count(), 0);
  // 從切換器開「新專案…」：先照上次的結果不列「COMET 專案」，重新檢查後找到了就列出來。
  await switcher.locator("[role=option]", { hasText: /^新專案…/ }).click();
  const dialog = page.locator("dialog.new-project[open]");
  await dialog.waitFor();
  const cometChoice = dialog.getByLabel(/COMET 專案：/);
  await cometChoice.waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: "取消" }).click();
  // 這時「☰」→「專案」也有了。
  await page.click("#main-menu");
  await menu.locator(":scope > button", { hasText: "專案" }).click();
  await sub.waitFor();
  await sub.locator(":scope > button", { hasText: "新 COMET 專案…" }).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test("新專案對話框：沒裝 COMET 時不列「COMET 專案」", async () => {
  const { page, context, errors } = await open({ desktop: { ...DESKTOP, comet_installed: false } });
  const dialog = await openFromMenu(page);
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "comet_installed").length >= 2);
  assert.equal(await dialog.getByLabel(/COMET 專案：/).isHidden(), true);
  assert.equal(await dialog.getByLabel("空白：只有一份 README.md").isChecked(), true);
  assert.equal(await dialog.locator("h2").textContent(), "新專案");
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
