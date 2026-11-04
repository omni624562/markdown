/**
 * 有危險動作的確認對話框都是同一種排法：取消在左、危險的動作（紅色）在右，
 * 一開始聚焦的不是危險的動作，按 Enter 不會誤刪、誤丟掉變更。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

/** 對話框的按鈕（由左到右）：文字、紅色、主要、聚焦。 */
const buttons = (page) =>
  page.$$eval("dialog[open].choice .choice-actions button", (list) =>
    list.map((b) => ({
      label: b.textContent,
      danger: b.classList.contains("btn-danger"),
      primary: b.classList.contains("btn-primary"),
      focused: document.activeElement === b,
    })),
  );

test("檔案面板刪除：取消在左（預設聚焦），移到資源回收筒在右；直接按 Enter 不會刪", async () => {
  const { page, context, errors } = await open({
    desktop: {
      startup_target: { kind: "folder", path: "/notes", name: "notes" },
      list_dir: { $by: "path", values: { "/notes": [{ name: "a.md", path: "/notes/a.md", isDir: false }] } },
    },
  });
  await page.locator('#file-tree .tree-row[data-path="/notes/a.md"]').focus();
  await page.keyboard.press("Delete");
  await page.locator("dialog[open].choice").waitFor();
  assert.deepEqual(await buttons(page), [
    { label: "取消", danger: false, primary: false, focused: true },
    { label: "移到資源回收筒", danger: true, primary: false, focused: false },
  ]);
  await page.keyboard.press("Enter");
  await page.locator("dialog[open].choice").waitFor({ state: "detached" });
  assert.equal((await calls(page)).filter((c) => c.cmd === "trash_entry").length, 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("關閉沒存的分頁：「不儲存」排在最右邊、不會預設聚焦（預設是「儲存」）", async () => {
  const { page, context, errors } = await open();
  await page.click(".cm-content");
  await page.keyboard.insertText("第一份");
  await page.click("#tab-bar .tab-new");
  await page.keyboard.insertText("還沒存的內容");
  await page.locator("#tab-bar .tab[aria-selected=true] .tab-close").click();
  await page.locator("dialog[open].choice").waitFor();
  assert.deepEqual(await buttons(page), [
    { label: "儲存", danger: false, primary: true, focused: true },
    { label: "取消", danger: false, primary: false, focused: false },
    { label: "不儲存", danger: true, primary: false, focused: false },
  ]);
  await page.keyboard.press("Escape");
  await page.locator("dialog[open].choice").waitFor({ state: "detached" });
  assert.equal(await page.locator("#tab-bar .tab").count(), 2, "按 Esc 取消，分頁還在");
  assert.deepEqual(errors, []);
  await context.close();
});
