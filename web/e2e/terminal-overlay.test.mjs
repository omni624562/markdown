/**
 * 終端機（疊在主畫面上的另一個 webview）不會蓋住主畫面的選單：選單蓋到終端機的位置時先把終端機藏起來，
 * 選單關掉後再顯示。用假的原生端（見 helpers.mjs）記錄告訴原生端的終端機位置（term_layout，null 是藏起來）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

/** 最近一次告訴原生端的終端機位置（null：藏起來）。 */
const lastLayout = (page) =>
  page.evaluate(() => window.__fake.calls.filter((c) => c.cmd === "term_layout").at(-1)?.args.bounds ?? null);
const waitLayout = (page, shown) =>
  page.waitForFunction(
    (shown) => {
      const last = window.__fake.calls.filter((c) => c.cmd === "term_layout").at(-1);
      return last && !!last.args.bounds === shown;
    },
    shown,
  );

test("選單蓋到終端機時先把終端機藏起來，關掉選單後再顯示", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  await page.setViewportSize({ width: 1100, height: 640 });
  await page.click(".status-terminal");
  await page.locator("#terminal-panel:not([hidden])").waitFor();
  await waitLayout(page, true);

  // 「☰」選單從左上角往下長，蓋到下方的終端機。
  await page.click("#main-menu");
  const menu = page.locator("#main-menu-popover");
  await menu.waitFor();
  const overlaps = await page.evaluate(() => {
    const m = document.querySelector("#main-menu-popover").getBoundingClientRect();
    const t = document.querySelector("#terminal-panel").getBoundingClientRect();
    return m.bottom > t.top && m.left < t.right;
  });
  assert.ok(overlaps, "選單要蓋到終端機的位置，這個測試才有意義");
  await waitLayout(page, false);
  assert.equal(await lastLayout(page), null);
  // 面板本身還開著（只是原生的終端機暫時藏起來）。
  assert.equal(await page.locator("#terminal-panel").isVisible(), true);

  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  await waitLayout(page, true);
  const bounds = await lastLayout(page);
  assert.ok(bounds.width > 0 && bounds.height > 0, JSON.stringify(bounds));
  assert.deepEqual(errors, []);
  await context.close();
});

test("通知不會讓終端機藏起來", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  await page.setViewportSize({ width: 1100, height: 640 });
  await page.click(".status-terminal");
  await page.locator("#terminal-panel:not([hidden])").waitFor();
  await waitLayout(page, true);
  const before = await page.evaluate(() => window.__fake.calls.filter((c) => c.cmd === "term_layout").length);
  // 通知區也是 popover（在畫面右下角，常會蓋到終端機）：直接放一則通知進去。
  await page.evaluate(() => {
    const region = document.querySelector(".toasts");
    const el = document.createElement("div");
    el.className = "toast toast-info";
    el.textContent = "測試通知";
    region.append(el);
    if (!region.matches(":popover-open")) region.showPopover();
  });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => window.__fake.calls.filter((c) => c.cmd === "term_layout").slice(-1)[0]);
  assert.ok(after.args.bounds, "通知出現時終端機仍然顯示");
  // 沒有因為通知而多送「藏起來」。
  const hides = await page.evaluate((n) => window.__fake.calls.filter((c) => c.cmd === "term_layout").slice(n).filter((c) => !c.args.bounds).length, before);
  assert.equal(hides, 0);
  assert.deepEqual(errors, []);
  await context.close();
});
