/**
 * 狀態列的編碼與換行（桌面版的本機檔案）：
 * - Big5 的舊檔顯示「Big5」「CRLF」，存檔時照原本的編碼寫回（不再提示會改存成 UTF-8）。
 * - 按編碼可以用其他編碼重新讀取（畫面上是亂碼時）。
 * - 存檔時 Big5 寫不進某些字：問要不要改存成 UTF-8，要的話換成 UTF-8 再存一次。
 * - 按換行可以換成 LF，馬上存一次。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ROOT = { kind: "folder", path: "C:\\Users\\me\\筆記", name: "筆記" };
const OLD = `${ROOT.path}\\舊公告.txt`;
const BIG5 = { encoding: "big5", crlf: true, bom: false };
const desktop = {
  startup_target: ROOT,
  list_dir: { $by: "path", values: { [ROOT.path]: [{ name: "舊公告.txt", path: OLD, isDir: false }] } },
  list_files: [[{ path: OLD, rel: "舊公告.txt" }]],
  scan_docs: [[]],
  reopen_file: { path: OLD, name: "舊公告.txt", text: "系統維護通知\n", encoding: "big5" },
  file_format: [BIG5, { encoding: "shift_jis", crlf: true, bom: false }],
  reopen_with_encoding: { path: OLD, name: "舊公告.txt", text: "日本語のお知らせ\n", encoding: "shift_jis" },
  set_file_format: [
    { encoding: "utf-8", crlf: true, bom: false },
    { encoding: "utf-8", crlf: false, bom: false },
  ],
  save_file: [
    { status: "unencodable", path: OLD, name: "舊公告.txt", encoding: "shift_jis", chars: "😀" },
    { status: "saved", path: OLD, name: "舊公告.txt" },
  ],
};

const label = (page, sel) => page.locator(`${sel} span`).first().textContent();

test("編碼與換行：Big5 的檔案照原本的編碼；可以用其他編碼重新讀取；存不了的字問要不要改存 UTF-8；換行可以換成 LF", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.locator("#file-tree .tree-row", { hasText: "舊公告.txt" }).click();
  await page.waitForFunction(() => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent === "舊公告.txt");
  // 狀態列：Big5、CRLF。本機檔案存檔時照原本的編碼，不再提示「會改存成 UTF-8」。
  await page.locator("#doc-encoding:not([hidden])").waitFor();
  assert.equal(await label(page, "#doc-encoding"), "Big5");
  assert.equal(await label(page, "#doc-eol"), "CRLF");
  assert.equal(await page.locator(".toast", { hasText: "UTF-8" }).count(), 0, "本機的 Big5 檔案不提示改存 UTF-8");

  // 用其他編碼重新讀取：選單上方是「用其他編碼重新讀取」，目前的編碼打勾。
  await page.click("#doc-encoding");
  const menu = page.locator("#doc-encoding-popover");
  await menu.locator(".menu-head", { hasText: "用其他編碼重新讀取" }).waitFor();
  assert.equal(await menu.locator('button[aria-checked="true"]').first().textContent(), "Big5（繁體中文）");
  await menu.locator("button", { hasText: "Shift_JIS（日文）" }).first().click();
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("日本語のお知らせ"));
  assert.deepEqual((await calls(page)).filter((c) => c.cmd === "reopen_with_encoding").map((c) => c.args), [{ path: OLD, encoding: "shift_jis" }]);
  assert.equal(await label(page, "#doc-encoding"), "Shift_JIS");

  // 打了 Shift_JIS 存不了的字：存檔時問要不要改存成 UTF-8。
  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.insertText("😀");
  await page.keyboard.press("Control+s");
  const dialog = page.locator("dialog[open].choice");
  await dialog.waitFor();
  assert.match(await dialog.textContent(), /Shift_JIS 編碼，存不了這幾個字：😀/);
  await dialog.locator("button", { hasText: "改存成 UTF-8" }).click();
  await page.locator(".toast", { hasText: "已存檔" }).waitFor();
  const log = await calls(page);
  assert.deepEqual(log.filter((c) => c.cmd === "set_file_format").map((c) => c.args), [{ path: OLD, encoding: "utf-8", bom: false }]);
  assert.equal(log.filter((c) => c.cmd === "save_file").length, 2, "改成 UTF-8 後再存一次");
  assert.equal(await label(page, "#doc-encoding"), "UTF-8");

  // 換行換成 LF：先確認新的格式寫得進目前的內容（帶 text），再存一次。
  await page.click("#doc-eol");
  await page.locator("#doc-eol-popover button", { hasText: "LF（macOS、Linux）" }).click();
  await page.waitForFunction(() => document.querySelector("#doc-eol span")?.textContent === "LF");
  const last = (await calls(page)).filter((c) => c.cmd === "set_file_format").at(-1).args;
  assert.equal(last.crlf, false);
  assert.match(last.text, /日本語のお知らせ\n?😀/);
  assert.equal((await calls(page)).filter((c) => c.cmd === "save_file").length, 3);
  assert.deepEqual(errors, []);
  await context.close();
});

test("網頁版沒有編碼與換行的按鈕", async () => {
  const { page, context, errors } = await open();
  await page.locator(".cm-content").waitFor();
  assert.equal(await page.locator("#doc-encoding").isVisible(), false);
  assert.equal(await page.locator("#doc-eol").isVisible(), false);
  assert.deepEqual(errors, []);
  await context.close();
});
