/**
 * COMET 專案（資料夾裡有 .comet.json，原生端在專案清單標 `comet: true`）：起始頁、檔案面板、專案切換器
 * 的名稱後面有「COMET」小標籤（專案總覽的卡片放在下面那一行，名稱那一行右邊是按鈕）；開啟後側邊欄上方的專案名稱也有，圖示列的專案方塊右下角加綠點。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const project = (path, label, extra = {}) => ({ path, label, name: null, color: null, group: null, pinned: false, lastOpened: 0, ...extra });
const COMET = "C:\\Users\\me\\Documents\\產品交付";
const PROJECTS = [project(COMET, "產品交付", { color: "green", comet: true }), project("C:\\Users\\me\\Documents\\筆記", "筆記")];
const DESKTOP = {
  // 陣列是依序回應的清單，所以專案清單要再包一層。
  projects_list: [PROJECTS],
  recent: { files: [], folders: PROJECTS.map((p) => p.path) },
  reopen_folder: { path: COMET, name: "產品交付" },
  list_dir: [[{ name: ".comet.json", path: `${COMET}\\.comet.json`, isDir: false }]],
};

test("起始頁、檔案面板、切換專案、專案總覽：COMET 專案的名稱後面有「COMET」標籤", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  const recent = page.locator(".empty-state .start-recent");
  await recent.locator(".start-recent-item .comet-badge").waitFor();
  const start = recent.locator(".start-recent-item:has(.project-dot)");
  assert.equal(await start.count(), 2);
  assert.deepEqual(await start.evaluateAll((els) => els.filter((el) => el.querySelector(".comet-badge")).map((el) => el.querySelector(".start-recent-name").textContent)), ["產品交付"]);
  const badge = recent.locator(".comet-badge");
  assert.equal(await badge.getAttribute("title"), "COMET 專案");
  // 標籤緊接在名稱後面，不會被擠扁或截斷。
  const box = await badge.boundingBox();
  assert.ok(box.height >= 16 && box.width > 30, JSON.stringify(box));

  await page.keyboard.press("Control+Shift+E");
  const files = page.locator("#files-empty .recent-list li button:first-child");
  await files.first().waitFor();
  assert.deepEqual(await files.evaluateAll((els) => els.filter((el) => el.querySelector(".comet-badge")).map((el) => el.querySelector(".files-row-name > span").textContent)), ["產品交付"]);

  await page.keyboard.press("Control+Alt+P");
  const options = page.locator(".palette [role=option]");
  await options.first().waitFor();
  assert.deepEqual(await options.evaluateAll((els) => els.filter((el) => el.querySelector(".comet-badge")).map((el) => el.querySelector(".palette-title").textContent)), ["產品交付"]);
  await page.keyboard.press("Escape");

  await page.evaluate(() => document.querySelector("#main-menu").click());
  const menu = page.locator("#main-menu-popover");
  await menu.locator(":scope > button", { hasText: "專案" }).click();
  await menu.locator(":scope > .submenu:popover-open > button", { hasText: "專案總覽" }).click();
  const cards = page.locator("dialog.project-overview[open] .po-card");
  await cards.first().waitFor();
  assert.deepEqual(await cards.evaluateAll((els) => els.filter((el) => el.querySelector(".po-meta .comet-badge")).map((el) => el.querySelector(".po-name > span:nth-child(2)").textContent)), ["產品交付"]);
  // 名稱那一行不會被標籤擠掉。
  assert.equal(await cards.first().locator(".po-name > span:nth-child(2)").evaluate((el) => el.scrollWidth <= el.clientWidth), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("開啟 COMET 專案：側邊欄上方的名稱有「COMET」標籤，圖示列的專案方塊加綠點、提示寫 COMET 專案；換成一般專案就拿掉", async () => {
  const { page, context, errors } = await open({
    desktop: { ...DESKTOP, projects_list: [PROJECTS], reopen_folder: [{ path: COMET, name: "產品交付" }, { path: PROJECTS[1].path, name: "筆記" }] },
  });
  await page.locator(".empty-state .start-recent-item", { hasText: "產品交付" }).click();
  const switcher = page.locator(".project-switch");
  await switcher.locator(".comet-badge").waitFor();
  assert.equal(await page.locator("#folder-name").textContent(), "產品交付");
  const square = page.locator("#activity-project");
  assert.equal(await square.evaluate((el) => el.classList.contains("comet")), true);
  assert.match(await square.getAttribute("title"), /^產品交付\nCOMET 專案\n/);
  const dot = await square.locator(".project-avatar").evaluate((el) => {
    const s = getComputedStyle(el, "::after");
    return { content: s.content, width: s.width, position: s.position };
  });
  assert.deepEqual(dot, { content: '""', width: "9px", position: "absolute" });

  // 切到沒有 .comet.json 的專案：標籤和綠點都拿掉。
  await page.evaluate(() => document.querySelector("#main-menu").click());
  const menu = page.locator("#main-menu-popover");
  await menu.locator(":scope > button", { hasText: "專案" }).click();
  await menu.locator(":scope > .submenu:popover-open > button", { hasText: "切換專案…" }).click();
  await page.locator(".palette [role=option]", { hasText: "筆記" }).click();
  await page.waitForFunction(() => document.querySelector("#folder-name").textContent === "筆記");
  assert.equal(await switcher.locator(".comet-badge").count(), 0);
  assert.equal(await square.evaluate((el) => el.classList.contains("comet")), false);
  assert.deepEqual(errors, []);
  await context.close();
});
