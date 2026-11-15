/**
 * 狀態列右邊的檢視切換：視窗不夠寬時只留圖示，但目前選到的那一個照樣顯示名稱；
 * 很窄的視窗、或在設定關掉「檢視切換顯示文字」時全部只有圖示。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, setText } from "./helpers.mjs";

/** 看得到名稱的那幾個模式。 */
const labels = (page) =>
  page.$$eval(".view-switch button", (bs) =>
    bs.filter((b) => b.getClientRects().length && b.querySelector(".label").getClientRects().length).map((b) => b.dataset.view),
  );

test("寬視窗全部有名稱；不夠寬時只有目前的模式有名稱，換模式跟著換；很窄時只有圖示，狀態列不會超出視窗", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  await setText(page, "# 筆記\n\n內容。\n");
  // 起始頁不顯示檢視切換：等文件有內容、切換出現。
  await page.locator(".view-switch").waitFor();
  await page.setViewportSize({ width: 1280, height: 700 });
  assert.deepEqual(await labels(page), ["editor", "live", "split", "preview"]);
  await page.setViewportSize({ width: 900, height: 700 });
  assert.deepEqual(await labels(page), ["live"]);
  await page.click('.statusbar [data-view="preview"]');
  assert.deepEqual(await labels(page), ["preview"]);
  for (const b of await page.$$(".view-switch button")) assert.ok(await b.getAttribute("title"), "其他的名稱在滑鼠提示裡");
  const fits = () =>
    page.evaluate(
      () =>
        document.querySelector(".statusbar").scrollWidth <= document.documentElement.clientWidth &&
        document.querySelector(".view-switch").getBoundingClientRect().right <= innerWidth,
    );
  assert.equal(await fits(), true);
  await page.setViewportSize({ width: 560, height: 700 });
  assert.deepEqual(await labels(page), []);
  assert.equal(await fits(), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("在設定關掉「檢視切換顯示文字」：不管視窗多寬都只有圖示", async () => {
  const { page, context, errors } = await open({ desktop: { load_settings: JSON.stringify({ viewSwitchLabels: false }) } });
  await setText(page, "# 筆記\n");
  await page.locator(".view-switch").waitFor();
  for (const width of [1280, 900]) {
    await page.setViewportSize({ width, height: 700 });
    assert.deepEqual(await labels(page), [], "寬度 " + width);
  }
  assert.deepEqual(errors, []);
  await context.close();
});
