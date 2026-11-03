/**
 * 起始頁顯示在編輯區上面時：編輯區的灰色提示、行號（空白文件的「1」）與目前這一行的底色都收起來，
 * 只留起始頁；開始打字後起始頁消失，行號回來。先執行 `npm run build`，再 `npm run test:e2e`。
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

test("原始碼檢視（不是即時預覽）：起始頁上方不會有目前這一行的灰帶；打字後底色回來", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  await page.locator(".empty-state.in-editor .start-page").waitFor();
  await page.locator(".statusbar button", { hasText: "原始碼" }).click();
  await page.waitForFunction(() => !document.querySelector(".editor-pane .cm-editor")?.classList.contains("cm-lp"));
  await page.locator(".empty-state.in-editor .start-page").waitFor();
  const lineBg = () =>
    page.evaluate(() => {
      const line = document.querySelector(".editor-pane .cm-activeLine");
      return line ? getComputedStyle(line).backgroundColor : "none";
    });
  assert.equal(await lineBg(), "rgba(0, 0, 0, 0)", "起始頁顯示時第一行沒有底色");
  await page.locator(".cm-content").focus();
  await page.keyboard.type("開始寫");
  await page.waitForFunction(() => document.querySelector(".empty-state")?.hidden);
  assert.notEqual(await lineBg(), "rgba(0, 0, 0, 0)", "打字後目前這一行的底色回來");
  assert.deepEqual(errors, []);
  await context.close();
});

test("起始頁的「從範本新增…」不管空白分頁是什麼類型都有", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  const page_ = page.locator(".empty-state.in-editor .start-page");
  await page_.waitFor();
  assert.ok(await page_.getByRole("button", { name: "從範本新增…" }).isVisible(), "Markdown 的空白分頁有");
  // 空白分頁換成別的類型（例如 JSON）：起始頁還在，也還有「從範本新增…」。
  await page.click("#doc-kind");
  await page.locator("#doc-kind-popover button", { hasText: "JSON" }).click();
  assert.equal(await page.textContent("#doc-kind"), "JSON");
  await page_.waitFor();
  await page_.getByRole("button", { name: "從範本新增…" }).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});
