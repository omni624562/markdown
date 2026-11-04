/**
 * 區塊樣式（設定 → 版面 → 區塊樣式）：相連（原本）或圓角區塊、留間隔。
 * 留間隔時，側邊欄、中間（分頁列＋內文）、右側欄是三塊圓角的區塊，彼此留 4px、上緣對齊；
 * 調整寬度的把手在間隔正中間；窄視窗一律相連；Windows 的視窗按鈕滑到視窗最右上角仍然按得到。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, runCommand } from "./helpers.mjs";

const ROOT = { kind: "folder", path: "/notes", name: "notes" };
const desktop = (settings = {}, extra = {}) => ({
  startup_target: ROOT,
  list_dir: { $by: "path", values: { "/notes": [{ name: "a.md", path: "/notes/a.md", isDir: false }] } },
  load_settings: JSON.stringify({ outlineRight: true, ...settings }),
  ...extra,
});

/** 各區塊的位置（整數像素）。 */
const boxes = (page) =>
  page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el || !el.getClientRects().length) return null;
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) };
    };
    return {
      topSide: box(".topbar-side"),
      tabBar: box(".tab-bar"),
      topActions: box(".top-actions"),
      sidebar: box(".sidebar"),
      editor: box(".editor-pane"),
      preview: box(".preview-pane"),
      right: box(".outline-right"),
      leftResizer: box(".sidebar-resizer.left"),
      rightResizer: box(".sidebar-resizer.right"),
      radius: getComputedStyle(document.querySelector(".sidebar")).borderBottomLeftRadius,
    };
  });

/** 等側邊欄出來（打開資料夾後），切到分割檢視（左邊原始碼、右邊預覽）。 */
async function ready(page) {
  await page.locator("#files-head").waitFor();
  await page.click('.statusbar [data-view="split"]');
  await page.locator(".preview-pane").waitFor();
}

async function pick(page, value) {
  await runCommand(page, "設定");
  await page.click("dialog[open] [role=tab]:has-text('版面')");
  await page.locator("dialog[open]").getByLabel("區塊樣式").selectOption(value);
  await page.waitForFunction((v) => document.documentElement.dataset.panelStyle === v, value);
  await page.keyboard.press("Escape");
}

test("預設相連：側邊欄、內文、右側欄之間沒有間隔；在設定改成圓角區塊後，三塊彼此留 4px、上緣對齊", async () => {
  const { page, context, errors } = await open({ desktop: desktop() });
  await ready(page);
  await page.locator(".outline-right:not([hidden])").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.panelStyle), "joined");
  let b = await boxes(page);
  assert.equal(b.editor.left, b.sidebar.right, JSON.stringify(b));
  assert.equal(b.right.left, b.preview.right, JSON.stringify(b));
  assert.equal(b.radius, "0px");

  await pick(page, "spaced");
  await page.waitForTimeout(100);
  b = await boxes(page);
  const s = JSON.stringify(b);
  // 間隔 4px。
  assert.equal(b.editor.left - b.sidebar.right, 4, s);
  assert.equal(b.right.left - b.preview.right, 4, s);
  // 三塊的上緣對齊，離頂端 4px；分頁列和下面的內文同寬，右側欄上面那段和右側欄同寬。
  for (const top of [b.topSide.top, b.tabBar.top, b.topActions.top]) assert.equal(top, 4, s);
  assert.equal(b.tabBar.left, b.editor.left, s);
  assert.equal(b.tabBar.right, b.preview.right, s);
  assert.deepEqual([b.topSide.left, b.topSide.right], [b.sidebar.left, b.sidebar.right], s);
  assert.deepEqual([b.topActions.left, b.topActions.right], [b.right.left, b.right.right], s);
  assert.equal(b.radius, "8px");
  // 調整寬度的把手在間隔的正中間。
  const mid = (r) => (r.left + r.right) / 2;
  assert.ok(Math.abs(mid(b.leftResizer) - (b.sidebar.right + b.editor.left) / 2) <= 1, s);
  assert.ok(Math.abs(mid(b.rightResizer) - (b.preview.right + b.right.left) / 2) <= 1, s);
  assert.deepEqual(errors, []);
  await context.close();
});

test("圓角區塊：沒有右側欄時，右上角的按鈕在分頁列那一條裡，和內文的右緣對齊", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ panelStyle: "spaced", outlineRight: false }) });
  await ready(page);
  const b = await boxes(page);
  const s = JSON.stringify(b);
  assert.equal(b.tabBar.right, b.topActions.left, s);
  assert.equal(b.topActions.top, 4, s);
  assert.equal(b.topActions.right, b.preview.right, s);
  assert.deepEqual(errors, []);
  await context.close();
});

test("圓角區塊：窄視窗一律相連（側邊欄是抽屜）", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ panelStyle: "spaced" }) });
  await page.setViewportSize({ width: 700, height: 800 });
  await page.waitForTimeout(200);
  const style = await page.evaluate(() => {
    const ws = getComputedStyle(document.querySelector(".workspace"));
    return { padding: ws.paddingRight, tabTop: Math.round(document.querySelector(".tab-bar").getBoundingClientRect().top) };
  });
  assert.deepEqual(style, { padding: "0px", tabTop: 0 });
  assert.deepEqual(errors, []);
  await context.close();
});

test("圓角區塊（Windows 自訂標題列）：視窗按鈕在最右邊那塊的右上角，滑到視窗最右上角仍然按得到關閉", async () => {
  for (const outlineRight of [true, false]) {
    const { page, context, errors } = await open({
      desktop: desktop({ panelStyle: "spaced", outlineRight }, { custom_title_bar: true }),
    });
    await page.locator(".window-close").waitFor();
    const r = await page.evaluate(() => {
      const close = document.querySelector(".window-close");
      const box = close.getBoundingClientRect();
      const corner = document.elementFromPoint(innerWidth - 1, 1);
      return { right: Math.round(innerWidth - box.right), top: Math.round(box.top), corner: corner === close };
    });
    assert.deepEqual(r, { right: 5, top: 5, corner: true }, `outlineRight=${outlineRight}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
