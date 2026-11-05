/**
 * 工作項目說明裡有自己的標題（<h2>）：內容都留在「工作項目說明」卡片裡，不會被拆到附件後面、卡片也不會寫「還沒有內容」。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

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
  createdBy: "王小明",
  area: "產品",
  iteration: "產品",
  tags: [],
  description: "<h2>背景</h2><p>登入頁會逾時。</p><h2>做法</h2><p>改用新的驗證方式。</p>",
  details: null,
  rev: 3,
  relations: [],
  attachments: [],
  comments: [],
};

test("說明裡有 <h2>：內容留在「工作項目說明」卡片裡", async () => {
  const { page, context, errors } = await open({ desktop: { ado_account: { url: "https://ado.test/c", name: "王小明" }, ado_work_item: ITEM } });
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill("#42");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ado-hero h1");
  const desc = page.locator('.ado-sec[data-kind="desc"] .ado-sec-body');
  await desc.waitFor();
  const text = await desc.textContent();
  assert.match(text, /背景/);
  assert.match(text, /改用新的驗證方式/);
  assert.doesNotMatch(text, /還沒有內容/);
  // 「背景」「做法」不是另外的卡片。
  const heads = await page.locator(".ado-sec > .ado-sec-head h2").allTextContents();
  assert.ok(!heads.some((h) => /背景|做法/.test(h)), heads.join("、"));
  assert.deepEqual(errors, []);
  await context.close();
});
