/**
 * 起始頁顯示在編輯區上面時：編輯區的灰色提示、行號（空白文件的「1」）、目前這一行的底色、空白行的「＋」
 * 與游標都收起來，只留起始頁；開始打字後起始頁消失，行號、游標回來。先執行 `npm run build`，再 `npm run test:e2e`。
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

test("清空文件回到起始頁：左上角不會留著空白行的「＋」和游標；再打字就回來", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  await page.locator(".empty-state.in-editor .start-page").waitFor();
  await page.locator(".cm-content").focus();
  await page.keyboard.type("寫一點");
  await page.waitForFunction(() => document.querySelector(".empty-state")?.hidden);
  // 全選刪掉：起始頁又出現，編輯區還是有焦點（可以直接打字）。
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.locator(".empty-state.in-editor:not([hidden]) .start-page").waitFor();
  const look = () =>
    page.evaluate(() => {
      const handle = document.querySelector(".editor-pane .cm-insert-handle");
      const cursor = document.querySelector(".editor-pane .cm-cursorLayer");
      return {
        focused: document.querySelector(".editor-pane .cm-editor").classList.contains("cm-focused"),
        handle: !!handle && handle.getClientRects().length > 0 && getComputedStyle(handle).visibility !== "hidden",
        cursor: !!cursor && getComputedStyle(cursor).visibility !== "hidden",
      };
    });
  const cleared = await look();
  assert.equal(cleared.focused, true, "編輯區還有焦點");
  assert.equal(cleared.handle, false, "起始頁顯示時沒有空白行的「＋」");
  assert.equal(cleared.cursor, false, "起始頁顯示時看不到游標");
  await page.keyboard.type("再寫");
  await page.waitForFunction(() => document.querySelector(".empty-state")?.hidden);
  const typed = await look();
  assert.equal(typed.cursor, true, "打字後游標回來");
  assert.deepEqual(errors, []);
  await context.close();
});

test("原始碼檢視（不是即時預覽）：起始頁上方不會有目前這一行的灰帶；打字後底色回來", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  // 起始頁上沒有檢視切換：用上次記住的檢視（原始碼）開啟。
  await page.evaluate(() => localStorage.setItem("md-editor:view", "editor"));
  await page.reload();
  await page.locator(".empty-state.in-editor .start-page").waitFor();
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
