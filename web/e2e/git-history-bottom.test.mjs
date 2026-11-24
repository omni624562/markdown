/**
 * Git 歷史放在編輯區下方：文件照常顯示，上下對照；上緣沒有來源顏色的線；標題列一行；
 * 上緣的把手可以拖曳調整高度（記住），切換文件分頁時 Git 歷史照常開著。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const ROOT = { kind: "folder", path: "/notes", name: "notes" };
const STATUS = { available: true, repo: true, trusted: true, branch: { name: "main", upstream: null, ahead: 0, behind: 0 }, changes: [], remote: null, merging: false };
const NOW = Math.floor(Date.now() / 1000);
const commit = (id, summary, author, ago, parents = []) => ({ id, parents, summary, author, email: "", time: NOW - ago, refs: [], unpushed: false, unpulled: false });
const desktop = {
  startup_target: ROOT,
  list_dir: { $by: "path", values: { "/notes": [{ name: "會議紀錄.md", path: "/notes/會議紀錄.md", isDir: false }] } },
  list_files: [[]],
  scan_docs: [[]],
  reopen_file: { path: "/notes/會議紀錄.md", name: "會議紀錄.md", text: "# 會議紀錄\n\n出席：王小明、李大同\n", encoding: "utf-8" },
  git_status: STATUS,
  git_fetch: STATUS,
  git_log: { commits: [{ ...commit("b2", "補上出席名單", "王小明", 7200, ["a1"]), refs: [{ name: "main", kind: "head" }] }, commit("a1", "建立會議紀錄", "李大同", 86400)], more: false, head: "b2" },
};

test("Git 歷史在編輯區下方：文件照常顯示、沒有紅線、標題列一行；拖曳把手調整高度；切換分頁照常開著", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.locator('#file-tree .tree-row[data-path="/notes/會議紀錄.md"]').click();
  await page.locator("#side-tab-git").click();
  await page.locator('#panel-git button[aria-label="Git 歷史（線圖）"]').click();
  const pane = page.locator(".history-pane");
  await pane.locator(".gh-list").waitFor();
  await pane.getByText("補上出席名單").waitFor();
  // 文件照常顯示，在 Git 歷史上面。
  const editor = await page.locator(".editor-pane").boundingBox();
  const box = await pane.boundingBox();
  assert.ok(editor && editor.height > 100, "編輯區照常顯示");
  assert.ok(box.y >= editor.y + editor.height - 1, `Git 歷史在編輯區下方：${JSON.stringify({ editor, box })}`);
  // 上緣沒有來源顏色的粗線。
  const top = await pane.evaluate((el) => getComputedStyle(el).borderTopWidth);
  assert.equal(top, "1px");
  // 標題列一行：標題、分支、按鈕在同一列。
  const head = await pane.locator(".gh-head").boundingBox();
  assert.ok(head.height < 44, `標題列一行：${head.height}`);
  assert.equal((await pane.locator(".gh-branch").textContent()).trim(), "main");
  // 拖曳上緣的把手：往上拖變高，記住。
  const handle = pane.locator(".gh-split");
  const h0 = box.height;
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 - 80, { steps: 4 });
  await page.mouse.up();
  const h1 = (await pane.boundingBox()).height;
  assert.ok(h1 > h0 + 60, `拖曳後變高：${h0} → ${h1}`);
  assert.ok(Number(await page.evaluate(() => localStorage.getItem("md-editor:git-history-height"))) > 0, "高度記住");
  // 點文件分頁：Git 歷史照常開著。
  await page.locator("#tab-bar .tab", { hasText: "會議紀錄.md" }).first().click();
  assert.equal(await pane.isVisible(), true, "切換分頁照常開著");
  // 關閉：編輯區回到原本的高度。
  await pane.getByRole("button", { name: "關閉" }).click();
  await pane.waitFor({ state: "hidden" });
  assert.ok((await page.locator(".editor-pane").boundingBox()).height > editor.height + 100);
  assert.deepEqual(errors, []);
  await context.close();
});

test("起始頁（沒有分頁列）時打開 Git 歷史：一樣在起始頁下方、和編輯區同寬，不會跑到右下角", async () => {
  const { page, context, errors } = await open({ desktop: { ...desktop, reopen_file: null } });
  await page.locator("#side-tab-git").click();
  await page.locator('#panel-git button[aria-label="Git 歷史（線圖）"]').click();
  const pane = page.locator(".history-pane");
  await pane.getByText("補上出席名單").waitFor();
  const editor = await page.locator(".editor-pane").boundingBox();
  const box = await pane.boundingBox();
  assert.ok(Math.abs(box.x - editor.x) < 2 && Math.abs(box.width - editor.width) < 2, `和編輯區同寬：${JSON.stringify({ editor, box })}`);
  assert.ok(box.y >= editor.y + editor.height - 1, "在下方");
  assert.deepEqual(errors, []);
  await context.close();
});
