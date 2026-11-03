/**
 * 起始頁顯示在編輯區上面時：編輯區的灰色提示與行號（空白文件的「1」）都收起來，只留起始頁；
 * 開始打字後起始頁消失，行號回來。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

test("起始頁顯示時不露出行號；開始打字後行號回來、位置不變", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  await page.locator(".empty-state.in-editor .start-page").waitFor();
  const look = () =>
    page.evaluate(() => {
      const gutters = document.querySelector(".editor-pane .cm-gutters");
      return {
        gutter: gutters ? getComputedStyle(gutters).visibility : "none",
        left: Math.round(document.querySelector(".editor-pane .cm-content").getBoundingClientRect().left),
        placeholder: document.querySelector(".editor-pane .cm-placeholder")
          ? getComputedStyle(document.querySelector(".editor-pane .cm-placeholder")).display
          : "none",
      };
    });
  const before = await look();
  assert.equal(before.gutter, "hidden", "行號藏起來");
  assert.equal(before.placeholder, "none", "灰色提示收起來");
  await page.locator(".cm-content").focus();
  await page.keyboard.type("開始寫");
  await page.waitForFunction(() => document.querySelector(".empty-state")?.hidden);
  const after = await look();
  assert.equal(after.gutter, "visible", "打字後行號回來");
  assert.equal(after.left, before.left, "內容不會跳動");
  assert.deepEqual(errors, []);
  await context.close();
});
