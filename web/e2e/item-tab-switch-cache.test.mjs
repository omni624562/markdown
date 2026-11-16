/**
 * 工作項目分頁來回切換：剛剛讀過的直接顯示，不再向伺服器重讀（工作項目一次要讀好幾個請求，分頁多時伺服器慢就會卡）；
 * 按「重新整理」照樣重讀（用假的原生端，見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const base = { project: "產品", assignedTo: "王小明", changed: "2026-10-30T00:00:00Z", priority: 2, kind: "Task", state: "Active" };
const detail = (id, title) => ({
  ...base,
  id,
  title,
  webUrl: `https://ado.test/c/產品/_workitems/edit/${id}`,
  createdBy: "王小明",
  area: "產品",
  iteration: "產品",
  tags: [],
  description: `<p>${title}的說明</p>`,
  details: null,
  rev: 3,
  relations: [],
  attachments: [],
  comments: [],
});
const A = detail(41, "修正登入");
const B = detail(42, "匯出 PDF");

async function openById(page, id, text) {
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill(`#${id}`);
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
  await page.locator(".issue-body", { hasText: text }).waitFor();
}

test("工作項目分頁來回切換：剛讀過的不再重讀；按「重新整理」才重讀", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_work_items: [[A, B]],
      ado_work_item: { $by: "id", values: { 41: A, 42: B } },
    },
  });
  await openById(page, 41, "修正登入的說明");
  await openById(page, 42, "匯出 PDF的說明");
  const reads = async () => (await calls(page)).filter((c) => c.cmd === "ado_work_item").length;
  const before = await reads();
  for (let i = 0; i < 3; i++) {
    await page.locator('#tab-bar [data-id]', { hasText: "修正登入" }).click();
    await page.locator(".issue-body", { hasText: "修正登入的說明" }).waitFor();
    await page.locator('#tab-bar [data-id]', { hasText: "匯出 PDF" }).click();
    await page.locator(".issue-body", { hasText: "匯出 PDF的說明" }).waitFor();
  }
  await page.waitForTimeout(300);
  assert.equal(await reads(), before, "切換分頁沒有再向伺服器讀");
  await page.locator(".issue-pane").getByRole("button", { name: "重新整理" }).click();
  await page.waitForFunction((n) => window.__fake.calls.filter((c) => c.cmd === "ado_work_item").length > n, before);
  assert.deepEqual(errors, []);
  await context.close();
});
