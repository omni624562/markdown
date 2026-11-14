/**
 * 標題列（Windows 桌面版兼當視窗的標題列）與三欄的標題列：
 * - 標題列只有 ☰、◧（左上角）與 ◨、視窗按鈕（右上角），☰ 和圖示列對齊。
 * - 側邊欄的標題列、文件分頁、右側欄的分頁列是三欄各自的第一列，在標題列下面、同一列；
 *   圖示列從「檔案」開始，不放專案方塊（檔案面板的標題列已經有專案名稱），換面板、收起側邊欄時圖示不會跳動。
 * - ◧ 和 ◨ 開著時同一種樣子（沒有底色、顏色相同）；收起或打開都在原位。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

async function setup() {
  const opened = await open({
    // 這裡檢查「相連」的區塊樣式；「圓角區塊、留間隔」（預設）見 panel-style.test.mjs。
    desktop: { custom_title_bar: true, window_control: false, load_settings: JSON.stringify({ outlineRight: true, panelStyle: "joined" }) },
  });
  const { page } = opened;
  await page.setViewportSize({ width: 1500, height: 600 });
  if ((await page.locator(".topbar > .nav-toggle").getAttribute("aria-pressed")) !== "true") await page.click(".topbar > .nav-toggle");
  await page.locator('.topbar > .nav-toggle[aria-pressed="true"]').waitFor();
  if (!(await page.locator("#panel-files").isVisible())) await page.click("#side-tab-files");
  // 有開專案時圖示列最上面才有專案方塊；假的原生端沒有專案，直接顯示出來看會不會藏起來。
  await page.evaluate(() => (document.querySelector("#activity-project").hidden = false));
  await page.mouse.move(800, 500);
  // 滑鼠離開後的底色有淡出動畫，等它結束。
  await page.waitForTimeout(400);
  return opened;
}

const box = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el || !el.getClientRects().length) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) };
  }, sel);

test("三欄的標題列在標題列下面、同一列；☰ 和圖示列對齊；圖示列從「檔案」開始、不放專案方塊，換面板或收起側邊欄時圖示不跳", async () => {
  const { page, context, errors } = await setup();
  const [menu, activity, topbar, head, tabs, rightTabs, sidebar, files] = await Promise.all(
    ["#main-menu", ".activity-bar", ".topbar", "#panel-files > .side-head", ".tab-bar", "#outline-right > .right-head", ".sidebar", "#side-tab-files"].map((s) => box(page, s)),
  );
  const s = JSON.stringify({ menu, activity, topbar, head, tabs, rightTabs, sidebar, files });
  assert.ok(Math.abs(menu.right - activity.right) <= 1, `☰ 和圖示列同寬 ${s}`);
  assert.equal(topbar.right, 1500, "標題列橫跨整個視窗");
  for (const b of [head, tabs, rightTabs]) {
    assert.ok(b.top >= topbar.bottom - 1, `在標題列下面 ${s}`);
    assert.ok(Math.abs(b.top - tabs.top) <= 1 && Math.abs(b.bottom - tabs.bottom) <= 1, `同一列 ${s}`);
  }
  assert.ok(tabs.left >= sidebar.right - 1, "文件分頁只在內文上方");
  assert.ok(files.top >= topbar.bottom && files.top - activity.top <= 12, `圖示列最上面是「檔案」 ${s}`);
  assert.equal(await page.evaluate(() => !!document.querySelector("#activity-project").getClientRects().length), false, "圖示列不放專案方塊");

  // 換到其他面板：標題列換成那個面板的、在同一列，圖示列的圖示位置不變。
  const iconTop = () => page.evaluate(() => document.querySelector("#side-tab-search").getBoundingClientRect().top);
  const before = await iconTop();
  await page.click("#side-tab-search");
  const other = await box(page, "#panel-search > .side-head");
  assert.equal(other.top, head.top, "搜尋面板的標題列也在同一列");
  assert.equal(await page.evaluate(() => !!document.querySelector("#activity-project").getClientRects().length), false, "其他面板也不放專案方塊");
  assert.equal(await iconTop(), before, "換面板時圖示不跳動");
  // 收起側邊欄也一樣。
  await page.click(".topbar > .nav-toggle");
  await page.waitForFunction(() => document.querySelector(".workspace").classList.contains("outline-hidden"));
  assert.equal(await iconTop(), before, "收起側邊欄時圖示不跳動");
  assert.deepEqual(errors, []);
  await context.close();
});

test("◧ 和 ◨ 開著時樣子一樣；◨ 緊貼視窗按鈕，收起右側欄後還在原位，文件分頁拿回空間", async () => {
  const { page, context, errors } = await setup();
  const right = page.locator('.top-actions [data-command="toggle-outline-right"]');
  assert.equal(await right.getAttribute("aria-pressed"), "true");
  const look = await page.evaluate(() => {
    const css = (sel) => getComputedStyle(document.querySelector(sel));
    return {
      leftColor: css(".topbar > .nav-toggle").color,
      leftBg: css(".topbar > .nav-toggle .icon").backgroundColor,
      rightColor: css('.top-actions [data-command="toggle-outline-right"]').color,
      rightBg: css('.top-actions [data-command="toggle-outline-right"]').backgroundColor,
    };
  });
  assert.equal(look.rightBg, "rgba(0, 0, 0, 0)", "右邊的按鈕開著時沒有底色");
  assert.equal(look.leftBg, "rgba(0, 0, 0, 0)");
  assert.equal(look.rightColor, look.leftColor, "左右兩個按鈕開著時顏色一樣");
  const at = await box(page, '.top-actions [data-command="toggle-outline-right"]');
  const controls = await box(page, ".window-controls");
  assert.ok(Math.abs(at.right - controls.left) <= 4, JSON.stringify({ at, controls }));
  const tabsBefore = await box(page, ".tab-bar");

  // 右側欄關起來：◨ 不動，文件分頁一路到視窗右緣。
  await right.click();
  await page.locator("#outline-right").waitFor({ state: "hidden" });
  assert.deepEqual(await box(page, '.top-actions [data-command="toggle-outline-right"]'), at, "◨ 還在原位");
  const tabsAfter = await box(page, ".tab-bar");
  assert.ok(tabsAfter.right > tabsBefore.right && tabsAfter.right >= 1500 - 1, JSON.stringify({ tabsBefore, tabsAfter }));
  assert.deepEqual(errors, []);
  await context.close();
});

test("標題列的空白按住可以拖曳視窗；按 ☰、◧、中間的搜尋框不會", async () => {
  const { page, context, errors } = await setup();
  const drags = () => page.evaluate(() => window.__fake.calls.filter((c) => c.cmd === "window_control" && c.args?.action === "drag").length);
  const topbar = await box(page, ".topbar");
  // 搜尋框左邊的空白。
  const search = await box(page, "#title-search");
  await page.mouse.move(search.left - 40, (topbar.top + topbar.bottom) / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "window_control" && c.args?.action === "drag"));
  const n = await drags();
  await page.click(".topbar > .nav-toggle");
  await page.click(".topbar > .nav-toggle");
  await page.click("#title-search");
  await page.locator("dialog.palette[open]").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await drags(), n, "按按鈕不拖曳");
  assert.deepEqual(errors, []);
  await context.close();
});
