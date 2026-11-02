/**
 * Azure DevOps 工作項目的留言：自己的留言可以編輯、刪除（用假的原生端，見 helpers.mjs）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ITEM = {
  id: 42,
  title: "修正登入",
  state: "Active",
  kind: "Task",
  project: "產品",
  assignedTo: "王小明",
  changed: "2026-10-30T00:00:00Z",
  priority: 2,
  webUrl: "https://ado.test/c/產品/_workitems/edit/42",
};
const DETAIL = {
  ...ITEM,
  createdBy: "王小明",
  area: "產品",
  iteration: "產品",
  tags: [],
  description: "<p>說明</p>",
  details: null,
  rev: 3,
  relations: [],
  attachments: [],
  comments: [
    { id: 7, author: "王小明", created: "2026-10-28T01:00:00Z", text: "<p>我的留言</p>" },
    { id: 8, author: "李大同", created: "2026-10-29T01:00:00Z", text: "<p>別人的留言</p>" },
  ],
};

async function openItem(page) {
  // 桌面版沒有開著的文件時是歡迎畫面（沒有編輯器），直接按快速鍵。
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill("#42");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ado-comment[data-index]");
}

const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_work_item: DETAIL,
};

test("留言：只有自己的留言有編輯、刪除；改完用 Markdown 轉成 HTML 送出", async () => {
  const { page, context, errors } = await open({ desktop });
  await openItem(page);
  const mine = page.locator(".ado-comment[data-index='0']");
  const theirs = page.locator(".ado-comment[data-index='1']");
  assert.equal(await mine.locator(".ado-comment-tools button").count(), 2);
  assert.equal(await theirs.locator(".ado-comment-tools button").count(), 0);
  await mine.hover();
  await mine.locator("button[aria-label='編輯留言']").click();
  const box = mine.locator(".ado-comment-edit textarea");
  assert.equal(await box.inputValue(), "我的留言");
  await box.fill("改過的**留言**");
  await box.press("Control+Enter");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_comment_update"));
  const sent = (await calls(page)).find((c) => c.cmd === "ado_comment_update").args;
  assert.equal(sent.project, "產品");
  assert.equal(sent.id, 42);
  assert.equal(sent.commentId, 7);
  assert.match(sent.html, /<strong>留言<\/strong>/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("留言：刪除前先確認，取消就不刪", async () => {
  const { page, context, errors } = await open({ desktop });
  await openItem(page);
  const mine = page.locator(".ado-comment[data-index='0']");
  await mine.hover();
  await mine.locator("button[aria-label='刪除留言']").click();
  await page.locator("dialog[open] button", { hasText: "取消" }).click();
  assert.ok(!(await calls(page)).some((c) => c.cmd === "ado_comment_delete"));
  await mine.hover();
  await mine.locator("button[aria-label='刪除留言']").click();
  await page.locator("dialog[open] button", { hasText: "刪除" }).click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_comment_delete"));
  const sent = (await calls(page)).find((c) => c.cmd === "ado_comment_delete").args;
  assert.deepEqual(sent, { project: "產品", id: 42, commentId: 7 });
  assert.deepEqual(errors, []);
  await context.close();
});

test("留言：伺服器不支援編輯（TFS 2019，留言沒有編號）時不顯示按鈕", async () => {
  const old = { ...DETAIL, comments: DETAIL.comments.map((c) => ({ ...c, id: null })) };
  const { page, context, errors } = await open({ desktop: { ...desktop, ado_work_item: old } });
  await openItem(page);
  assert.equal(await page.locator(".ado-comment-tools").count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
