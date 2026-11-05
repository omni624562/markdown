/**
 * 專案與最近開啟：起始頁和檔案面板（沒開資料夾時）的「專案」是同一份清單、同樣的順序（最近開啟的在前），
 * 用自訂的名稱與顏色；「最近開啟的檔案…」只列檔案、放在「⋯」第一層；「⋯」→「專案」只留常用的項目，
 * 檔案面板標題列不再有第二個「⋯」。「下載儲存庫」的 GitHub、Azure DevOps 在還沒登入／還沒連線時名稱右邊註明狀態，
 * 登入、連線後改成帳號名稱。用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const project = (path, label, color = null, extra = {}) => ({ path, label, name: label, color, group: null, pinned: false, lastOpened: 0, ...extra });
/** 原生端的清單：最近開啟的在前（釘選、有群組的也照這個順序）。 */
const PROJECTS = [
  project("C:\\work\\cobalt", "鈷藍計畫", "blue"),
  project("C:\\work\\notes", "notes"),
  project("C:\\work\\pinned", "釘選的專案", "red", { pinned: true }),
  project("C:\\work\\grouped", "有群組的", "green", { group: "公司" }),
  project("C:\\work\\old", "很久沒開"),
];
const FILES = ["C:\\work\\cobalt\\README.md", "C:\\work\\notes\\週報.md"];
const DESKTOP = {
  // 陣列是依序回應的清單，所以專案清單要再包一層。
  projects_list: [PROJECTS],
  recent: { files: FILES, folders: PROJECTS.map((p) => p.path) },
  comet_installed: true,
};

test("起始頁的「專案」：自訂名稱與顏色、最近開啟的 4 個，「全部專案…」開啟專案總覽", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  const recent = page.locator(".empty-state .start-recent");
  await recent.locator("h3", { hasText: "專案" }).waitFor();
  assert.deepEqual(await recent.locator("h3").allTextContents(), ["專案", "最近開啟的檔案"]);
  const projects = recent.locator(".start-recent-item:has(.project-dot)");
  assert.deepEqual(await projects.locator(".start-recent-name").allTextContents(), ["鈷藍計畫", "notes", "釘選的專案", "有群組的"]);
  assert.deepEqual(
    await projects.locator(".project-dot").evaluateAll((dots) => dots.map((d) => d.dataset.color ?? null)),
    ["blue", null, "red", "green"],
  );
  // 自訂了名稱：位置改成資料夾本身，看得出是哪個資料夾。
  assert.equal(await projects.first().locator(".start-recent-where").textContent(), "work › cobalt");
  assert.deepEqual(await recent.locator(".start-recent-item:not(:has(.project-dot)) .start-recent-name").allTextContents(), ["README.md", "週報.md"]);
  await recent.getByRole("button", { name: "全部專案…" }).click();
  await page.locator("dialog.project-overview[open]").waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test("檔案面板（沒開資料夾）：標題是「專案」，和起始頁同樣的名稱、顏色與順序；標題列沒有第二個「⋯」", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  assert.equal(await page.locator("#files-more").count(), 0);
  await page.keyboard.press("Control+Shift+E");
  const box = page.locator("#files-empty");
  await box.locator("h3", { hasText: "專案" }).waitFor();
  assert.deepEqual(await box.locator("h3").allTextContents(), ["專案"]);
  const rows = box.locator(".recent-list li button:first-child");
  assert.deepEqual(await rows.allTextContents(), ["鈷藍計畫", "notes", "釘選的專案", "有群組的", "很久沒開"]);
  assert.deepEqual(
    await box.locator(".recent-list .project-dot").evaluateAll((dots) => dots.map((d) => d.dataset.color ?? null)),
    ["blue", null, "red", "green", null],
  );
  await box.getByRole("button", { name: "全部專案…" }).click();
  await page.locator("dialog.project-overview[open]").waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test("「⋯」：最近開啟的檔案在第一層、只列檔案（Ctrl+R）；「專案」只留新專案、新 COMET 專案、切換、總覽、開啟資料夾、下載儲存庫、連線到遠端資料夾", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  await page.click("#main-menu");
  const menu = page.locator("#main-menu-popover");
  await menu.waitFor();
  const top = await menu.locator(":scope > button").allTextContents();
  const at = top.findIndex((s) => s.startsWith("開啟檔案…"));
  assert.match(top[at + 1], /^最近開啟的檔案…Ctrl\+R$/);
  await menu.locator(":scope > button", { hasText: "專案" }).click();
  const sub = menu.locator(":scope > .submenu:popover-open");
  await sub.waitFor();
  assert.deepEqual(await sub.locator(":scope > button").allTextContents(), ["新專案…", "新 COMET 專案…", "切換專案…Ctrl+Alt+P", "專案總覽", "開啟資料夾…", "下載儲存庫", "連線到遠端資料夾"]);
  await sub.locator(":scope > button", { hasText: "下載儲存庫" }).click();
  // 還沒登入 GitHub、還沒連線 Azure DevOps：名稱右邊註明（不停用，點下去就是登入或連線設定）。
  assert.deepEqual(await sub.locator(":scope > .submenu:popover-open > button").allTextContents(), [
    "GitHub：下載儲存庫…還沒登入",
    "Azure DevOps：下載儲存庫…還沒連線",
  ]);
  await sub.locator(":scope > button", { hasText: "連線到遠端資料夾" }).click();
  assert.deepEqual(await sub.locator(":scope > .submenu:popover-open > button").allTextContents(), [
    "連線到遠端資料夾（WebDAV）…",
    "連線到遠端資料夾（SSH）…",
  ]);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // Ctrl+R：最近開啟的檔案，只有檔案（資料夾是專案，在切換專案裡）。
  await page.keyboard.press("Control+R");
  const picker = page.locator("dialog[open]");
  await picker.locator("[role=option]").first().waitFor();
  assert.deepEqual(await picker.locator("[role=option] .palette-title").allTextContents(), ["README.md", "週報.md"]);
  assert.deepEqual(errors, []);
  await context.close();
});

const ACCOUNT = { login: "wang-xiaoming", id: 1, name: "王小明" };
const ADO_ACCOUNT = { url: "https://ado.test/c", name: "王小明" };
/** 還沒登入 GitHub：點「下載儲存庫」開始裝置碼登入，慢一點才登入好（看得到輸入代碼的視窗），這個帳號沒有儲存庫。 */
const SIGN_IN = {
  github_login_start: { userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", interval: 5, expiresIn: 900 },
  github_login_wait: { $delay: 300, value: ACCOUNT },
  github_repos: [[]],
};

/** 開啟專案切換器（Ctrl+Alt+P）。 */
async function openSwitcher(page) {
  await page.keyboard.press("Control+Alt+P");
  const dialog = page.locator("dialog.palette[open]");
  await dialog.locator("[role=option]").first().waitFor();
  return dialog;
}

/** 切換器「下載儲存庫」那一區：每一項的名稱與右邊的狀態。 */
const repoRows = (dialog) =>
  dialog.locator("[role=option]").evaluateAll((els) =>
    els
      .filter((el) => el.querySelector(".palette-title").textContent.includes("下載儲存庫"))
      .map((el) => [el.querySelector(".palette-title").textContent, el.querySelector(".palette-group")?.textContent ?? null]),
  );

/** 檔案面板（沒開資料夾）的下載儲存庫按鈕：名稱與右邊的狀態。 */
const filesRepos = (page) =>
  page.locator("#files-empty .side-buttons button:has(.repo-note)").evaluateAll((els) =>
    els.map((el) => {
      const note = el.querySelector(".repo-note");
      return [el.querySelector(".repo-label > span").textContent, note.hidden ? null : note.textContent];
    }),
  );

test("下載儲存庫：還沒登入 GitHub、還沒連線 Azure DevOps 時名稱右邊註明；點下去照樣登入或打開連線設定，登入後改成帳號", async () => {
  const { page, context, errors } = await open({ desktop: { ...DESKTOP, ...SIGN_IN } });
  await page.keyboard.press("Control+Shift+E");
  await page.locator("#files-empty .repo-note:not([hidden])").nth(1).waitFor();
  assert.deepEqual(await filesRepos(page), [
    ["GitHub：下載儲存庫", "還沒登入"],
    ["Azure DevOps：下載儲存庫", "還沒連線"],
  ]);

  let switcher = await openSwitcher(page);
  assert.deepEqual(await repoRows(switcher), [
    ["GitHub：下載儲存庫…", "還沒登入"],
    ["Azure DevOps：下載儲存庫…", "還沒連線"],
  ]);
  // 專案總覽的「下載儲存庫…」：選來源的按鈕也註明。
  await switcher.locator("[role=option]", { hasText: "專案總覽" }).click();
  const overview = page.locator("dialog.project-overview[open]");
  await overview.locator(".po-head button", { hasText: "下載儲存庫…" }).click();
  const choice = page.locator("dialog.choice[open]:not(.project-overview)");
  await choice.waitFor();
  assert.deepEqual(await choice.locator("button").allTextContents(), [
    "GitHub：下載儲存庫（還沒登入）",
    "Azure DevOps：下載儲存庫（還沒連線）",
    "取消",
  ]);
  await choice.getByRole("button", { name: "取消" }).click();
  await overview.getByRole("button", { name: "關閉" }).click();
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));

  // 沒有停用：點 Azure DevOps 就打開設定的 Azure DevOps 頁。
  switcher = await openSwitcher(page);
  await switcher.locator("[role=option]", { hasText: "Azure DevOps：下載儲存庫…" }).click();
  await page.locator(".toast", { hasText: "請先在設定的 Azure DevOps 頁輸入伺服器網址與個人存取權杖" }).waitFor();
  const settings = page.locator("dialog.settings[open]");
  await settings.waitFor();
  assert.match(await settings.locator("[role=tab][aria-selected=true]").textContent(), /Azure DevOps/);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));

  // 點 GitHub 就開始登入；登入好了接著列出儲存庫。
  switcher = await openSwitcher(page);
  await switcher.locator("[role=option]", { hasText: "GitHub：下載儲存庫…" }).click();
  const login = page.locator("dialog.github-login[open]");
  await login.waitFor();
  assert.equal(await login.locator(".github-code").textContent(), "ABCD-1234");
  await page.locator("dialog.palette[open] input[placeholder='你的 GitHub 帳號還沒有儲存庫']").waitFor();
  assert.equal((await calls(page)).filter((c) => c.cmd === "github_login_start").length, 1);
  // 換權杖用的代碼只留在原生端：網頁等登入時不帶任何參數。
  assert.deepEqual((await calls(page)).filter((c) => c.cmd === "github_login_wait").map((c) => c.args), [null]);
  await page.keyboard.press("Escape");

  // 登入後改成帳號名稱：檔案面板不必重畫就更新，切換器也一樣。
  assert.deepEqual(await filesRepos(page), [
    ["GitHub：下載儲存庫", "wang-xiaoming"],
    ["Azure DevOps：下載儲存庫", "還沒連線"],
  ]);
  switcher = await openSwitcher(page);
  assert.deepEqual(await repoRows(switcher), [
    ["GitHub：下載儲存庫…", "wang-xiaoming"],
    ["Azure DevOps：下載儲存庫…", "還沒連線"],
  ]);
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  await context.close();
});

test("下載儲存庫：已經登入 GitHub、連線 Azure DevOps 時不註明「還沒登入／還沒連線」，改成帳號名稱", async () => {
  const { page, context, errors } = await open({ desktop: { ...DESKTOP, github_account: ACCOUNT, ado_account: ADO_ACCOUNT } });
  await page.keyboard.press("Control+Shift+E");
  await page.locator("#files-empty .repo-note:not([hidden])").nth(1).waitFor();
  assert.deepEqual(await filesRepos(page), [
    ["GitHub：下載儲存庫", "wang-xiaoming"],
    ["Azure DevOps：下載儲存庫", "王小明"],
  ]);
  const switcher = await openSwitcher(page);
  assert.deepEqual(await repoRows(switcher), [
    ["GitHub：下載儲存庫…", "wang-xiaoming"],
    ["Azure DevOps：下載儲存庫…", "王小明"],
  ]);
  await page.keyboard.press("Escape");
  await page.click("#main-menu");
  const menu = page.locator("#main-menu-popover");
  await menu.locator(":scope > button", { hasText: "專案" }).click();
  const sub = menu.locator(":scope > .submenu:popover-open");
  await sub.locator(":scope > button", { hasText: "下載儲存庫" }).click();
  assert.deepEqual(await sub.locator(":scope > .submenu:popover-open > button").allTextContents(), [
    "GitHub：下載儲存庫…wang-xiaoming",
    "Azure DevOps：下載儲存庫…王小明",
  ]);
  assert.deepEqual(errors, []);
  await context.close();
});
