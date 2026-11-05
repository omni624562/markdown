/**
 * 編輯中的 Wiki 頁面（空白的也一樣）不會被開啟的本機檔案沿用：本機檔案開在新分頁，
 * Ctrl+S 存到本機檔案，不會存回 Wiki。用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const WIKI = {
  id: "w1",
  name: "Contoso.wiki",
  project: "Contoso",
  projectId: "p1",
  code: false,
  repositoryId: "r1",
  mappedPath: "/",
  version: "wikiMaster",
  webUrl: "https://ado.test/c/Contoso/_wiki/wikis/Contoso.wiki",
};
const LOCAL = "C:\\Users\\me\\Documents\\筆記.md";
const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_wikis: [[WIKI]],
  ado_wiki_pages: [[{ path: "/產品", id: 2, children: [] }]],
  // 上層頁面常常是空白的（Azure DevOps 自動建立）。
  ado_wiki_page: { content: "", webUrl: null, etag: '"1"' },
  ado_wiki_page_info: null,
  ado_wiki_save: { status: "saved", etag: '"2"' },
  open_file: { path: LOCAL, name: "筆記.md", text: "# 本機筆記\n", encoding: "utf-8" },
  save_file: { status: "saved", path: LOCAL, name: "筆記.md" },
};

test("編輯空白的 Wiki 頁面時開啟本機檔案：開在新分頁，Ctrl+S 存到本機檔案、不存回 Wiki", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.click("#side-tab-wiki");
  await page.locator('#wiki-host .wiki-page[data-path="/產品"]').click();
  await page.locator(".issue-actions .btn-primary", { hasText: "編輯" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("#tab-bar .tab-name")].some((n) => n.textContent === "產品.md"));
  // 開啟本機檔案（Ctrl+O）。
  await page.keyboard.press("Control+O");
  await page.waitForFunction(() => [...document.querySelectorAll("#tab-bar .tab-name")].some((n) => n.textContent === "筆記.md"));
  const names = await page.$$eval("#tab-bar .tab-name", (list) => list.map((n) => n.textContent));
  assert.ok(names.includes("產品.md") && names.includes("筆記.md"), names.join("、"));
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("補充");
  await page.keyboard.press("Control+S");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "save_file" || c.cmd === "ado_wiki_save"));
  const cmds = (await calls(page)).map((c) => c.cmd);
  assert.equal(cmds.includes("ado_wiki_save"), false, "沒有存回 Wiki");
  assert.ok(cmds.includes("save_file"), cmds.join(" "));
  assert.deepEqual(errors, []);
  await context.close();
});
