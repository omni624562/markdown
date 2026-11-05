/**
 * 狀態列的語言選單：按鈕顯示語言（.yaml 檔是「YAML」）；選了語言就用那個語言上色；
 * 「更多語言…」可以打字找（例如 py）；選過的語言列在「最近用過」；「自動（依副檔名）」改回依副檔名；
 * 「純文字」不上色。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, setText } from "./helpers.mjs";

const label = (page) => page.locator("#doc-kind span").first().textContent();
/** 編輯器裡有上色的字（CodeMirror 的語法上色會包一層有 class 的 span）。 */
const colored = (page) => page.locator(".cm-content .cm-line span[class]").count();

async function pick(page, text) {
  await page.click("#doc-kind");
  await page.locator("#doc-kind-popover button", { hasText: text }).first().click();
}

test("語言選單：選語言就換上色與副檔名；更多語言可以打字找；最近用過；自動、純文字", async () => {
  const { page, context, errors } = await open();
  await setText(page, "name: contoso\nport: 8080\n");
  assert.equal(await label(page), "Markdown");

  // 選 YAML：改成純文字類型、用 YAML 上色。
  await pick(page, "YAML");
  await page.waitForFunction(() => document.querySelector("#doc-kind span")?.textContent === "YAML");
  await page.waitForFunction(() => document.querySelectorAll(".cm-content .cm-line span[class]").length > 0);
  // 選單上方多了「自動（依副檔名）」，資料與設定一區裡 YAML 打勾。
  await page.click("#doc-kind");
  const menu = page.locator("#doc-kind-popover");
  await menu.locator(".menu-head", { hasText: "資料與設定" }).waitFor();
  assert.equal(await menu.locator('button[aria-checked="true"]').textContent(), "YAML");
  assert.equal(await menu.locator("button", { hasText: "自動（依副檔名）" }).count(), 1);
  await page.keyboard.press("Escape");

  // 更多語言：打 py 找到 Python。
  await pick(page, "更多語言…");
  const input = page.locator("dialog[open].palette input");
  await input.fill("py");
  assert.equal(await page.locator("dialog[open].palette li").first().locator(".palette-title").textContent(), "Python");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#doc-kind span")?.textContent === "Python");

  // 最近用過：Python（YAML 已經在「資料與設定」，不重複列）。
  await page.click("#doc-kind");
  await menu.locator(".menu-head", { hasText: "最近用過" }).waitFor();
  assert.equal(await menu.locator("button", { hasText: "Python" }).count(), 1);
  await page.keyboard.press("Escape");

  // 純文字：不上色。
  await pick(page, "純文字");
  await page.waitForFunction(() => document.querySelector("#doc-kind span")?.textContent === "純文字");
  await page.waitForFunction(() => document.querySelectorAll(".cm-content .cm-line span[class]").length === 0);
  assert.equal(await colored(page), 0);

  // 自動：依副檔名（.py）又變回 Python。
  await pick(page, "自動（依副檔名）");
  await page.waitForFunction(() => document.querySelector("#doc-kind span")?.textContent === "Python");

  // Markdown：換回 Markdown。
  await pick(page, "Markdown");
  await page.waitForFunction(() => document.querySelector("#doc-kind span")?.textContent === "Markdown");
  assert.deepEqual(errors, []);
  await context.close();
});
