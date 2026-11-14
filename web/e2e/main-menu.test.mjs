/**
 * 主選單（☰）在最左上角、圖示列的正上方；側邊欄開關（◧）在標題列裡、緊接在 ☰ 右邊，側邊欄開著或收起都在同一個位置。
 * 圖示列從「檔案」開始。窄視窗時也一樣是 ☰ ◧ 在左上角，◧ 打開抽屜。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const ROOT = { kind: "folder", path: "/notes", name: "notes" };
const DESKTOP = {
  startup_target: ROOT,
  list_dir: { $by: "path", values: { "/notes": [{ name: "a.md", path: "/notes/a.md", isDir: false }] } },
};

const box = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el || !el.getClientRects().length) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) };
  }, sel);

test("寬視窗：☰ 在最左上角、和圖示列同寬；◧ 在標題列裡、緊接在 ☰ 右邊，收起或打開都在原位；圖示列從「檔案」開始", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  await page.locator("#files-head").waitFor();
  const menu = await box(page, "#main-menu");
  const bar = await box(page, ".activity-bar");
  const topbar = await box(page, ".topbar");
  assert.deepEqual([menu.left, menu.top], [0, 0], JSON.stringify(menu));
  assert.ok(Math.abs(menu.right - bar.right) <= 1, `和圖示列同寬 ${JSON.stringify({ menu, bar })}`);
  assert.equal(await page.locator(".top-actions #main-menu").count(), 0, "右上角不再有選單");
  assert.equal(await page.locator(".activity-bar .nav-toggle, .activity-bar [data-command='toggle-outline']").count(), 0, "圖示列裡沒有側邊欄開關");

  const toggle = page.locator(".topbar > .nav-toggle");
  const at = await box(page, ".topbar > .nav-toggle");
  assert.ok(at.left >= menu.right - 1 && at.left - menu.right <= 4 && at.top >= topbar.top && at.bottom <= topbar.bottom, `◧ 在標題列裡、☰ 右邊 ${JSON.stringify({ at, menu, topbar })}`);
  const firstTab = await box(page, "#side-tab-files");
  assert.ok(firstTab.top >= topbar.bottom && firstTab.top - bar.top <= 12, `圖示列最上面是「檔案」 ${JSON.stringify({ firstTab, bar })}`);
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  await toggle.click();
  await page.waitForFunction(() => document.querySelector(".workspace").classList.contains("outline-hidden"));
  assert.equal(await toggle.getAttribute("aria-pressed"), "false");
  assert.deepEqual(await box(page, ".topbar > .nav-toggle"), at, "收起側邊欄後開關還在原位");
  await toggle.click();
  await page.waitForFunction(() => !document.querySelector(".workspace").classList.contains("outline-hidden"));

  // 按 ☰ 打開主選單：在按鈕下方、整個在視窗內。
  await page.click("#main-menu");
  const pop = page.locator("#main-menu-popover");
  await pop.waitFor();
  const p = await box(page, "#main-menu-popover");
  assert.ok(p.top >= menu.bottom && p.left >= 0, JSON.stringify({ p, menu }));
  assert.ok((await pop.textContent()).includes("開啟"), "選單內容照舊");
  assert.deepEqual(errors, []);
  await context.close();
});

test("窄視窗：☰ ◧ 一樣在左上角，◧ 打開側邊欄抽屜", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  await page.locator("#files-head").waitFor();
  await page.setViewportSize({ width: 600, height: 800 });
  await page.waitForFunction(() => document.querySelector(".workspace").classList.contains("narrow"));
  const toggle = await box(page, ".topbar > .nav-toggle");
  const menu = await box(page, "#main-menu");
  assert.deepEqual([menu.left, menu.top], [0, 0], JSON.stringify(menu));
  assert.ok(toggle.left >= menu.right - 1 && toggle.left < 120, JSON.stringify({ toggle, menu }));
  await page.click(".topbar > .nav-toggle");
  await page.waitForFunction(() => !document.querySelector(".workspace").classList.contains("outline-hidden"));
  assert.equal(await page.locator(".sidebar").isVisible(), true, "抽屜打開");
  assert.deepEqual(errors, []);
  await context.close();
});
