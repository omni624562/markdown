/**
 * 匯出的預設位置與檔名：已存檔的文件匯出到它所在的資料夾、用它的檔名；還沒存檔的文件匯出到專案資料夾、
 * 用第一個標題當檔名（不是「未命名」）。用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open, runCommand, setText } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\產品筆記";
const at = (rel) => `${ROOT}\\${rel.replace(/\//g, "\\")}`;
const entry = (rel, isDir = false) => ({ name: rel.slice(rel.lastIndexOf("/") + 1), path: at(rel), isDir });

test("匯出 HTML：沒存檔的文件預設在專案資料夾、用標題當檔名；已存檔的在原檔的資料夾、用原檔名", async () => {
  const { page, context, errors } = await open({
    desktop: {
      startup_target: { kind: "folder", path: ROOT, name: "產品筆記" },
      list_dir: { $by: "path", values: { [ROOT]: [entry("docs", true)], [at("docs")]: [entry("docs/週報.md")] } },
      reopen_file: { $by: "path", values: { [at("docs/週報.md")]: { path: at("docs/週報.md"), name: "週報.md", text: "# 本週\n", encoding: "utf-8" } } },
      save_file: { status: "cancelled" },
    },
  });
  const exports = async () => (await calls(page)).filter((c) => c.cmd === "save_file").map((c) => c.args);

  await page.locator("#file-tree .tree-row").first().waitFor();
  await page.keyboard.press("Control+N");
  await page.locator(".cm-content").waitFor({ state: "visible" });
  await setText(page, "# 註冊與登入流程圖\n\n內容");
  await runCommand(page, "匯出成 HTML");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "save_file"));
  const [first] = await exports();
  assert.equal(first.suggestedName, "註冊與登入流程圖.html");
  assert.equal(first.directory, ROOT);

  await page.locator(`#file-tree .tree-row[data-path="${at("docs").replace(/\\/g, "\\\\")}"]`).click();
  await page.locator(`#file-tree .tree-row[data-path="${at("docs/週報.md").replace(/\\/g, "\\\\")}"]`).click();
  await page.waitForFunction(() => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent === "週報.md");
  await runCommand(page, "匯出成 HTML");
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "save_file").length === 2);
  const second = (await exports())[1];
  assert.equal(second.suggestedName, "週報.html");
  assert.equal(second.directory, at("docs"));
  assert.deepEqual(errors, []);
  await context.close();
});
