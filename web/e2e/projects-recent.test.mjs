/**
 * 專案與最近開啟：起始頁和檔案面板（沒開資料夾時）的「專案」是同一份清單、同樣的順序（最近開啟的在前），
 * 用自訂的名稱與顏色；「最近開啟的檔案…」只列檔案、放在「⋯」第一層；「⋯」→「專案」只留常用的項目，
 * 檔案面板標題列不再有第二個「⋯」。用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

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

test("「⋯」：最近開啟的檔案在第一層、只列檔案（Ctrl+R）；「專案」只留新專案、切換、總覽、開啟資料夾、下載儲存庫、連線到遠端資料夾", async () => {
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
  assert.deepEqual(await sub.locator(":scope > button").allTextContents(), ["新專案…", "切換專案…Ctrl+Alt+P", "專案總覽", "開啟資料夾…", "下載儲存庫", "連線到遠端資料夾"]);
  await sub.locator(":scope > button", { hasText: "下載儲存庫" }).click();
  assert.deepEqual(await sub.locator(":scope > .submenu:popover-open > button").allTextContents(), [
    "GitHub：下載儲存庫…",
    "Azure DevOps：下載儲存庫…",
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
