/**
 * 簡報模式：按 ✕、按 Esc 結束後，游標回到編輯器，可以直接打字。
 * 全螢幕還沒結束前頁面其他部分不能取得焦點，要等離開全螢幕後才放回編輯器。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, runCommand, setText } from "./helpers.mjs";

const inEditor = (page) => page.evaluate(() => !!document.activeElement?.closest(".cm-editor"));

async function play(page) {
  await setText(page, "# 第一頁\n\n內容\n\n---\n\n# 第二頁\n\n結尾");
  await runCommand(page, "簡報模式：從頭播放");
  await page.waitForSelector(".slideshow:not([hidden])");
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains("slideshow"));
}

test("按 ✕ 結束簡報：離開全螢幕，游標回到編輯器", async () => {
  const { page, context, errors } = await open();
  await play(page);
  await page.locator(".slideshow .slide-exit").click();
  await page.waitForSelector(".slideshow", { state: "hidden" });
  await page.waitForFunction(() => !document.fullscreenElement);
  await page.waitForFunction(() => !!document.activeElement?.closest(".cm-editor"));
  assert.equal(await inEditor(page), true);
  await page.keyboard.press("Control+End");
  await page.keyboard.type("補充");
  assert.match(await page.locator(".cm-content").first().textContent(), /結尾補充/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("按 Esc 結束簡報：游標回到編輯器", async () => {
  const { page, context, errors } = await open();
  await play(page);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".slideshow", { state: "hidden" });
  await page.waitForFunction(() => !document.fullscreenElement);
  await page.waitForFunction(() => !!document.activeElement?.closest(".cm-editor"));
  assert.equal(await inEditor(page), true);
  assert.deepEqual(errors, []);
  await context.close();
});
