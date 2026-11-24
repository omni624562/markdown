/**
 * 版本紀錄與提交歷史的入口：檔案樹每一列的「⋯」（右鍵同一份選單）有「歷史」，打開那份檔案、右側欄切到「歷史」；
 * 「歷史」分頁把存檔的版本與 Git 提交排在一起（新的在上面），點一下就和現在的內容比較。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ROOT = { kind: "folder", path: "/notes", name: "notes" };
const entry = (path) => ({ name: path.slice(path.lastIndexOf("/") + 1), path, isDir: false });
const NOW = Date.now();
const STATUS = { available: true, repo: true, trusted: true, branch: { name: "main", upstream: null, ahead: 0, behind: 0 }, changes: [], remote: null, merging: false };
const desktop = {
  startup_target: ROOT,
  list_dir: { $by: "path", values: { "/notes": [entry("/notes/工作日誌.md"), entry("/notes/會議紀錄.md")] } },
  list_files: [[{ path: "/notes/會議紀錄.md", rel: "會議紀錄.md" }]],
  scan_docs: [[]],
  reopen_file: { $by: "path", values: { "/notes/會議紀錄.md": { path: "/notes/會議紀錄.md", name: "會議紀錄.md", text: "# 會議紀錄\n\n下週三交報告。\n", encoding: "utf-8" } } },
  git_status: STATUS,
  git_fetch: STATUS,
  // 存檔的版本：一小時前；提交：昨天。
  history_list: [[{ id: NOW - 3600_000, kind: "save", size: 30 }]],
  history_read: "# 會議紀錄\n\n下週二交報告。\n",
  git_file_history: [[{ id: "a1b2c3d4e5", short: "a1b2c3d", summary: "補上出席名單", author: "王小明", time: Math.floor((NOW - 86_400_000) / 1000) }]],
  git_file_at: "# 會議紀錄\n\n下週一交報告。\n",
  // 這裡看上下對照的紅色那一段（預設是左右並排）。
  load_settings: JSON.stringify({ gitCompareLayout: "stacked" }),
};
const row = (page, path) => page.locator(`#file-tree .tree-row[data-path="${path}"]`);

test("檔案樹的「⋯」：滑鼠移上去才出現，選單裡的「歷史」打開檔案、右側欄切到「歷史」，存檔版本和提交排在一起", async () => {
  const { page, context, errors } = await open({ desktop });
  const r = row(page, "/notes/會議紀錄.md");
  await r.waitFor();
  const more = r.locator(".tree-more");
  assert.equal(await more.isVisible(), false, "平常不顯示");
  await r.hover();
  assert.equal(await more.isVisible(), true, "滑鼠移上去出現");
  assert.equal(await more.getAttribute("aria-label"), "會議紀錄.md 的更多動作");
  await more.click();
  const item = page.getByRole("menuitem", { name: "歷史（存檔版本、提交）…" });
  await item.click();
  // 打開了那份檔案，右側欄是「歷史」。
  await page.waitForFunction(() => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent === "會議紀錄.md");
  const panel = page.locator("aside#outline-right .right-history");
  await panel.locator(".history-item").first().waitFor();
  assert.equal(await page.locator('aside#outline-right [role=tab][data-tab="history"]').getAttribute("aria-selected"), "true");
  const items = await panel.locator(".history-item").evaluateAll((els) => els.map((el) => [el.className.includes("history-save") ? "save" : "commit", el.querySelector("small").textContent]));
  assert.deepEqual(items, [
    ["save", "存檔"],
    ["commit", "提交：補上出席名單 · 王小明"],
  ]);
  // 點存檔的版本：和現在的內容比較（綠色是現在、紅色是那個版本）。
  await panel.locator(".history-save").click();
  await page.locator("#review-bar").getByText("改了哪些地方").waitFor();
  const deleted = await page.evaluate(() => [...document.querySelectorAll(".cm-deletedChunk")].map((el) => el.textContent).join(""));
  assert.match(deleted, /下週二/);
  // 點提交：拿那次提交的內容比較。
  await panel.locator(".history-commit").click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "git_file_at" && c.args.id === "a1b2c3d4e5"));
  await page.waitForFunction(() => [...document.querySelectorAll(".cm-deletedChunk")].some((el) => el.textContent.includes("下週一")));
  assert.deepEqual(errors, []);
  await context.close();
});

test("右鍵是同一份選單；換到別的檔案時「歷史」跟著換", async () => {
  const d = { ...desktop, reopen_file: { $by: "path", values: { ...desktop.reopen_file.values, "/notes/工作日誌.md": { path: "/notes/工作日誌.md", name: "工作日誌.md", text: "# 工作日誌\n", encoding: "utf-8" } } } };
  const { page, context, errors } = await open({ desktop: d });
  await row(page, "/notes/會議紀錄.md").waitFor();
  await row(page, "/notes/會議紀錄.md").click({ button: "right" });
  await page.getByRole("menuitem", { name: "歷史（存檔版本、提交）…" }).click();
  await page.locator("aside#outline-right .right-history .history-item").first().waitFor();
  const before = (await calls(page)).filter((c) => c.cmd === "history_list").length;
  // 點另一個檔案：歷史重新讀取那一份。
  await row(page, "/notes/工作日誌.md").click();
  await page.waitForFunction(
    (n) => window.__fake.calls.filter((c) => c.cmd === "history_list").length > n && window.__fake.calls.filter((c) => c.cmd === "history_list").at(-1).args.path === "/notes/工作日誌.md",
    before,
  );
  assert.deepEqual(errors, []);
  await context.close();
});

test("存檔後「歷史」馬上重新列出版本，存回原本的檔案不跳「已存檔」通知", async () => {
  const d = {
    ...desktop,
    save_file: { status: "saved", path: "/notes/會議紀錄.md", name: "會議紀錄.md" },
  };
  const { page, context, errors } = await open({ desktop: d });
  await row(page, "/notes/會議紀錄.md").waitFor();
  await row(page, "/notes/會議紀錄.md").click({ button: "right" });
  await page.getByRole("menuitem", { name: "歷史（存檔版本、提交）…" }).click();
  const panel = page.locator("aside#outline-right .right-history");
  await panel.locator(".history-save").first().waitFor();
  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.insertText("補充");
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "save_file"));
  // 原生端寫好版本後送出事件，清單馬上重新讀取。
  const before = (await calls(page)).filter((c) => c.cmd === "history_list").length;
  await page.evaluate(() => window.__fake.emit("history-changed", "/notes/會議紀錄.md"));
  await page.waitForFunction((n) => window.__fake.calls.filter((c) => c.cmd === "history_list").length > n, before);
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".toast", { hasText: "已存檔" }).count(), 0, "存回原檔不跳通知");
  assert.deepEqual(errors, []);
  await context.close();
});
