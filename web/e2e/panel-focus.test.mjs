/**
 * 從圖示列或「顯示搜尋」「顯示標籤」指令打開搜尋、標籤面板時，游標直接在輸入框裡，可以馬上打字；
 * 其他面板不動焦點，啟動時還原面板也不搶焦點。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const ROOT = { kind: "folder", path: "/notes", name: "notes" };
const DESKTOP = {
  startup_target: ROOT,
  list_dir: { $by: "path", values: { "/notes": [{ name: "a.md", path: "/notes/a.md", isDir: false }] } },
  // 標籤圖示預設收起來：這裡顯示出來。
  load_settings: JSON.stringify({ activityHidden: [] }),
};

const active = (page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.getAttribute("aria-label") || document.activeElement?.tagName);

/** 從指令面板執行（開啟資料夾後的空白文件顯示起始頁，不先點編輯區）。 */
async function runCommand(page, query) {
  await page.keyboard.press("Control+Shift+P");
  const input = page.locator("dialog[open] input").first();
  await input.waitFor();
  await input.fill(query);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
}

test("按圖示列的搜尋、標籤：游標直接在輸入框，馬上可以打字；其他面板不動焦點", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  await page.locator("#panel-files").waitFor();

  await page.locator("#side-tab-search").click();
  assert.equal(await active(page), "search-input");
  await page.keyboard.type("週報");
  assert.equal(await page.inputValue("#search-input"), "週報");

  await page.locator("#side-tab-tags").click();
  const filter = page.locator("#tags-host input");
  assert.equal(await filter.evaluate((el) => el === document.activeElement), true);
  await page.keyboard.type("專案");
  assert.equal(await filter.inputValue(), "專案");

  // 其他面板：焦點留在圖示上（方向鍵可以繼續切換）。
  await page.locator("#side-tab-files").click();
  assert.equal(await active(page), "side-tab-files");

  // 再打開搜尋：游標回到輸入框，選取上次的字，直接打字就換掉。
  await page.locator("#side-tab-search").click();
  assert.equal(await active(page), "search-input");
  await page.keyboard.type("月報");
  assert.equal(await page.inputValue("#search-input"), "月報");
  assert.deepEqual(errors, []);
  await context.close();
});

test("「顯示搜尋」「顯示標籤」指令：游標直接在輸入框", async () => {
  const { page, context, errors } = await open({ desktop: DESKTOP });
  await page.locator("#panel-files").waitFor();
  await runCommand(page, "顯示搜尋");
  await page.waitForFunction(() => document.activeElement?.id === "search-input");
  // 指令面板關掉之後焦點沒有被拿回去。
  await page.waitForTimeout(300);
  assert.equal(await active(page), "search-input");
  await runCommand(page, "顯示標籤");
  const filter = page.locator("#tags-host input");
  await page.waitForFunction(() => document.activeElement === document.querySelector("#tags-host input"));
  await page.keyboard.type("專案");
  assert.equal(await filter.inputValue(), "專案");
  assert.deepEqual(errors, []);
  await context.close();
});

test("啟動時還原搜尋面板：不搶焦點", async () => {
  // 不帶資料夾啟動（帶資料夾時會改開檔案面板），上次開著的搜尋面板會還原。
  const { page, context, errors } = await open({ desktop: { load_settings: DESKTOP.load_settings } });
  await page.locator("#side-tab-search").click();
  assert.equal(await active(page), "search-input");
  await page.reload();
  await page.waitForSelector(".cm-editor .cm-content");
  await page.locator("#panel-search").waitFor();
  await page.waitForTimeout(800);
  assert.notEqual(await active(page), "search-input");
  assert.deepEqual(errors, []);
  await context.close();
});
