/**
 * 檔案樹拖曳移動：把檔案或資料夾拖到另一個資料夾（或空白處＝專案最上層）就移過去，開著的分頁跟著換到新路徑；
 * 拖到它原本所在的資料夾、自己或自己底下不能放。用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ROOT = { kind: "folder", path: "/notes", name: "notes" };
const entry = (path, isDir = false) => ({ name: path.slice(path.lastIndexOf("/") + 1), path, isDir });
const file = (path, text) => ({ path, name: path.slice(path.lastIndexOf("/") + 1), text, encoding: "utf-8" });
const desktop = {
  startup_target: ROOT,
  list_dir: {
    $by: "path",
    values: {
      "/notes": [entry("/notes/旅行", true), entry("/notes/每日筆記", true), entry("/notes/筆記.md")],
      "/notes/旅行": [entry("/notes/旅行/日本.md")],
      "/notes/每日筆記": [],
    },
  },
  list_files: [[{ path: "/notes/筆記.md", rel: "筆記.md" }]],
  scan_docs: [[]],
  reopen_file: { $by: "path", values: { "/notes/筆記.md": file("/notes/筆記.md", "# 筆記\n") } },
  move_entry: "/notes/旅行/筆記.md",
};

const moves = async (page) => (await calls(page)).filter((c) => c.cmd === "move_entry").map((c) => c.args);
const row = (page, path) => page.locator(`#file-tree .tree-row[data-path="${path}"]`);

test("把檔案拖到資料夾：移過去，開著的分頁換到新路徑", async () => {
  const { page, context, errors } = await open({ desktop });
  await row(page, "/notes/筆記.md").waitFor();
  await row(page, "/notes/筆記.md").click();
  await page.waitForFunction(() => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent === "筆記.md");
  await row(page, "/notes/筆記.md").dragTo(row(page, "/notes/旅行"));
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "move_entry"));
  assert.deepEqual(await moves(page), [{ path: "/notes/筆記.md", dir: "/notes/旅行" }]);
  // 分頁的路徑換了（滑鼠提示是完整路徑）。
  await page.waitForFunction(() => /旅行/.test(document.querySelector("#tab-bar .tab[aria-selected=true]")?.getAttribute("title") ?? ""));
  assert.deepEqual(errors, []);
  await context.close();
});

test("資料夾拖到另一個資料夾；拖到原本所在的地方、自己身上不會移動", async () => {
  const { page, context, errors } = await open({ desktop: { ...desktop, move_entry: "/notes/每日筆記/旅行" } });
  await row(page, "/notes/旅行").waitFor();
  // 檔案拖到它原本所在的資料夾（放在同一層的檔案上）：不移動。
  await row(page, "/notes/筆記.md").dragTo(row(page, "/notes/筆記.md"));
  // 資料夾拖到自己身上：不移動。
  await row(page, "/notes/旅行").dragTo(row(page, "/notes/旅行"));
  await page.waitForTimeout(200);
  assert.deepEqual(await moves(page), []);
  await row(page, "/notes/旅行").dragTo(row(page, "/notes/每日筆記"));
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "move_entry"));
  assert.deepEqual(await moves(page), [{ path: "/notes/旅行", dir: "/notes/每日筆記" }]);
  assert.deepEqual(errors, []);
  await context.close();
});
