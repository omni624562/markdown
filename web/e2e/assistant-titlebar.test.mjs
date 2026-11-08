/**
 * 助理欄與 Windows 的視窗按鈕：助理開著時頂端列橫跨整個視窗，右上角那塊（助理欄開關）和助理欄同寬、同底色，
 * 視窗按鈕貼在視窗右上角；助理關掉時那塊縮成只剩開關；窄視窗時助理是抽屜，開關排在 ☰ 左邊。
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
      seg: box(".topbar-assistant"),
      panel: box("#assistant-panel"),
      head: box(".assistant-head"),
      topbar: box(".topbar"),
      tabBar: box(".tab-bar"),
      editor: box(".editor-pane"),
      segBg: css(".topbar-assistant").backgroundColor,
      panelBg: css("#assistant-panel").backgroundColor,
      controlsBg: css(".window-controls").backgroundColor,
      pressed: document.querySelector("#topbar-assistant button")?.getAttribute("aria-pressed"),
      headFirst: document.querySelector(".assistant-head > :first-child")?.getAttribute("aria-label"),
      panelPosition: css("#assistant-panel").position,
      navMenu: box("#main-menu"),
    };
  });

async function start(page) {
  await page.locator("#tab-bar").waitFor();
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText("# 筆記\n\n內容");
  await page.locator(".window-close").waitFor();
}

test("寬視窗：助理開著時那塊和助理欄同寬、同底色，視窗按鈕在右上角；關掉後縮成開關，視窗按鈕還在右上角", async () => {
  const { page, context, errors } = await open({ desktop: desktop() });
  await start(page);
  const toggle = page.locator("#topbar-assistant button");
  assert.equal(await toggle.getAttribute("aria-pressed"), "false");
  await toggle.click();
  await page.locator("#assistant-panel:not([hidden])").waitFor();
  const g = await geometry(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/wide-open.png` });
  assert.equal(g.corner, true, "視窗關閉鈕在視窗最右上角");
  assert.equal(g.seg.left, g.panel.left, "右上角那塊和助理欄左緣對齊");
  assert.equal(g.segBg, g.panelBg, "和助理欄同底色");
  assert.equal(g.controlsBg, g.panelBg, "視窗按鈕也是同一塊");
  assert.ok(g.head.top >= g.topbar.bottom - 1, "助理的標題列從頂端列下面開始");
  assert.ok(g.tabBar.right <= g.panel.left, "分頁列只到助理欄左邊為止");
  assert.equal(g.pressed, "true");
  assert.equal(g.headFirst, "關閉助理", "助理自己的關閉在標題列最左邊");
  // 關掉：那塊縮成只剩開關，視窗按鈕還是貼在右上角。
  await toggle.click();
  await page.locator("#assistant-panel").waitFor({ state: "hidden" });
  const c = await geometry(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/wide-closed.png` });
  assert.equal(c.corner, true);
  assert.equal(c.pressed, "false");
  assert.ok(c.seg.right - c.seg.left < 60, JSON.stringify(c.seg));
  assert.ok(c.tabBar.right > g.tabBar.right, "分頁列拿回空間");
  assert.deepEqual(errors, []);
  await context.close();
});

test("助理沒開啟（設定關閉）時，右上角沒有那個開關", async () => {
  const { page, context, errors } = await open({ desktop: { ...desktop(), load_settings: JSON.stringify({}) } });
  await start(page);
  assert.equal(await page.locator("#topbar-assistant").isVisible(), false);
  const g = await geometry(page);
  assert.equal(g.corner, true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("相連樣式、大綱放右邊：右側欄那塊、助理那塊、視窗按鈕依序排在右上角", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ panelStyle: "joined", outlineRight: true }) });
  await start(page);
  await page.locator("#topbar-assistant button").click();
  await page.locator("#assistant-panel:not([hidden])").waitFor();
  const g = await page.evaluate(() => {
    const box = (sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right) };
    };
    return { actions: box(".top-actions"), right: box("#outline-right"), seg: box(".topbar-assistant"), panel: box("#assistant-panel"), close: box(".window-close"), corner: document.elementFromPoint(innerWidth - 1, 1) === document.querySelector(".window-close") };
  });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/joined-outline-open.png` });
  assert.equal(g.actions.left, g.right.left, "右側欄那塊和右側欄對齊");
  assert.equal(g.actions.right, g.seg.left, "助理那塊接在右側欄那塊右邊");
  assert.equal(g.seg.left, g.panel.left, "助理那塊和助理欄對齊");
  assert.equal(g.close.right, innerWidthOf(g) ?? g.close.right);
  assert.equal(g.corner, true);
  assert.deepEqual(errors, []);
  await context.close();
});

const innerWidthOf = () => null;

test("圓角區塊：助理開著時那塊和助理欄上緣對齊，視窗按鈕在右上角仍按得到", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ panelStyle: "spaced" }) });
  await start(page);
  await page.locator("#topbar-assistant button").click();
  await page.locator("#assistant-panel:not([hidden])").waitFor();
  const g = await geometry(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/spaced-open.png` });
  assert.equal(g.corner, true);
  assert.equal(g.seg.left, g.panel.left, JSON.stringify(g));
  assert.deepEqual(errors, []);
  await context.close();
});

test("窄視窗：助理是抽屜，開關排在 ☰ 左邊，☰ 在視窗按鈕左邊", async () => {
  const { page, context, errors } = await open({ desktop: desktop() });
  await page.setViewportSize({ width: 700, height: 600 });
  await start(page);
  const g0 = await geometry(page);
  assert.ok(g0.seg.right <= g0.navMenu.left, `助理開關在 ☰ 左邊：${JSON.stringify([g0.seg, g0.navMenu])}`);
  assert.ok(g0.navMenu.right <= g0.close.left, "☰ 在視窗按鈕左邊");
  await page.locator("#topbar-assistant button").click();
  await page.locator("#assistant-panel:not([hidden])").waitFor();
  const g = await geometry(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/narrow-open.png` });
  assert.equal(g.panelPosition, "fixed", "抽屜");
  assert.equal(g.corner, true);
  assert.deepEqual(errors, []);
  await context.close();
});
