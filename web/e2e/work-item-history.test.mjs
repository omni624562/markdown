/**
 * 工作項目的修改紀錄：標頭的「修改紀錄」開在同一個分頁，列出誰、什麼時候改了哪些欄位；按上一頁回到工作項目。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const base = { project: "產品", assignedTo: "王小明", changed: "2026-10-30T00:00:00Z", priority: 2 };
const DETAIL = {
  ...base,
  id: 42,
  title: "修正登入",
  state: "Active",
  kind: "Bug",
  webUrl: "https://ado.test/c/產品/_workitems/edit/42",
  createdBy: "王小明",
  area: "產品",
  iteration: "產品",
  tags: [],
  description: "<p>說明</p>",
  details: null,
  rev: 3,
  relations: [],
  attachments: [],
  comments: [],
};
const HISTORY = [
  {
    rev: 3,
    author: "李大同",
    date: "2026-10-30T02:00:00Z",
    fields: [{ field: "System.State", old: "New", new: "Active", long: false }],
    comment: "<p>開始處理</p>",
    added: [{ kind: "parent", id: 7, name: "Parent" }],
    removed: [],
  },
  { rev: 1, author: "王小明", date: "2026-10-01T02:00:00Z", fields: [{ field: "System.Title", old: null, new: "修正登入", long: false }], comment: null, added: [], removed: [] },
];

test("工作項目的修改紀錄：同一個分頁開啟，按上一頁回到工作項目", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_work_item: DETAIL,
      ado_work_item_history: [HISTORY],
    },
  });
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill("#42");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
  await page.locator(".issue-pane .issue-body", { hasText: "說明" }).waitFor();
  const tabs = await page.locator(".tab").count();
  await page.locator(".issue-pane button[aria-label^='修改紀錄']").click();
  const body = page.locator(".issue-pane .issue-body");
  await body.locator("h3", { hasText: "李大同" }).waitFor();
  assert.equal((await calls(page)).find((c) => c.cmd === "ado_work_item_history").args.id, 42);
  const text = await body.textContent();
  assert.match(text, /狀態：New → Active/);
  assert.match(text, /加入上層 #7/);
  assert.match(text, /開始處理/);
  assert.match(text, /標題：修正登入/);
  // 最新的在前面。
  const heads = await body.locator("h3").allTextContents();
  assert.match(heads[0], /李大同/);
  assert.match(heads[1], /王小明/);
  assert.equal(await page.locator(".tab").count(), tabs, "開在同一個分頁");
  // 上一頁：回到工作項目。
  await page.keyboard.press("Alt+ArrowLeft");
  await page.locator(".issue-pane .issue-body", { hasText: "說明" }).waitFor();
  assert.doesNotMatch(await body.textContent(), /狀態：New → Active/);
  assert.deepEqual(errors, []);
  await context.close();
});
