/**
 * 檔案面板點圖片：在唯讀的分頁裡顯示圖片，標題是檔名，工具列沒有「在瀏覽器開啟」。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\產品筆記";
const at = (name) => `${ROOT}\\${name}`;
const entry = (name, isDir = false) => ({ name, path: at(name), isDir });
const row = (page, name) => page.locator(`#file-tree .tree-row[data-path="${at(name).replace(/\\/g, "\\\\")}"]`);

test("點圖片：在分頁裡顯示，不會當成文字檔打開", async () => {
  const { page, context, errors } = await open({
    desktop: {
      startup_target: { kind: "folder", path: ROOT, name: "產品筆記" },
      list_dir: { $by: "path", values: { [ROOT]: [entry("README.md"), entry("王小明.png")] } },
      reopen_file: { $by: "path", values: { [at("README.md")]: { path: at("README.md"), name: "README.md", text: "# 產品筆記\n", encoding: "utf-8" } } },
    },
  });
  await row(page, "王小明.png").click();
  await page.locator(".issue-pane .issue-body.image-view img").waitFor();
  const tab = page.locator("#tab-bar .tab[aria-selected=true] .tab-name");
  assert.equal(await tab.textContent(), "王小明.png");
  assert.equal(await page.getAttribute(".issue-pane", "data-source"), "image");
  const img = page.locator(".issue-pane .issue-body.image-view img");
  assert.equal(await img.getAttribute("alt"), "王小明");
  assert.match(await img.getAttribute("src"), /^http:\/\/mdimg\.localhost\//, "用 mdimg 協定讀圖");
  // 本機圖片沒有網址：「在瀏覽器開啟」藏起來。
  assert.equal(await page.locator(".issue-pane button[title='在瀏覽器開啟']").isVisible(), false);
  // 沒有呼叫讀文字檔的指令。
  const calls = await page.evaluate(() => window.__fake.calls.filter((c) => c.cmd === "reopen_file").map((c) => c.args.path));
  assert.ok(!calls.includes(at("王小明.png")), "沒有把圖片當文字檔讀");
  assert.deepEqual(errors, []);
  await context.close();
});
