/**
 * 標題列與三欄的標題列：最上面的標題列只有 ☰、◧（左）與 ◨、視窗按鈕（右），中間空著可以拖曳視窗；
 * 側邊欄的標題列、文件分頁、右側欄的分頁列（大綱、反向連結、助理）是三欄各自的第一列，在同一個高度、一樣高。
 * ◨ 收起或打開右側欄都在同一個位置（緊貼視窗按鈕左邊），視窗按鈕貼在右上角；視窗不夠寬時助理是抽屜。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\個人筆記";
const SHOTS = process.env.SHOTS;
const desktop = (settings = {}) => ({
  startup_target: { kind: "folder", path: ROOT, name: "個人筆記" },
  list_dir: { $by: "path", values: { [ROOT]: [{ name: "筆記.md", path: `${ROOT}\\筆記.md`, isDir: false }] } },
  load_settings: JSON.stringify({ claudeApiEnabled: true, assistantProjects: [ROOT], ...settings }),
  assistant_key_status: true,
  assistant_usage: { month: "2026-11", usd: 0.42, limit: 10 },
  custom_title_bar: true,
  window_control: false,
});

const geometry = (page) =>
  page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el || !el.getClientRects().length) return null;
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) };
    };
    const css = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el) : {};
    };
    const close = document.querySelector(".window-close");
    return {
      close: box(".window-close"),
      corner: document.elementFromPoint(innerWidth - 1, 1) === close,
      actions: box(".top-actions"),
      rightToggle: box(".top-actions [data-command='toggle-outline-right']"),
      leftToggle: box(".topbar > .nav-toggle"),
      controls: box(".window-controls"),
      sideHead: box("#panel-files > .side-head"),
      sidebar: box(".sidebar"),
      tabs: box("#outline-right > .right-tabs"),
      right: box("#outline-right"),
      panel: box("#assistant-panel"),
      topbar: box(".topbar"),
      tabBar: box(".tab-bar"),
      pressed: document.querySelector("[data-command='toggle-outline-right']")?.getAttribute("aria-pressed"),
      selected: document.querySelector(".right-tab[aria-selected='true']")?.dataset.tab ?? null,
      rightPosition: css("#outline-right").position,
      navMenu: box("#main-menu"),
    };
  });

async function start(page) {
  await page.locator("#tab-bar").waitFor();
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText("# 筆記\n\n內容");
  await page.locator(".window-close").waitFor();
}

const toggle = (page) => page.locator(".top-actions [data-command='toggle-outline-right']");

// 三欄的標題列在同一個高度、一樣高（差 1px 以內）。
const sameRow = (...boxes) => {
  const [a, ...rest] = boxes;
  for (const b of rest) {
    assert.ok(Math.abs(a.top - b.top) <= 1 && Math.abs(a.bottom - b.bottom) <= 1, `標題列不在同一列：${JSON.stringify(boxes)}`);
  }
};

test("寬視窗：標題列只有 ☰ ◧ 與 ◨、視窗按鈕；側邊欄、文件分頁、右側欄的標題列在同一列；收起右側欄後 ◨ 還在原位", async () => {
  const { page, context, errors } = await open({ desktop: desktop() });
  await start(page);
  // 只有助理一個分頁、還沒打開過：右側欄收著，右上角只有開關。
  assert.equal(await toggle(page).getAttribute("aria-pressed"), "true", "開關記的是「右側欄要顯示」，只是沒東西可看");
  assert.equal(await page.locator("#outline-right").isVisible(), false);
  await page.keyboard.press("Control+Shift+L");
  await page.locator("#outline-right:not([hidden]) #assistant-panel").waitFor();
  const g = await geometry(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/wide-open.png` });
  assert.equal(g.corner, true, "視窗關閉鈕在視窗最右上角");
  // 標題列：☰、◧ 在左上角，◨ 緊貼視窗按鈕左邊，都在標題列裡；文件分頁不在標題列。
  assert.deepEqual([g.navMenu.left, g.navMenu.top], [0, 0]);
  assert.ok(g.leftToggle.left >= g.navMenu.right - 1 && g.leftToggle.left - g.navMenu.right <= 4, `◧ 緊接在 ☰ 右邊：${JSON.stringify([g.navMenu, g.leftToggle])}`);
  assert.ok(Math.abs(g.rightToggle.right - g.controls.left) <= 4, `◨ 緊貼視窗按鈕：${JSON.stringify([g.rightToggle, g.controls])}`);
  for (const b of [g.navMenu, g.leftToggle, g.rightToggle, g.controls]) assert.ok(b.top >= g.topbar.top && b.bottom <= g.topbar.bottom, JSON.stringify([b, g.topbar]));
  assert.ok(g.tabBar.top >= g.topbar.bottom - 1, "文件分頁在標題列下面");
  // 三欄的標題列在同一列；右側欄、側邊欄從標題列下面開始。
  sameRow(g.sideHead, g.tabBar, g.tabs);
  assert.ok(g.right.top >= g.topbar.bottom - 1 && g.sidebar.top >= g.topbar.bottom - 1, "側邊欄、右側欄從標題列下面開始");
  assert.ok(g.tabBar.right <= g.right.left, "文件分頁只到右側欄左邊為止");
  assert.ok(g.tabBar.left >= g.sidebar.right, "文件分頁從側邊欄右邊開始");
  assert.equal(g.selected, "assistant", "分頁列選著「助理」");
  assert.ok(g.tabs.left >= g.right.left && g.tabs.right <= g.right.right, `分頁列在右側欄裡：${JSON.stringify([g.tabs, g.right])}`);
  assert.ok(g.panel.top >= g.tabs.bottom - 1, "助理在分頁列下面");
  // 收起：◨ 不動，視窗按鈕還是貼在右上角，文件分頁拿回空間。
  await toggle(page).click();
  await page.locator("#outline-right").waitFor({ state: "hidden" });
  const c = await geometry(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/wide-closed.png` });
  assert.equal(c.corner, true);
  assert.equal(c.pressed, "false");
  assert.equal(c.tabs, null, "分頁列藏起來");
  assert.deepEqual(c.rightToggle, g.rightToggle, "◨ 還在原位");
  assert.ok(c.tabBar.right > g.tabBar.right, "文件分頁拿回空間");
  // ◧ 收起側邊欄：◧ 不動，文件分頁從圖示列右邊開始，還是和右側欄的分頁列同一列。
  await page.locator(".topbar > .nav-toggle").click();
  await page.waitForFunction(() => document.querySelector(".workspace").classList.contains("outline-hidden"));
  const h = await geometry(page);
  assert.deepEqual(h.leftToggle, g.leftToggle, "◧ 還在原位");
  assert.equal(h.sidebar, null);
  assert.ok(h.tabBar.left < g.tabBar.left, "文件分頁拿回左邊的空間");
  assert.deepEqual(errors, []);
  await context.close();
});

test("右側欄沒東西可放（助理的設定關閉、大綱在左邊）時，右上角沒有那塊", async () => {
  const { page, context, errors } = await open({ desktop: { ...desktop(), load_settings: JSON.stringify({}) } });
  await start(page);
  assert.equal(await page.locator(".top-actions").isVisible(), false);
  const g = await geometry(page);
  assert.equal(g.corner, true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("相連樣式、大綱放右邊：分頁列有大綱、反向連結、助理，三欄的標題列在同一列，視窗按鈕在右上角", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ panelStyle: "joined", outlineRight: true }) });
  await start(page);
  await page.locator("#outline-right:not([hidden]) #panel-outline").waitFor();
  assert.deepEqual(await page.locator("#outline-right .right-tab:not([hidden]) .right-tab-label").allTextContents(), ["大綱", "反向連結", "助理"]);
  await page.locator("#outline-right .right-tab[data-tab='assistant']").click();
  await page.locator("#outline-right #assistant-panel:not([hidden])").waitFor();
  const g = await geometry(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/joined-outline-open.png` });
  sameRow(g.sideHead, g.tabBar, g.tabs);
  // 右側欄是最窄的寬度時，三個分頁的名稱都完整顯示（不會被視窗按鈕擠成「大」「反」）。
  const cut = await page.$$eval("#outline-right .right-tab:not([hidden]) .right-tab-label", (els) => els.filter((e) => e.scrollWidth > e.clientWidth).map((e) => e.textContent));
  assert.deepEqual(cut, [], "分頁名稱沒有被截掉");
  assert.ok(g.tabs.right <= g.right.right && g.tabs.top >= g.topbar.bottom - 1, "分頁列在右側欄裡");
  assert.ok(g.panel.left - g.right.left <= 1, `助理在右側欄裡（右側欄左邊有一條線）：${g.panel.left} / ${g.right.left}`);
  assert.equal(await page.locator("#outline-right #panel-outline").isVisible(), false, "大綱那一頁藏起來");
  assert.equal(g.corner, true);
  // 切回大綱：助理藏起來，右側欄寬度不變（兩頁共用）。
  await page.locator("#outline-right .right-tab[data-tab='outline']").click();
  assert.equal(await page.locator("#outline-right #assistant-panel").isVisible(), false);
  assert.equal(await page.locator("#outline-right #panel-outline").isVisible(), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("圓角區塊：側邊欄、文件、右側欄三塊的上緣對齊，標題列在同一列，視窗按鈕在右上角仍按得到", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ panelStyle: "spaced" }) });
  await start(page);
  await page.keyboard.press("Control+Shift+L");
  await page.locator("#outline-right:not([hidden]) #assistant-panel").waitFor();
  const g = await geometry(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/spaced-open.png` });
  assert.equal(g.corner, true);
  assert.ok(Math.abs(g.sidebar.top - g.right.top) <= 1 && Math.abs(g.tabBar.top - g.right.top) <= 1, JSON.stringify([g.sidebar, g.tabBar, g.right]));
  sameRow(g.sideHead, g.tabBar, g.tabs);
  assert.deepEqual(errors, []);
  await context.close();
});

test("視窗不夠寬：☰ ◧ 在左上角，◨ 在視窗按鈕左邊；助理是抽屜（分頁列在抽屜最上面）", async () => {
  const { page, context, errors } = await open({ desktop: desktop() });
  await page.setViewportSize({ width: 700, height: 600 });
  await start(page);
  const g0 = await geometry(page);
  assert.deepEqual([g0.navMenu.left, g0.navMenu.top], [0, 0], "☰ 在左上角");
  assert.ok(g0.leftToggle.left >= g0.navMenu.right - 1, "◧ 在 ☰ 右邊");
  assert.ok(g0.rightToggle.right <= g0.close.left, `◨ 在視窗按鈕左邊：${JSON.stringify([g0.rightToggle, g0.close])}`);
  await page.keyboard.press("Control+Shift+L");
  await page.locator("#outline-right:not([hidden]) #assistant-panel").waitFor();
  const g = await geometry(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/narrow-open.png` });
  assert.equal(g.rightPosition, "fixed", "抽屜");
  assert.equal(await page.locator("#outline-right > .right-tabs").isVisible(), true);
  assert.equal(g.corner, true);
  // 抽屜從標題列下面開始：◨ 和視窗按鈕沒有被蓋住，按 ◨ 可以收起抽屜。
  assert.ok(g.right.top >= g.topbar.bottom, `抽屜在標題列下面：${JSON.stringify([g.right, g.topbar])}`);
  const covered = await page.evaluate(() =>
    [".window-close", ".window-min", ".top-actions [data-command='toggle-outline-right']"].filter((sel) => {
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      return !el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    }),
  );
  assert.deepEqual(covered, [], "被抽屜蓋住的按鈕");
  await toggle(page).click();
  await page.locator("#outline-right").waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  await context.close();
});
