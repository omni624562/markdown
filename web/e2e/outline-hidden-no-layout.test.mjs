/**
 * 大綱沒有顯示時（預設收著），切換分頁、打字不去量標題的位置、也不捲動大綱：
 * 量位置會逼瀏覽器把整份長文件排版一次（長文件切換分頁時多花好幾百毫秒）。打開大綱時才標示目前的段落。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, setText } from "./helpers.mjs";

const doc = (name) => Array.from({ length: 40 }, (_, i) => `## ${name} 第 ${i + 1} 節\n\n內容。\n`).join("\n");

test("大綱收著時：換文件不捲動大綱；打開大綱時才標示目前的段落", async () => {
  const { page, context, errors } = await open();
  // 大綱放在左邊的側邊欄、側邊欄收著（右邊的大綱預設是開著的）。
  await page.evaluate(() => localStorage.setItem("md-editor:settings", JSON.stringify({ outlineRight: false })));
  await page.reload();
  await page.waitForSelector(".cm-editor .cm-content");
  if (await page.locator("#outline-list").isVisible()) await page.click("#side-tab-outline");
  assert.equal(await page.locator("#outline-list").isVisible(), false, "大綱收著");
  await setText(page, doc("甲"));
  // 記下大綱的連結被捲動了幾次。
  await page.evaluate(() => {
    window.__outlineScrolls = 0;
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...args) {
      if (this.closest?.("#outline-list, .outline-list")) window.__outlineScrolls++;
      return orig.apply(this, args);
    };
  });
  await page.keyboard.press("Control+N");
  await setText(page, doc("乙"));
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__outlineScrolls), 0, "大綱收著時不捲動它");
  // 打開大綱：標示目前讀到的段落。
  await page.click("#side-tab-outline");
  await page.waitForFunction(() => document.querySelector("#outline-list a[aria-current=location]")?.textContent.includes("乙 第"));
  assert.deepEqual(errors, []);
  await context.close();
});
