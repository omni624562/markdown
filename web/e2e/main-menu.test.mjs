/**
 * 主選單（☰）在最左上角、圖示列的正上方；側邊欄開關在圖示列最上面，側邊欄開著或收起都在同一個位置。
 * 窄視窗時左上角是側邊欄開關（打開抽屜），主選單在右上角。
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

test("寬視窗：☰ 在最左上角、和圖示列同寬；側邊欄開關在圖示列最上面，收起或打開都在原位", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  await page.locator("#files-head").waitFor();
  const menu = await box(page, "#main-menu");
  const bar = await box(page, ".activity-bar");
  assert.deepEqual([menu.left, menu.top], [0, 0], JSON.stringify(menu));
  assert.ok(Math.abs(menu.right - bar.right) <= 1, `和圖示列同寬 ${JSON.stringify({ menu, bar })}`);
  assert.equal(await box(page, ".topbar > .nav-toggle"), null, "頂端列的側邊欄開關只在窄視窗出現");
  assert.equal(await page.locator(".top-actions #main-menu").count(), 0, "右上角不再有選單");

  const toggle = page.locator(".activity-toggle");
  const at = await box(page, ".activity-toggle");
  const firstTab = await box(page, "#side-tab-files");
  assert.ok(at.bottom <= firstTab.top, `開關在面板圖示的上面 ${JSON.stringify({ at, firstTab })}`);
  // ☰ 和 ◧ 靠近一點，看起來是同一組：兩個圖示的中心相距 31px（只移動圖示，按鈕與下面的面板圖示不動）。
  const iconMiddle = (sel) => page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return (r.top + r.bottom) / 2;
  }, sel);
  const gap = (await iconMiddle(".activity-toggle .icon")) - (await iconMiddle("#main-menu .icon"));
  assert.ok(Math.abs(gap - 31) <= 1, `☰ 到 ◧ 是 ${gap}px`);
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  await toggle.click();
  await page.waitForFunction(() => document.querySelector(".workspace").classList.contains("outline-hidden"));
  assert.equal(await toggle.getAttribute("aria-pressed"), "false");
  assert.deepEqual(await box(page, ".activity-toggle"), at, "收起側邊欄後開關還在原位");
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

test("窄視窗：左上角是側邊欄開關（打開抽屜），☰ 在右上角", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  await page.locator("#files-head").waitFor();
  await page.setViewportSize({ width: 600, height: 800 });
  await page.waitForFunction(() => document.querySelector(".workspace").classList.contains("narrow"));
  const toggle = await box(page, ".topbar > .nav-toggle");
  const menu = await box(page, "#main-menu");
  assert.equal(toggle.left, 0, JSON.stringify(toggle));
  assert.ok(menu.right >= 600 - 4 && menu.left > 300, JSON.stringify(menu));
  assert.equal(await box(page, ".activity-toggle"), null, "圖示列裡的開關只在寬視窗");
  assert.deepEqual(errors, []);
  await context.close();
});
