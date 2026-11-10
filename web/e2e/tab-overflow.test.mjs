/**
 * 文件分頁很多時：每個分頁最窄 140px（名稱看得出是哪一份），放不下就左右捲動，
 * 目前的分頁一定捲到看得到的地方，「所有分頁」按鈕出現並列出全部的分頁。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

test("分頁很多：每個最窄 140px，放不下時左右捲動，目前的分頁看得到，「所有分頁」列出全部", async () => {
  const { page, context, errors } = await open();
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.locator(".cm-content").waitFor();
  // 空白的分頁會被新文件取代，所以每一份先打一點內容。
  for (let i = 0; i < 14; i++) {
    await page.locator(".cm-content").focus();
    await page.keyboard.insertText(`# 會議紀錄 ${i + 1}`);
    await page.keyboard.press("Control+Alt+N");
  }
  await page.waitForFunction(() => document.querySelectorAll("#tab-bar .tab").length >= 15);
  const info = await page.evaluate(() => {
    const list = document.querySelector("#tab-bar .tabs");
    const tabs = [...list.querySelectorAll(".tab")];
    const sel = list.querySelector('.tab[aria-selected="true"]').getBoundingClientRect();
    const box = list.getBoundingClientRect();
    return {
      minWidth: Math.min(...tabs.map((t) => t.getBoundingClientRect().width)),
      count: tabs.length,
      scrolls: list.scrollWidth > list.clientWidth,
      selectedVisible: sel.left >= box.left - 1 && sel.right <= box.right + 1,
      moreShown: !document.querySelector("#tab-bar .tab-more").hidden,
    };
  });
  assert.ok(info.minWidth >= 140, `最窄的分頁 ${info.minWidth}px`);
  assert.equal(info.scrolls, true, "放不下時可以左右捲動");
  assert.equal(info.selectedVisible, true, "目前的分頁捲到看得到的地方");
  assert.equal(info.moreShown, true, "「所有分頁」按鈕出現");
  await page.locator("#tab-bar .tab-more").click();
  await page.locator(".tab-more-menu:popover-open").waitFor();
  assert.equal(await page.locator(".tab-more-menu:popover-open button").count(), info.count);
  assert.deepEqual(errors, []);
  await context.close();
});
