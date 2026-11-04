/**
 * 頂端列（Windows 桌面版兼當標題列）：
 * - 側邊欄一路到頂：頂端列左邊那塊和圖示列、側邊欄同底色，邊線對齊；目前面板的標題列在頂端列那一列
 *   （是搬上去，不是多一份），分頁只在內文上方。圖示列不放專案方塊（檔案面板的標題列已經有專案名稱），
 *   換面板時圖示不會跳動。
 * - 右邊：側欄開關、⋯、視窗按鈕是同底色的一塊，和分頁分開；右側欄開著時和右側欄同寬、連成一欄。
 * - 左右兩個側邊欄按鈕開著時同一種樣子（沒有底色、顏色相同）。
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
  if (!(await page.evaluate(() => document.querySelector(".topbar").classList.contains("with-sidebar")))) await page.click(".nav-toggle");
  await page.locator('.nav-toggle[aria-pressed="true"]').waitFor();
  if (!(await page.locator("#panel-files").isVisible())) await page.click("#side-tab-files");
  // 有開專案時圖示列最上面才有專案方塊；假的原生端沒有專案，直接顯示出來看會不會藏起來。
  await page.evaluate(() => (document.querySelector("#activity-project").hidden = false));
  await page.mouse.move(800, 500);
  // 滑鼠離開後的底色有淡出動畫，等它結束。
  await page.waitForTimeout(400);
  return opened;
}

test("側邊欄一路到頂：左上和側邊欄同底色、邊線對齊，面板標題在頂端列那一列，專案方塊不重複、換面板圖示不跳", async () => {
  const { page, context, errors } = await setup();
  const look = await page.evaluate(() => {
    const box = (sel) => document.querySelector(sel).getBoundingClientRect();
    const css = (sel) => getComputedStyle(document.querySelector(sel));
    return {
      sideBg: css(".topbar-side").backgroundColor,
      sidebarBg: css(".sidebar").backgroundColor,
      toggleBg: css(".nav-toggle").backgroundColor,
      activityBg: css(".activity-bar").backgroundColor,
      sideRight: box(".topbar-side").right,
      sidebarRight: box(".sidebar").right,
      toggleRight: box(".nav-toggle").right,
      activityRight: box(".activity-bar").right,
      head: box("#panel-files > .side-head"),
      topbar: box(".topbar"),
      sidebarTop: box(".sidebar").top,
      tabsLeft: box(".tab-bar").left,
      projectShown: !!document.querySelector("#activity-project").getClientRects().length,
    };
  });
  assert.equal(look.sideBg, look.sidebarBg, "左上那塊和側邊欄同底色");
  assert.equal(look.toggleBg, look.activityBg, "側邊欄按鈕那格和圖示列同底色");
  assert.ok(Math.abs(look.sideRight - look.sidebarRight) < 1.5, "邊線和側邊欄的對齊");
  assert.ok(Math.abs(look.toggleRight - look.activityRight) < 1.5, "邊線和圖示列的對齊");
  assert.ok(look.head.top < look.topbar.bottom && look.head.bottom <= look.topbar.bottom + 1, "面板的標題列在頂端列那一列");
  assert.ok(look.tabsLeft >= look.sidebarRight - 1, "分頁只在內文上方");
  assert.equal(look.projectShown, false, "圖示列不放專案方塊");

  // 換到其他面板：標題列換成那個面板的，圖示列的圖示位置不變（不會一下有專案方塊、一下沒有）。
  const iconTop = () => page.evaluate(() => document.querySelector("#side-tab-search").getBoundingClientRect().top);
  const before = await iconTop();
  await page.click("#side-tab-search");
  const other = await page.evaluate(() => ({
    head: document.querySelector("#panel-search > .side-head").getBoundingClientRect().top,
    projectShown: !!document.querySelector("#activity-project").getClientRects().length,
  }));
  assert.ok(other.head < 1, "搜尋面板的標題列也在最上面");
  assert.equal(other.projectShown, false, "其他面板也不放專案方塊");
  assert.equal(await iconTop(), before, "換面板時圖示不跳動");
  // 收起側邊欄也一樣。
  await page.click(".nav-toggle");
  await page.waitForFunction(() => !document.querySelector(".topbar").classList.contains("with-sidebar"));
  assert.equal(await iconTop(), before, "收起側邊欄時圖示不跳動");
  assert.deepEqual(errors, []);
  await context.close();
});

test("右邊的按鈕是同底色的一塊：右側欄開著時和右側欄同寬；左右開關開著時樣子一樣", async () => {
  const { page, context, errors } = await setup();
  const right = page.locator('.top-actions [data-command="toggle-outline-right"]');
  assert.equal(await right.getAttribute("aria-pressed"), "true");
  const look = await page.evaluate(() => {
    const box = (sel) => document.querySelector(sel).getBoundingClientRect();
    const css = (sel) => getComputedStyle(document.querySelector(sel));
    return {
      actionsLeft: box(".top-actions").left,
      columnLeft: box("#outline-right").left,
      actionsBg: css(".top-actions").backgroundColor,
      controlsBg: css(".window-controls").backgroundColor,
      columnBg: css("#outline-right").backgroundColor,
      leftColor: css(".nav-toggle").color,
      leftBg: css(".nav-toggle .icon").backgroundColor,
      rightColor: css('.top-actions [data-command="toggle-outline-right"]').color,
      rightBg: css('.top-actions [data-command="toggle-outline-right"]').backgroundColor,
    };
  });
  assert.ok(Math.abs(look.actionsLeft - look.columnLeft) < 1.5, "右邊那塊和右側欄同寬、邊線對齊");
  assert.equal(look.actionsBg, look.columnBg, "和右側欄同底色");
  assert.equal(look.controlsBg, look.columnBg, "視窗按鈕也是同一塊");
  assert.equal(look.rightBg, "rgba(0, 0, 0, 0)", "右邊的按鈕開著時沒有底色");
  assert.equal(look.leftBg, "rgba(0, 0, 0, 0)");
  assert.equal(look.rightColor, look.leftColor, "左右兩個按鈕開著時顏色一樣");

  // 右側欄關起來：那一塊縮成按鈕的寬度，和分頁之間有邊線隔開。
  await right.click();
  await page.waitForFunction(() => !document.querySelector(".topbar").classList.contains("with-right"));
  const closed = await page.evaluate(() => ({
    actions: document.querySelector(".top-actions").getBoundingClientRect(),
    tabsRight: document.querySelector(".tab-bar").getBoundingClientRect().right,
    border: getComputedStyle(document.querySelector(".top-actions")).borderLeftWidth,
  }));
  assert.ok(closed.actions.width < 160, "只剩按鈕的寬度");
  assert.equal(closed.border, "1px", "左邊一條邊線和分頁隔開");
  assert.ok(closed.tabsRight <= closed.actions.left, "分頁不會蓋到按鈕");
  assert.deepEqual(errors, []);
  await context.close();
});
