/**
 * 工作項目的相關工作項目：狀態只顯示一次（標籤），不會「Closed・Closed」（用假的原生端，見 helpers.mjs）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const base = { project: "產品", assignedTo: "王小明", changed: "2026-10-30T00:00:00Z", priority: 2 };
const child = { ...base, id: 7, title: "子工作", state: "Closed", kind: "Task", webUrl: "https://ado.test/c/產品/_workitems/edit/7" };
const DETAIL = {
  ...base,
  id: 42,
  title: "修正登入",
  state: "Active",
  kind: "User Story",
  webUrl: "https://ado.test/c/產品/_workitems/edit/42",
  createdBy: "王小明",
  area: "產品",
  iteration: "產品",
  tags: [],
  description: "<p>說明</p>",
  details: null,
  rev: 3,
  relations: [{ ...child, link: "child", linkName: "Child" }],
  attachments: [],
  comments: [],
};

test("相關工作項目：狀態只顯示一次", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_work_item: DETAIL,
      // 讀到的是最新的狀態：標籤換成這個。
      ado_work_items_by_ids: [[{ ...child, state: "Active" }]],
    },
  });
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill("#42");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
  const row = page.locator(".issue-pane li", { hasText: "子工作" });
  await row.waitFor();
  await page.waitForFunction(() => document.querySelector(".issue-pane li .wi-chip")?.textContent === "Active");
  const text = (await row.textContent()).trim();
  assert.doesNotMatch(text, /・/, "沒有另外寫一次狀態");
  assert.equal((text.match(/Active|Closed/g) ?? []).length, 1);
  assert.deepEqual(errors, []);
  await context.close();
});
