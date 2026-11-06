/**
 * 檔案面板沒開資料夾時（專案優先）：最上面是最近的專案（名稱下面一行是位置，記住的遠端連線也在這裡），
 * 接著是「開啟資料夾…」「新專案…」，最後是「其他方式」（下載儲存庫、連線到遠端資料夾）。
 * 還沒有任何專案時，最上面是一句說明。用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const project = (path, label, extra = {}) => ({ path, label, name: label, color: null, group: null, pinned: false, lastOpened: 0, ...extra });
const PROJECTS = [
  project("C:\\Users\\me\\Documents\\產品交付", "產品交付", { color: "yellow", comet: true }),
  project("C:\\Users\\me\\Documents\\Contoso 網站", "Contoso 網站"),
  project("D:\\備份\\產品交付", "交付備份"),
];
const SSH = { id: "c1", kind: "ssh", name: "測試主機", url: "sftp://ssh.test/home/me", username: "me", hasPassword: false };

/** 每一列專案：名稱、位置、小標籤。 */
const rows = (box) =>
  box.locator(".files-project-list li > button:first-child").evaluateAll((els) =>
    els.map((el) => [
      el.querySelector(".files-row-name > span").textContent,
      el.querySelector(".files-row-where").textContent,
      [...el.querySelectorAll(".comet-badge, .files-kind-badge")].map((b) => b.textContent).join(),
    ]),
  );

test("專案在最上面（下面一行是位置），接著是開啟資料夾、新專案，最後是其他方式", async () => {
  const { page, context, errors } = await open({ desktop: { projects_list: [PROJECTS], recent: { files: [], folders: PROJECTS.map((p) => p.path) }, dav_connections: [[SSH]] } });
  await page.keyboard.press("Control+Shift+E");
  const box = page.locator("#files-empty");
  await box.locator(".files-project-list").waitFor();
  assert.deepEqual(await rows(box), [
    ["產品交付", "me › Documents", "COMET"],
    ["Contoso 網站", "me › Documents", ""],
    // 自訂了名稱：位置改成資料夾本身與上一層，看得出是哪個資料夾。
    ["交付備份", "備份 › 產品交付", ""],
    ["測試主機", "ssh.test › home › me", "SSH"],
  ]);
  // 由上而下：最近的專案 → 開啟資料夾、新專案 → 其他方式。
  const order = await box.evaluate((el) => [...el.children].map((c) => c.className || c.tagName.toLowerCase()));
  assert.deepEqual(order, ["files-projects", "files-main", "h3", "files-other"]);
  assert.deepEqual(await box.locator(".files-main button").allTextContents(), ["開啟資料夾…", "新專案…"]);
  assert.match(await box.locator(".files-main button").first().getAttribute("class"), /btn-primary/);
  assert.deepEqual(await box.locator(".files-other > li > button").evaluateAll((els) => els.map((el) => el.querySelector(".repo-label > span")?.textContent ?? el.textContent)), [
    "GitHub：下載儲存庫",
    "Azure DevOps：下載儲存庫",
    "連線到 WebDAV",
    "用 SSH 連線",
  ]);
  // 完整路徑在滑鼠提示裡。
  assert.equal(await box.locator(".files-project-list li > button").first().getAttribute("title"), "C:\\Users\\me\\Documents\\產品交付");

  // 點專案就開啟那個資料夾；「全部專案」開專案總覽。
  await box.locator(".files-project-list li > button", { hasText: "Contoso 網站" }).click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "reopen_folder"));
  assert.ok((await calls(page)).some((c) => c.cmd === "reopen_folder" && JSON.stringify(c.args).includes("Contoso 網站")));
  assert.deepEqual(errors, []);
  await context.close();
});

test("還沒有任何專案：最上面是一句說明，下面照樣有開啟資料夾、新專案", async () => {
  const { page, context, errors } = await open({ desktop: { projects_list: [[]], recent: { files: [], folders: [] }, dav_connections: [[]] } });
  await page.keyboard.press("Control+Shift+E");
  const box = page.locator("#files-empty");
  await box.locator(".files-projects p").waitFor();
  assert.match(await box.locator(".files-projects p").textContent(), /開啟一個資料夾/);
  assert.equal(await box.locator(".files-project-list").count(), 0);
  assert.deepEqual(await box.locator(".files-main button").allTextContents(), ["開啟資料夾…", "新專案…"]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("「全部專案」開啟專案總覽", async () => {
  const { page, context, errors } = await open({ desktop: { projects_list: [PROJECTS], recent: { files: [], folders: PROJECTS.map((p) => p.path) } } });
  await page.keyboard.press("Control+Shift+E");
  await page.locator("#files-empty .files-all-projects").click();
  await page.locator("dialog.project-overview[open]").waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});
