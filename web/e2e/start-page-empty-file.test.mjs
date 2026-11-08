/**
 * 起始頁只給還沒存檔的空白文件：從檔案面板打開磁碟上的空白檔案（例如剛新增的「未命名.md」）時，
 * 照常顯示編輯區，不顯示起始頁。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\產品筆記";
const at = (name) => `${ROOT}\\${name}`;
const entry = (name) => ({ name, path: at(name), isDir: false });
const file = (name, text) => ({ path: at(name), name, text, encoding: "utf-8" });

test("打開磁碟上的空白檔案：不顯示起始頁", async () => {
  const { page, context, errors } = await open({
    desktop: {
      startup_target: { kind: "folder", path: ROOT, name: "產品筆記" },
      list_dir: { $by: "path", values: { [ROOT]: [entry("README.md"), entry("未命名.md")] } },
      reopen_file: { $by: "path", values: { [at("README.md")]: file("README.md", "# 產品筆記\n"), [at("未命名.md")]: file("未命名.md", "") } },
    },
  });
  const row = (name) => page.locator(`#file-tree .tree-row[data-path="${at(name).replace(/\\/g, "\\\\")}"]`);
  await row("未命名.md").click();
  await page.waitForFunction(() => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent === "未命名.md");
  await page.waitForTimeout(150);
  assert.equal(await page.locator(".empty-state").isVisible(), false);
  assert.equal(await page.evaluate(() => document.querySelector(".workspace").classList.contains("start-open")), false);
  // 可以直接打字。
  await page.locator(".cm-content").click();
  await page.keyboard.type("第一行");
  assert.match(await page.locator(".cm-content").textContent(), /第一行/);

  // 清空已經有內容的檔案：也不會跳出起始頁。
  await row("README.md").click();
  await page.waitForFunction(() => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent === "README.md");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(150);
  assert.equal(await page.locator(".empty-state").isVisible(), false);
  assert.deepEqual(errors, []);
  await context.close();
});
