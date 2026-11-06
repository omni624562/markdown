/**
 * 選取文字後貼上網址：變成連結 `[文字](網址)`；沒有選取、在程式碼裡時照原樣貼上。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const URL = "https://ado.test/tfs/DefaultCollection/產品/_wiki/規格";

/** 用假的剪貼簿資料觸發貼上（和從瀏覽器網址列複製一樣，只有純文字）。 */
const paste = (page, text) =>
  page.locator(".cm-content").evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
  }, text);

const docText = (page) => page.evaluate(() => [...document.querySelectorAll(".cm-content .cm-line")].map((l) => l.textContent).join("\n"));

/** 選取第 `line` 行（從 1 起算）裡的 `word`。 */
async function selectWord(page, line, word) {
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+Home");
  for (let i = 1; i < line; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  const text = (await docText(page)).split("\n")[line - 1];
  const at = text.indexOf(word);
  for (let i = 0; i < at; i++) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < word.length; i++) await page.keyboard.press("Shift+ArrowRight");
}

test("選取文字後貼上網址：變成連結；沒有選取時照原樣貼上網址", async () => {
  const { page, context, errors } = await open();
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText("請先看規格文件再開始。\n\n```\n範例程式\n```\n");
  // 原始碼模式：連結的符號不會被即時預覽藏起來。
  await page.locator(".view-switch button", { hasText: "原始碼" }).click();
  await selectWord(page, 1, "規格文件");
  await paste(page, URL);
  await page.waitForFunction(() => document.querySelector(".cm-content .cm-line")?.textContent.includes("]("));
  assert.equal((await docText(page)).split("\n")[0], `請先看[規格文件](${URL})再開始。`);

  // 程式碼區塊裡：照原樣貼上。
  await selectWord(page, 4, "範例");
  await paste(page, URL);
  await page.waitForTimeout(200);
  assert.equal((await docText(page)).split("\n")[3], `${URL}程式`);

  // 沒有選取：貼上網址本身。
  await page.keyboard.press("Control+End");
  await paste(page, "https://example.test/週報");
  await page.waitForTimeout(200);
  assert.match(await docText(page), /https:\/\/example\.test\/週報$/);
  assert.deepEqual(errors, []);
  await context.close();
});
