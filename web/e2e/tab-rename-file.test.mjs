/**
 * 已經存成檔案的文件直接從分頁改名：雙擊分頁、分頁右鍵選單「重新命名…」、指令「重新命名文件…」
 * 都和檔案面板的重新命名一樣（改磁碟上的檔名、分頁跟著換、問要不要更新連到它的連結）。
 * 還沒存檔的文件照舊只改分頁名稱；不在開啟的資料夾裡的檔案說明無法改名。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ROOT = { kind: "folder", path: "/notes", name: "notes" };
const entry = (name) => ({ name, path: `/notes/${name}`, isDir: false });
const file = (path, text) => ({ path, name: path.slice(path.lastIndexOf("/") + 1), text, encoding: "utf-8" });
const desktop = {
  startup_target: ROOT,
  list_dir: { $by: "path", values: { "/notes": [entry("a.md"), entry("c.md")] } },
  // 陣列是依序用掉的回應（見 helpers.mjs），回傳陣列時要再包一層。
  list_files: [
    [
      { path: "/notes/a.md", rel: "a.md" },
      { path: "/notes/c.md", rel: "c.md" },
    ],
  ],
  scan_docs: [[]],
  recent: { files: ["/elsewhere/x.md"], folders: [] },
  reopen_file: {
    $by: "path",
    values: {
      "/notes/a.md": file("/notes/a.md", "# A\n"),
      "/notes/c.md": file("/notes/c.md", "見 [A](a.md)\n"),
      "/elsewhere/x.md": file("/elsewhere/x.md", "# X\n"),
    },
  },
  rename_entry: "/notes/b.md",
};

const activeName = (page) => page.textContent("#tab-bar .tab[aria-selected=true] .tab-name");

/** 用 Ctrl+P 開啟檔案。 */
async function openFile(page, name) {
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill(name);
  await page.locator("dialog[open] [role=option]", { hasText: name }).first().waitFor();
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent === n, name);
}

const renames = async (page) => (await calls(page)).filter((c) => c.cmd === "rename_entry").map((c) => c.args);

test("雙擊分頁改檔名：和檔案面板一樣改磁碟上的檔名、分頁跟著換、問要不要更新連結", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.waitForSelector("#file-tree .tree-row");
  await openFile(page, "c.md");
  await openFile(page, "a.md");
  await page.locator("#tab-bar .tab", { hasText: "a.md" }).dblclick();
  const input = page.locator("#tab-bar input.tab-rename");
  assert.equal(await input.inputValue(), "a.md");
  // 先選取主檔名（不含副檔名）：直接打字就換掉主檔名。
  await page.keyboard.type("b");
  await page.keyboard.press("Enter");
  await page.locator("dialog[open]", { hasText: "更新連結？" }).waitFor();
  assert.deepEqual(await renames(page), [{ path: "/notes/a.md", newName: "b.md" }]);
  assert.equal(await activeName(page), "b.md");
  assert.match(await page.textContent("dialog[open]"), /有 1 份文件連到「a\.md」/);
  await page.click("dialog[open] button:has-text('更新連結')");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "update_doc"));
  const update = (await calls(page)).find((c) => c.cmd === "update_doc").args;
  assert.deepEqual([update.path, update.text], ["/notes/c.md", "見 [A](b.md)\n"]);
  assert.equal(await page.locator(".toast", { hasText: "請在「檔案」面板" }).count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("分頁右鍵選單「重新命名…」與指令「重新命名文件…」：改按右鍵的那個檔案", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.waitForSelector("#file-tree .tree-row");
  await openFile(page, "a.md");
  await openFile(page, "c.md");
  // 指令面板：目前的分頁出現輸入框；按 Esc 取消，不改名。
  await page.keyboard.press("Control+Shift+P");
  await page.locator("dialog[open] input").first().fill("重新命名文件");
  await page.keyboard.press("Enter");
  const input = page.locator("#tab-bar input.tab-rename");
  await input.waitFor();
  assert.equal(await input.inputValue(), "c.md");
  await page.keyboard.press("Escape");
  await input.waitFor({ state: "detached" });

  // 在背景的 a.md 分頁上按右鍵 →「重新命名…」。
  await page.locator("#tab-bar .tab", { hasText: "a.md" }).click({ button: "right" });
  await page.locator(".menu:popover-open [role=menuitem]", { hasText: "重新命名…" }).click();
  await input.waitFor();
  assert.equal(await input.inputValue(), "a.md");
  await input.fill("b.md");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll("#tab-bar .tab-name")].some((n) => n.textContent === "b.md"));
  assert.deepEqual(await renames(page), [{ path: "/notes/a.md", newName: "b.md" }]);
  assert.equal(await activeName(page), "c.md");
  assert.deepEqual(errors, []);
  await context.close();
});

test("還沒存檔的文件照舊只改分頁名稱；不在開啟的資料夾裡的檔案說明無法改名", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.waitForSelector("#file-tree .tree-row");
  await page.keyboard.press("Control+N");
  await page.keyboard.insertText("草稿內容");
  await page.locator("#tab-bar .tab[aria-selected=true]").dblclick();
  await page.locator("#tab-bar input.tab-rename").fill("草稿.md");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent === "草稿.md");

  await openFile(page, "x.md");
  await page.locator("#tab-bar .tab", { hasText: "x.md" }).dblclick();
  await page.locator(".toast", { hasText: "「x.md」不在目前開啟的資料夾裡" }).waitFor();
  assert.equal(await page.locator("#tab-bar input.tab-rename").count(), 0);
  assert.deepEqual(await renames(page), []);
  assert.deepEqual(errors, []);
  await context.close();
});

test("檔案面板的重新命名（F2）照舊：改磁碟上的檔名，開著的分頁跟著換", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.waitForSelector("#file-tree .tree-row");
  await openFile(page, "a.md");
  await page.locator('#file-tree .tree-row[data-path="/notes/a.md"]').focus();
  await page.keyboard.press("F2");
  await page.locator("#file-tree input.tree-input").fill("b.md");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent === "b.md");
  assert.deepEqual(await renames(page), [{ path: "/notes/a.md", newName: "b.md" }]);
  assert.deepEqual(errors, []);
  await context.close();
});
