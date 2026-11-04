/**
 * 還沒存成檔案的文件用第一個標題命名：分頁、提示、視窗標題、快速開啟、存檔的預設檔名；
 * 空白的叫「未命名」，好幾份時編號且不會重排；自己取的名稱優先；重新開啟後一樣。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open, setText } from "./helpers.mjs";

/** 分頁上的名稱（依顯示的順序）。 */
const names = (page) => page.$$eval("#tab-bar .tab .tab-name", (list) => list.map((n) => n.textContent));

/** 等分頁名稱變成 `want`（名稱在打字停下來、畫面更新後才變）。 */
async function expectNames(page, want) {
  await page
    .waitForFunction((w) => JSON.stringify([...document.querySelectorAll("#tab-bar .tab .tab-name")].map((n) => n.textContent)) === w, JSON.stringify(want), {
      timeout: 5000,
    })
    .catch(() => {});
  assert.deepEqual(await names(page), want);
}

const activeTab = (page) => page.locator("#tab-bar .tab[aria-selected=true]");

async function newTab(page) {
  await page.click("#tab-bar .tab-new");
  await page.waitForFunction(() => document.activeElement?.closest(".cm-content"));
}

test("分頁用第一個標題命名：去掉 # 與行內符號，提示加「（尚未存檔）」，視窗標題與快速開啟也一樣", async () => {
  const { page, context, errors } = await open();
  await setText(page, "前言\n\n## 第三季 **產品** 規劃\n\n# 後面的標題");
  await expectNames(page, ["第三季 產品 規劃"]);
  assert.equal(await activeTab(page).getAttribute("title"), "第三季 產品 規劃（尚未存檔）");
  await page.waitForFunction(() => document.title === "● 第三季 產品 規劃 - oMarker");

  // 改標題：分頁跟著變。
  await setText(page, "# 會議紀錄");
  await expectNames(page, ["會議紀錄"]);

  // 沒有標題時用第一行有字的；太長的截斷加「…」，提示是完整的。
  const long = "一二三四五六七八九十".repeat(4);
  await setText(page, `\n- ${long}\n第二行`);
  await expectNames(page, [`${long.slice(0, 29)}…`]);
  assert.equal(await activeTab(page).getAttribute("title"), `${long}（尚未存檔）`);

  await setText(page, "# 會議紀錄");
  await newTab(page);
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  const options = await page.$$eval("dialog[open] [role=option]", (list) => list.map((o) => o.textContent));
  assert.ok(options.some((o) => o.includes("會議紀錄")), options.join(" | "));
  assert.deepEqual(errors, []);
  await context.close();
});

test("空白文件叫「未命名」，好幾份時編號；其中一份有了標題，其他的編號不變", async () => {
  const { page, context, errors } = await open();
  await setText(page, "# 第一份");
  await newTab(page);
  await newTab(page);
  await expectNames(page, ["第一份", "未命名", "未命名 2"]);
  // 第二份打了字：第三份還是「未命名 2」。
  await page.locator("#tab-bar .tab", { hasText: /^未命名$/ }).click();
  await page.keyboard.insertText("清單第一項");
  await expectNames(page, ["第一份", "清單第一項", "未命名 2"]);
  // 再開一份新的：拿最小的空號。
  await newTab(page);
  await expectNames(page, ["第一份", "清單第一項", "未命名", "未命名 2"]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("自己在分頁上取的名稱優先；重新開啟後分頁名稱不變", async () => {
  const { page, context, errors } = await open();
  await setText(page, "# 自動的名稱");
  await newTab(page);
  await page.keyboard.insertText("# 會被改掉的名稱");
  await expectNames(page, ["自動的名稱", "會被改掉的名稱"]);
  await activeTab(page).dblclick();
  await page.locator("#tab-bar input.tab-rename").fill("週報");
  await page.keyboard.press("Enter");
  await expectNames(page, ["自動的名稱", "週報"]);
  await setText(page, "# 改了標題");
  await page.waitForTimeout(600);
  await expectNames(page, ["自動的名稱", "週報"]);
  assert.equal(await activeTab(page).getAttribute("title"), "週報（尚未存檔）");

  // 草稿寫進瀏覽器之後重新整理：分頁名稱還原。
  await page.waitForFunction(() => Object.keys(localStorage).some((k) => k.startsWith("md-editor:draft:") && localStorage[k] === "# 改了標題"));
  await page.reload();
  await page.waitForSelector(".cm-editor .cm-content");
  await expectNames(page, ["自動的名稱", "週報"]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("存檔對話框的預設檔名是標題（去掉檔名不能用的字元）加副檔名；空白文件是「未命名」", async () => {
  const { page, context, errors } = await open({ desktop: { save_file: { status: "cancelled" } } });
  await page.focus(".cm-content");
  await page.keyboard.insertText('# A/B 測試: "方案"?\n\n內容');
  await expectNames(page, ['A/B 測試: "方案"?']);
  await page.keyboard.press("Control+S");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "save_file"));
  let saves = (await calls(page)).filter((c) => c.cmd === "save_file");
  assert.equal(saves.at(-1).args.suggestedName, "AB 測試 方案.md");

  await page.keyboard.press("Control+N");
  await page.keyboard.insertText("x");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Control+S");
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "save_file").length === 2);
  saves = (await calls(page)).filter((c) => c.cmd === "save_file");
  assert.equal(saves.at(-1).args.suggestedName, "未命名.md");
  assert.deepEqual(errors, []);
  await context.close();
});
