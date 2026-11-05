/**
 * 區塊樣式（設定 → 版面 → 區塊樣式）：圓角區塊、留間隔（預設）或相連。
 * 留間隔時，側邊欄、中間（分頁列＋內文）、右側欄是三塊圓角的區塊，彼此留 4px、上緣對齊；
 * 調整寬度的把手在間隔正中間；窄視窗一律相連；Windows 的視窗按鈕滑到視窗最右上角仍然按得到。
 * 狀態列上檢視切換左邊的那幾項包成一整條圓條；終端機面板也是圓角區塊，終端機（另一個視窗）放在框線與內距裡面。
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
      rightHead: box(".outline-right .side-head"),
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

test("預設圓角區塊；改成相連時側邊欄、內文、右側欄之間沒有間隔；改回圓角區塊後，三塊彼此留 4px、上緣對齊", async () => {
  const { page, context, errors } = await open({ desktop: desktop() });
  await ready(page);
  await page.locator(".outline-right:not([hidden])").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.panelStyle), "spaced");
  await pick(page, "joined");
  await page.waitForTimeout(100);
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
  // 分頁列底下的線（分頁列最後一列）和右側欄第一個分區標題列上緣的線在同一條水平線上。
  assert.equal(b.rightHead.top, b.tabBar.bottom - 1, s);
  // 調整寬度的把手在間隔的正中間。
  const mid = (r) => (r.left + r.right) / 2;
  assert.ok(Math.abs(mid(b.leftResizer) - (b.sidebar.right + b.editor.left) / 2) <= 1, s);
  assert.ok(Math.abs(mid(b.rightResizer) - (b.preview.right + b.right.left) / 2) <= 1, s);
  // 把手不伸進下面的間隔：和卡片一樣高。滑鼠移上去時是跟著滑鼠高度的一小段膠囊，不是整條線；
  // 移到最下面時膠囊也不超出卡片。
  assert.equal(b.leftResizer.bottom, b.sidebar.bottom, s);
  assert.equal(b.rightResizer.bottom, b.right.bottom, s);
  const grip = () =>
    page.locator(".sidebar-resizer.left").evaluate((el) => {
      const g = getComputedStyle(el, "::before");
      return { top: Number.parseFloat(g.top), height: Number.parseFloat(g.height), box: el.getBoundingClientRect().height };
    });
  await page.mouse.move(mid(b.leftResizer), b.leftResizer.top + 150);
  // 滑鼠移上去時看得到（顏色有 0.12 秒的淡入，等它出來）。
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".sidebar-resizer.left"), "::before").backgroundColor !== "rgba(0, 0, 0, 0)");
  let g = await grip();
  assert.equal(g.height, 48, "膠囊 48px");
  assert.equal(g.top, 150, "跟著滑鼠的高度");
  await page.mouse.move(mid(b.leftResizer), b.leftResizer.bottom - 1);
  g = await grip();
  assert.ok(g.top + g.height / 2 <= g.box, `膠囊不超出把手：${JSON.stringify(g)}`);
  assert.deepEqual(errors, []);
  await context.close();
});

test("圓角區塊：沒有右側欄時，分頁列一路到內文的右緣（右上角沒有按鈕時那塊藏起來，分頁列自己收尾）", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ panelStyle: "spaced", outlineRight: false }) });
  await ready(page);
  const b = await boxes(page);
  const s = JSON.stringify(b);
  assert.equal(b.topActions, null, s);
  assert.equal(b.tabBar.top, 4, s);
  assert.equal(b.tabBar.right, b.preview.right, s);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".tab-bar")).borderTopRightRadius), "8px");
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
    if (outlineRight) {
      await ready(page);
      const b = await boxes(page);
      const right = await page.evaluate(() => Math.round(document.querySelector(".window-controls").getBoundingClientRect().right));
      assert.equal(b.topActions.left, b.right.left, JSON.stringify(b));
      assert.equal(right, b.right.right, JSON.stringify(b));
      assert.equal(b.tabBar.right, b.preview.right, JSON.stringify(b));
      assert.equal(b.rightHead.top, b.tabBar.bottom - 1, JSON.stringify(b));
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test("狀態列：相連時那幾項直接排在狀態列上；圓角區塊時包成一整條圓條，和檢視切換、上面的區塊、視窗底部都隔 4px", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ outlineRight: false, panelStyle: "joined" }) });
  await ready(page);
  const pill = () =>
    page.evaluate(() => {
      const items = document.querySelector(".status-items");
      const s = getComputedStyle(items);
      const r = items.getBoundingClientRect();
      const sw = document.querySelector(".view-switch").getBoundingClientRect();
      const stats = document.querySelector("#status-stats").getBoundingClientRect();
      // 中間那塊的右緣：分割檢視時是預覽那一半。
      const card = document.querySelector(".preview-pane").getBoundingClientRect();
      return {
        gaps: {
          above: Math.round(r.top - card.bottom),
          below: Math.round(innerHeight - r.bottom),
          between: Math.round(sw.left - r.right),
          right: Math.round(innerWidth - sw.right),
          cardRight: Math.round(innerWidth - card.right),
        },
        display: s.display,
        radius: s.borderTopLeftRadius,
        statsInside: stats.left >= r.left && stats.right <= r.right,
        sameMiddle: Math.abs(r.top + r.height / 2 - (sw.top + sw.height / 2)) <= 1,
      };
    });
  assert.equal((await pill()).display, "contents");
  await pick(page, "spaced");
  const p = await pill();
  assert.deepEqual([p.display, p.radius, p.statsInside, p.sameMiddle], ["flex", "7px", true, true], JSON.stringify(p));
  // 上下、兩條之間都是 4px；檢視切換的右緣和上面的區塊對齊。
  assert.deepEqual(p.gaps, { above: 4, below: 4, between: 4, right: 4, cardRight: 4 }, JSON.stringify(p));
  assert.deepEqual(errors, []);
  await context.close();
});

test("終端機：圓角區塊時面板是圓角的框，終端機放在框線與內距裡面；換樣式時終端機跟著移", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ outlineRight: false, panelStyle: "joined" }) });
  await ready(page);
  await page.click(".status-terminal");
  await page.locator("#terminal-panel:not([hidden])").waitFor();
  /** 最近一次告訴原生端的終端機位置，以及面板的位置。 */
  const layout = () =>
    page.evaluate(() => {
      const calls = window.__fake.calls.filter((c) => c.cmd === "term_layout" && c.args?.bounds);
      const b = calls.at(-1)?.args.bounds;
      const r = document.querySelector("#terminal-panel").getBoundingClientRect();
      const s = getComputedStyle(document.querySelector("#terminal-panel"));
      return { n: calls.length, bounds: b && Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(v)])), panel: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }, radius: s.borderTopLeftRadius };
    });
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "term_layout" && c.args?.bounds));
  let l = await layout();
  // 相連：上緣 1px 是框線，其他三邊貼齊。
  assert.deepEqual(l.bounds, { x: l.panel.left, y: l.panel.top + 1, width: l.panel.width, height: l.panel.height - 1 }, JSON.stringify(l));
  assert.equal(l.radius, "0px");

  const before = l.n;
  await pick(page, "spaced");
  await page.waitForFunction((n) => window.__fake.calls.filter((c) => c.cmd === "term_layout" && c.args?.bounds).length > n, before);
  await page.waitForTimeout(100);
  l = await layout();
  // 圓角區塊：四邊各扣 1px 框線＋4px 內距；面板和上面的區塊左右對齊。
  assert.deepEqual(l.bounds, { x: l.panel.left + 5, y: l.panel.top + 5, width: l.panel.width - 10, height: l.panel.height - 10 }, JSON.stringify(l));
  assert.equal(l.radius, "8px");
  const editor = await page.evaluate(() => {
    const r = document.querySelector(".sidebar").getBoundingClientRect();
    const e = document.querySelector(".preview-pane").getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(e.right) };
  });
  assert.deepEqual([l.panel.left, l.panel.left + l.panel.width], [editor.left, editor.right], JSON.stringify({ l, editor }));
  assert.deepEqual(errors, []);
  await context.close();
});
