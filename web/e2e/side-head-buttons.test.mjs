/**
 * 側邊欄標題列的按鈕（新增檔案、新增資料夾、重新整理…）一直顯示，不用先把滑鼠移到側邊欄；
 * 寬視窗時標題列在最上面那一列，窄視窗在抽屜裡，兩邊都看得到。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const ROOT = { kind: "folder", path: "/notes", name: "notes" };
const DESKTOP = {
  startup_target: ROOT,
  list_dir: { $by: "path", values: { "/notes": [{ name: "a.md", path: "/notes/a.md", isDir: false }] } },
  // 待辦總覽、標籤的圖示預設收起來：這裡顯示出來。
  load_settings: JSON.stringify({ activityHidden: [] }),
};

/** 按鈕看得到：本身和上層都不透明，按鈕中央沒有被別的東西蓋住。 */
async function assertVisible(page, selector) {
  const state = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    let opacity = 1;
    for (let n = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { opacity, width: r.width, top: Math.round(r.top), onTop: !!hit && el.contains(hit) };
  }, selector);
  assert.equal(state.opacity, 1, `${selector} ${JSON.stringify(state)}`);
  assert.ok(state.width > 0 && state.onTop, `${selector} ${JSON.stringify(state)}`);
  return state;
}

test("寬視窗：滑鼠不在側邊欄上時，標題列（在最上面那一列）的按鈕也看得到，滑鼠移上去變深", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  await page.locator("#files-head").waitFor();
  await page.mouse.move(900, 500);
  for (const id of ["tree-new-file", "tree-new-folder", "tree-refresh"]) {
    const { top } = await assertVisible(page, `#${id}`);
    assert.ok(top < 40, `${id} top ${top}`);
  }
  const color = () => page.$eval("#tree-new-file", (el) => getComputedStyle(el).color);
  const before = await color();
  await page.hover("#tree-new-file");
  assert.notEqual(await color(), before);
  await page.mouse.move(900, 500);

  for (const [tab, button] of [
    ["#side-tab-tasks", "#tasks-refresh"],
    ["#side-tab-tags", "#tags-refresh"],
  ]) {
    await page.click(tab);
    await page.mouse.move(900, 500);
    await assertVisible(page, button);
  }
  assert.deepEqual(errors, []);
  await context.close();
});

test("窄視窗：抽屜裡標題列的按鈕一直顯示", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  await page.locator("#files-head").waitFor();
  await page.setViewportSize({ width: 600, height: 800 });
  await page.waitForFunction(() => document.querySelector(".workspace").classList.contains("narrow"));
  if (!(await page.locator("#sidebar").isVisible())) await page.locator(".nav-toggle").first().click();
  await page.locator("#tree-new-file").waitFor();
  await page.mouse.move(560, 700);
  for (const id of ["tree-new-file", "tree-new-folder", "tree-refresh"]) await assertVisible(page, `#${id}`);
  assert.deepEqual(errors, []);
  await context.close();
});
