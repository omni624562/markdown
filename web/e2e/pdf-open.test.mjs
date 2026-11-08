/**
 * 檔案面板的 PDF：點一下交給系統預設的程式開啟（不當成文字檔讀）；右鍵「插入連結到目前的文件」插入相對路徑的連結。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\產品筆記";
const at = (name) => `${ROOT}\\${name}`;
const entry = (name) => ({ name, path: at(name), isDir: false });
const row = (page, name) => page.locator(`#file-tree .tree-row[data-path="${at(name).replace(/\\/g, "\\\\")}"]`);

test("點 PDF：用預設的程式開啟；右鍵可以插入連結", async () => {
  const { page, context, errors } = await open({
    desktop: {
      startup_target: { kind: "folder", path: ROOT, name: "產品筆記" },
      list_dir: { $by: "path", values: { [ROOT]: [entry("README.md"), entry("報告.pdf")] } },
      reopen_file: { $by: "path", values: { [at("README.md")]: { path: at("README.md"), name: "README.md", text: "# 產品筆記\n\n", encoding: "utf-8" } } },
    },
  });
  await row(page, "報告.pdf").click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "open_with_default"));
  const calls = await page.evaluate(() => window.__fake.calls.filter((c) => c.cmd === "open_with_default" || c.cmd === "reopen_file").map((c) => [c.cmd, c.args.path]));
  assert.deepEqual(calls, [["open_with_default", at("報告.pdf")]]);
  await page.locator(".toast", { hasText: "已用預設的程式開啟「報告.pdf」" }).waitFor();

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
