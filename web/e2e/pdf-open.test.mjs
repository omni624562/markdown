/**
 * 檔案面板的 PDF：點一下在分頁裡用內建的 PDF 檢視器顯示（不當成文字檔讀），上方有「用預設的程式開啟」；
 * 右鍵「插入連結到目前的文件」插入相對路徑的連結。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\產品筆記";
const at = (name) => `${ROOT}\\${name}`;
const entry = (name) => ({ name, path: at(name), isDir: false });
const row = (page, name) => page.locator(`#file-tree .tree-row[data-path="${at(name).replace(/\\/g, "\\\\")}"]`);

test("點 PDF：在分頁裡顯示（內建的 PDF 檢視器），可以改用預設的程式開啟；右鍵可以插入連結", async () => {
  const { page, context, errors } = await open({
    desktop: {
      startup_target: { kind: "folder", path: ROOT, name: "產品筆記" },
      list_dir: { $by: "path", values: { [ROOT]: [entry("README.md"), entry("報告.pdf")] } },
      reopen_file: { $by: "path", values: { [at("README.md")]: { path: at("README.md"), name: "README.md", text: "# 產品筆記\n\n", encoding: "utf-8" } } },
    },
  });
  await row(page, "報告.pdf").click();
  const frame = page.locator(".pdf-view iframe.pdf-view-frame");
  await frame.waitFor({ state: "attached" });
  assert.match(decodeURIComponent(await frame.getAttribute("src")), /報告\.pdf$/, "用 mdimg 協定載入這個 PDF");
  assert.equal(await page.locator("#tab-bar .tab[aria-selected=true] .tab-name").textContent(), "報告.pdf");
  assert.equal((await page.evaluate(() => window.__fake.calls.filter((c) => c.cmd === "open_with_default" || c.cmd === "reopen_file"))).length, 0, "不當成文字檔讀、也不交給外部程式");
  // 「用預設的程式開啟」：交給 Windows。
  await page.locator(".pdf-view-external").click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "open_with_default"));
  assert.deepEqual(await page.evaluate(() => window.__fake.calls.filter((c) => c.cmd === "open_with_default").map((c) => c.args.path)), [at("報告.pdf")]);

  // 先開 README，再從右鍵插入 PDF 的連結：路徑相對於 README。
  await row(page, "README.md").click();
  await page.waitForFunction(() => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent === "README.md");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await row(page, "報告.pdf").click({ button: "right" });
  await page.locator(".menu:popover-open button", { hasText: "插入連結到目前的文件" }).click();
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("[報告.pdf](報告.pdf)"));
  assert.deepEqual(errors, []);
  await context.close();
});

test("文件裡連到 PDF 的相對路徑連結：點了開成檢視分頁", async () => {
  const { page, context, errors } = await open({
    desktop: {
      startup_target: { kind: "folder", path: ROOT, name: "產品筆記" },
      list_dir: { $by: "path", values: { [ROOT]: [entry("README.md"), entry("報告.pdf")] } },
      reopen_file: { $by: "path", values: { [at("README.md")]: { path: at("README.md"), name: "README.md", text: "# 產品筆記\n\n[看報告](報告.pdf)\n", encoding: "utf-8" } } },
    },
  });
  await row(page, "README.md").click();
  await page.click('.statusbar [data-view="preview"]');
  await page.locator("#preview a", { hasText: "看報告" }).click();
  const frame = page.locator(".pdf-view iframe.pdf-view-frame");
  await frame.waitFor({ state: "attached" });
  assert.match(decodeURIComponent(await frame.getAttribute("src")), /報告\.pdf$/);
  assert.equal(await page.locator(".toast", { hasText: "只能在編輯器中開啟" }).count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("重新開啟程式：PDF 分頁還在，點了重新顯示", async () => {
  const { page, context, errors } = await open({
    desktop: {
      startup_target: { kind: "folder", path: ROOT, name: "產品筆記" },
      list_dir: { $by: "path", values: { [ROOT]: [entry("README.md"), entry("報告.pdf")] } },
    },
  });
  await row(page, "報告.pdf").click();
  await page.locator(".pdf-view iframe.pdf-view-frame").waitFor({ state: "attached" });
  await page.reload();
  const tab = page.locator("#tab-bar .tab", { hasText: "報告.pdf" });
  await tab.waitFor();
  await tab.click();
  const frame = page.locator(".pdf-view iframe.pdf-view-frame");
  await frame.waitFor({ state: "attached" });
  assert.match(decodeURIComponent(await frame.getAttribute("src")), /報告\.pdf$/);
  assert.deepEqual(errors, []);
  await context.close();
});
