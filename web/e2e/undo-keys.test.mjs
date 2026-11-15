/**
 * 焦點不在可以輸入的地方時，Ctrl+Z／Ctrl+Y 也會復原、重做文件（app/undo-keys.ts）：在大綱拖曳或用 Alt+↓ 搬移章節之後，
 * 焦點留在大綱的標題上，不用先點回編輯區。輸入框裡的 Ctrl+Z 照舊是輸入框自己的。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const DOC = "# 甲\n\n甲的內容\n\n# 乙\n\n乙的內容\n\n# 丙\n\n丙的內容\n";
/** 文件的原始碼（即時預覽會藏起「#」，所以從 CodeMirror 的 EditorView 讀；內部屬性名稱改版時可能不同）。 */
const doc = (page) =>
  page.evaluate(() => {
    const content = document.querySelector(".cm-content");
    const tile = content?.cmView ?? content?.cmTile;
    return (tile?.view ?? tile?.root?.view).state.doc.toString();
  });
const headings = async (page) => (await doc(page)).split("\n").filter((l) => l.startsWith("# ")).join("");
const link = (page, name) => page.locator("#outline-list a[data-index]", { hasText: name });

/**
 * 把文件內容直接放進編輯器，不用鍵盤打字：打字會在瀏覽器自己的復原紀錄留下步驟，焦點不在編輯區時按 Ctrl+Z
 * 有時會被瀏覽器轉給編輯器而碰巧還原；從檔案開啟的文件沒有這些步驟，實際使用時就沒反應。
 */
async function setup() {
  const opened = await open({ desktop: { load_settings: JSON.stringify({ outlineRight: true }) } });
  const { page } = opened;
  await page.evaluate((text) => {
    const content = document.querySelector(".cm-content");
    const tile = content?.cmView ?? content?.cmTile;
    const view = (tile?.view ?? tile?.root?.view);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, DOC);
  await link(page, "丙").waitFor();
  return opened;
}

test("大綱用 Alt+↓ 搬移章節：焦點在大綱上按 Ctrl+Z 還原、Ctrl+Y 重做", async () => {
  const { page, context, errors } = await setup();
  await link(page, "甲").focus();
  await page.keyboard.press("Alt+ArrowDown");
  await page.waitForFunction(() => document.querySelector("#outline-list a[data-index]")?.textContent === "乙");
  assert.equal(await headings(page), "# 乙# 甲# 丙");
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest("#outline-list")), true, "焦點還在大綱上");
  await page.keyboard.press("Control+Z");
  await page.waitForFunction(() => document.querySelector("#outline-list a[data-index]")?.textContent === "甲");
  assert.equal(await doc(page), DOC);
  await page.keyboard.press("Control+Y");
  await page.waitForFunction(() => document.querySelector("#outline-list a[data-index]")?.textContent === "乙");
  assert.equal(await headings(page), "# 乙# 甲# 丙");
  assert.deepEqual(errors, []);
  await context.close();
});

test("「預覽」模式在大綱拖曳章節：焦點留在大綱的標題上，按 Ctrl+Z 還原", async () => {
  const { page, context, errors } = await setup();
  await page.click('.statusbar [data-view="preview"]');
  await page.locator("#preview h1", { hasText: "丙" }).waitFor();
  await link(page, "丙").dragTo(link(page, "甲"), { targetPosition: { x: 10, y: 2 } });
  await page.waitForFunction(() => document.querySelector("#outline-list a[data-index]")?.textContent === "丙");
  assert.equal(await headings(page), "# 丙# 甲# 乙");
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest("#outline-list")), true, "焦點在大綱上（和實際操作一樣）");
  // 和在預覽拖動段落一樣跳出通知；按通知上的「復原」還原，再拖一次用 Ctrl+Z。
  const undoBtn = page.locator(".toast", { hasText: "已調整順序" }).locator("button", { hasText: "復原" });
  await undoBtn.click();
  await page.waitForFunction(() => document.querySelector("#outline-list a[data-index]")?.textContent === "甲");
  assert.equal(await doc(page), DOC);
  await link(page, "丙").dragTo(link(page, "甲"), { targetPosition: { x: 10, y: 2 } });
  await page.waitForFunction(() => document.querySelector("#outline-list a[data-index]")?.textContent === "丙");
  await page.keyboard.press("Control+Z");
  await page.waitForFunction(() => document.querySelector("#outline-list a[data-index]")?.textContent === "甲");
  assert.equal(await doc(page), DOC);
  assert.equal(await page.locator("#preview h1").first().textContent(), "甲", "預覽也跟著還原");
  assert.deepEqual(errors, []);
  await context.close();
});

test("輸入框裡的 Ctrl+Z 是輸入框自己的：文件不變", async () => {
  const { page, context, errors } = await setup();
  await page.click(".cm-content", { position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+End");
  await page.keyboard.type("新的一行");
  const before = await doc(page);
  assert.match(before, /新的一行$/);
  await page.keyboard.press("Control+F");
  const find = page.locator(".cm-search input[name=search], .cm-panel input").first();
  await find.waitFor();
  await find.fill("內容");
  await page.keyboard.press("Control+Z");
  assert.equal(await doc(page), before, "沒有復原文件");
  assert.deepEqual(errors, []);
  await context.close();
});

test("「☰」→「編輯」有看得到的復原、重做（標著快速鍵）；復原一大步時說明復原了什麼", async () => {
  const { page, context, errors } = await setup();
  await link(page, "甲").focus();
  await page.keyboard.press("Alt+ArrowDown");
  await page.waitForFunction(() => document.querySelector("#outline-list a[data-index]")?.textContent === "乙");
  // 從主選單復原。
  await page.click("#main-menu");
  await page.locator('[role="menu"] [role="menuitem"]', { hasText: "編輯" }).first().hover();
  const undoItem = page.locator('[role="menuitem"]', { hasText: "復原" }).last();
  await undoItem.waitFor();
  assert.match(await undoItem.textContent(), /Ctrl\+Z/);
  assert.match(await page.locator('[role="menuitem"]', { hasText: "重做" }).last().textContent(), /Ctrl\+Y/);
  await undoItem.click();
  await page.waitForFunction(() => document.querySelector("#outline-list a[data-index]")?.textContent === "甲");
  assert.equal(await doc(page), DOC);
  await page.locator(".toast", { hasText: "已復原：調整順序" }).waitFor();
  // 在編輯區裡按 Ctrl+Y 重做（編輯器自己處理的按鍵）：一樣說明。
  await page.click(".cm-content", { position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+Y");
  await page.locator(".toast", { hasText: "已重做：調整順序" }).waitFor();
  assert.equal(await headings(page), "# 乙# 甲# 丙");
  // 一般打字的復原不跳通知。
  await page.keyboard.type("字");
  await page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));
  await page.keyboard.press("Control+Z");
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".toast").count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
