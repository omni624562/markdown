/**
 * 右側欄的分頁列與 Windows 的視窗按鈕：右側欄開著時頂端列橫跨整個視窗，右上角那塊（開關＋視窗按鈕）和右側欄同寬、同底色，
 * 分頁列是右側欄自己的第一列（不在頂端列，右側欄再窄也不會被視窗按鈕擠掉），
 * 視窗按鈕貼在視窗右上角；右側欄收起時那塊縮成只剩開關；視窗不夠寬時助理是抽屜，開關排在 ☰ 左邊。
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
      tabs: box("#outline-right > .right-tabs"),
      right: box("#outline-right"),
      panel: box("#assistant-panel"),
      topbar: box(".topbar"),
      tabBar: box(".tab-bar"),
      actionsBg: css(".top-actions").backgroundColor,
      rightBg: css("#outline-right").backgroundColor,
      controlsBg: css(".window-controls").backgroundColor,
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

test("寬視窗：助理開著時右上角那塊（開關＋視窗按鈕）和右側欄同寬，分頁列在右側欄最上面、同底色，視窗按鈕在右上角；收起後縮成開關，視窗按鈕還在右上角", async () => {
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
  assert.equal(g.actions.left, g.right.left, "右上角那塊和右側欄左緣對齊");
  assert.equal(g.actionsBg, g.rightBg, "和右側欄同底色");
  assert.equal(g.controlsBg, g.rightBg, "視窗按鈕也是同一塊");
  assert.ok(g.panel.top >= g.topbar.bottom - 1, "助理從頂端列下面開始");
  assert.ok(g.tabBar.right <= g.right.left, "分頁列只到右側欄左邊為止");
  assert.equal(g.selected, "assistant", "分頁列選著「助理」");
  assert.ok(g.tabs.top >= g.topbar.bottom - 1 && g.tabs.left >= g.right.left && g.tabs.right <= g.right.right, `分頁列在右側欄裡、頂端列下面：${JSON.stringify([g.tabs, g.right, g.topbar])}`);
  assert.ok(g.panel.top >= g.tabs.bottom - 1, "助理在分頁列下面");
  // 收起：那塊縮成只剩開關，視窗按鈕還是貼在右上角。
  await toggle(page).click();
  await page.locator("#outline-right").waitFor({ state: "hidden" });
  const c = await geometry(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/wide-closed.png` });
  assert.equal(c.corner, true);
  assert.equal(c.pressed, "false");
  assert.equal(c.tabs, null, "分頁列藏起來");
  assert.ok(c.actions.right - c.actions.left < 60, JSON.stringify(c.actions));
  assert.ok(c.tabBar.right > g.tabBar.right, "文件分頁拿回空間");
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

test("相連樣式、大綱放右邊：分頁列有大綱、反向連結、助理，那塊和右側欄對齊，視窗按鈕在右上角", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ panelStyle: "joined", outlineRight: true }) });
  await start(page);
  await page.locator("#outline-right:not([hidden]) #panel-outline").waitFor();
  assert.deepEqual(await page.locator("#outline-right .right-tab:not([hidden]) .right-tab-label").allTextContents(), ["大綱", "反向連結", "助理"]);
  await page.locator("#outline-right .right-tab[data-tab='assistant']").click();
  await page.locator("#outline-right #assistant-panel:not([hidden])").waitFor();
  const g = await geometry(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/joined-outline-open.png` });
  assert.equal(g.actions.left, g.right.left, "右上角那塊和右側欄對齊");
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

test("圓角區塊：助理開著時那塊和右側欄上緣對齊，視窗按鈕在右上角仍按得到", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ panelStyle: "spaced" }) });
  await start(page);
  await page.keyboard.press("Control+Shift+L");
  await page.locator("#outline-right:not([hidden]) #assistant-panel").waitFor();
  const g = await geometry(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/spaced-open.png` });
  assert.equal(g.corner, true);
  assert.equal(g.actions.left, g.right.left, JSON.stringify(g));
  assert.deepEqual(errors, []);
  await context.close();
});

test("視窗不夠寬：助理是抽屜（分頁列在抽屜最上面），開關排在 ☰ 左邊，☰ 在視窗按鈕左邊", async () => {
  const { page, context, errors } = await open({ desktop: desktop() });
  await page.setViewportSize({ width: 700, height: 600 });
  await start(page);
  const g0 = await geometry(page);
  assert.ok(g0.actions.right <= g0.navMenu.left, `開關在 ☰ 左邊：${JSON.stringify([g0.actions, g0.navMenu])}`);
  assert.ok(g0.navMenu.right <= g0.close.left, "☰ 在視窗按鈕左邊");
  await page.keyboard.press("Control+Shift+L");
  await page.locator("#outline-right:not([hidden]) #assistant-panel").waitFor();
  const g = await geometry(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/narrow-open.png` });
  assert.equal(g.rightPosition, "fixed", "抽屜");
  assert.equal(await page.locator("#outline-right > .right-tabs").isVisible(), true);
  assert.equal(g.corner, true);
  assert.deepEqual(errors, []);
  await context.close();
});
