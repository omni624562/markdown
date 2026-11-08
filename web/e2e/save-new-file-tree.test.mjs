/**
 * 專案裡新增文件、第一次存檔後，檔案面板立刻顯示新檔案（原生端的監看把自己存的檔案當成沒變，前端要自己更新）；
 * 檔案面板的「新增檔案」預設不填「未命名.md」，空白按 Enter 就取消。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\產品筆記";
const at = (name) => `${ROOT}\\${name}`;
const entry = (name) => ({ name, path: at(name), isDir: false });
const row = (page, name) => page.locator(`#file-tree .tree-row[data-path="${at(name).replace(/\\/g, "\\\\")}"]`);

test("新文件存進專案資料夾後，檔案面板立刻出現", async () => {
  const { page, context, errors } = await open({
    desktop: {
      startup_target: { kind: "folder", path: ROOT, name: "產品筆記" },
      // 存檔前的清單、存檔後的清單（之後都回傳存檔後的）。
      list_dir: [[entry("README.md")], [entry("README.md"), entry("韓國釜山.md")]],
      save_file: { status: "saved", path: at("韓國釜山.md"), name: "韓國釜山.md" },
    },
  });
  await row(page, "README.md").waitFor();
  assert.equal(await row(page, "韓國釜山.md").count(), 0, "存檔前還沒有這個檔案");
  await page.keyboard.press("Control+N");
  await page.keyboard.insertText("# 韓國釜山\n\n行程");
  await page.keyboard.press("Control+S");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "save_file"));
  await row(page, "韓國釜山.md").waitFor({ timeout: 3000 });
  assert.deepEqual(errors, []);
  await context.close();
});

test("「新增檔案」預設不填名稱，空白按 Enter 就取消", async () => {
  const { page, context, errors } = await open({
    desktop: {
      startup_target: { kind: "folder", path: ROOT, name: "產品筆記" },
      list_dir: [[entry("README.md")]],
    },
  });
  await row(page, "README.md").waitFor();
  await page.click("#tree-new-file");
  const input = page.locator("#file-tree input.tree-input");
  await input.waitFor();
  assert.equal(await input.inputValue(), "");
  assert.notEqual(await input.getAttribute("placeholder"), "");
  await input.press("Enter");
  await page.waitForTimeout(100);
  assert.equal(await input.count(), 0, "輸入列收起來");
  const calls = await page.evaluate(() => window.__fake.calls.map((c) => c.cmd));
  assert.ok(!calls.includes("create_entry"), "沒有建立檔案");
  assert.deepEqual(errors, []);
  await context.close();
});
