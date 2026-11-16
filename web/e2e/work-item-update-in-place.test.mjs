/**
 * 工作項目的欄位直接改（狀態等）之後：在背景重新讀取，畫面不先清掉變成「讀取中…」、捲動位置不變，
 * 讀到之後狀態換成新的（用假的原生端，見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const base = { project: "產品", assignedTo: "王小明", changed: "2026-10-30T00:00:00Z", priority: 2, kind: "Task" };
const DETAIL = {
  ...base,
  id: 42,
  title: "修正登入",
  state: "Active",
  webUrl: "https://ado.test/c/產品/_workitems/edit/42",
  createdBy: "王小明",
  area: "產品",
  iteration: "產品",
  tags: [],
  // 說明很長：捲到下面再改狀態。
  description: Array.from({ length: 80 }, (_, i) => `<p>第 ${i + 1} 段說明</p>`).join(""),
  details: null,
  rev: 3,
  relations: [],
  attachments: [],
  comments: [],
};

test("改狀態：不清掉畫面、不跳回最上面，讀到之後狀態換成新的", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_work_items: [[DETAIL]],
      ado_work_item_states: [["New", "Active", "Resolved", "Closed"]],
      // 開啟時讀兩次（清單預先讀取、開啟）；改完之後的那一次慢一點：看得出這段時間畫面有沒有被清掉。
      ado_work_item: [DETAIL, DETAIL, { $delay: 600, value: { ...DETAIL, state: "Resolved", rev: 4 } }],
    },
  });
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill("#42");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ado-hero");
  const scroll = page.locator(".issue-scroll");
  await page.locator("button#wi-edit-state").click();
  await page.locator("#wi-edit-state-popover button", { hasText: "Resolved" }).waitFor();
  // 選單開著時往下捲（例如邊看說明邊改）。
  await scroll.evaluate((el) => (el.scrollTop = 400));
  await page.locator("#wi-edit-state-popover button", { hasText: "Resolved" }).click();
  await page.locator(".toast", { hasText: "已把狀態改成「Resolved」" }).waitFor();
  // 背景讀取中：畫面還在、沒有「讀取中…」、捲動位置不變。
  assert.equal(await page.locator(".issue-status", { hasText: "讀取中" }).count(), 0);
  assert.equal(await page.locator(".issue-body", { hasText: "第 80 段說明" }).count(), 1, "內容還在");
  assert.ok((await scroll.evaluate((el) => el.scrollTop)) >= 390);
  await page.waitForFunction(() => /Resolved/.test(document.querySelector('.ado-fact[data-field="state"]')?.textContent ?? ""));
  assert.ok((await scroll.evaluate((el) => el.scrollTop)) >= 390, "讀到新內容之後也留在原本的位置");
  assert.deepEqual(errors, []);
  await context.close();
});
