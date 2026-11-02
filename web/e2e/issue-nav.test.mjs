/**
 * 工作項目、Wiki 的檢視裡，點連結到別的項目之後，用鍵盤的 < > 回上一頁、下一頁。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const item = (id, title, description, relations = []) => ({
  id,
  title,
  state: "Active",
  kind: "Task",
  project: "產品",
  assignedTo: null,
  changed: "2026-10-30T00:00:00Z",
  priority: null,
  webUrl: `https://ado.test/c/產品/_workitems/edit/${id}`,
  createdBy: null,
  area: null,
  iteration: null,
  tags: [],
  description,
  details: null,
  rev: 1,
  relations,
  attachments: [],
  comments: [],
});

const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_work_item: {
    $by: "id",
    values: {
      // 內容裡連到相關項目的連結，點了在同一個檢視切換過去。
      42: item(42, "第一個項目", '<p>請看 <a href="https://ado.test/c/產品/_workitems/edit/43">另一個項目</a></p>', [
        { ...item(43, "第二個項目", null), link: "related", linkName: "Related" },
      ]),
      43: item(43, "第二個項目", "<p>沒有連結</p>"),
    },
  },
};

const title = (page) => page.locator(".ado-hero h1").first().textContent();

test("< > 回上一頁、下一頁；在輸入框裡照常打字", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill("#42");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".ado-hero h1")?.textContent?.includes("第一個項目"));
  await page.click(".issue-body a:has-text('另一個項目')");
  await page.waitForFunction(() => document.querySelector(".ado-hero h1")?.textContent?.includes("第二個項目"));
  await page.keyboard.press("<");
  await page.waitForFunction(() => document.querySelector(".ado-hero h1")?.textContent?.includes("第一個項目"));
  await page.keyboard.press(">");
  await page.waitForFunction(() => document.querySelector(".ado-hero h1")?.textContent?.includes("第二個項目"));
  // 在留言框裡按 < 是打字，不換頁。
  const box = page.locator(".ado-compose textarea");
  await box.click();
  await page.keyboard.press("<");
  assert.equal(await box.inputValue(), "<");
  assert.match(await title(page), /第二個項目/);
  assert.deepEqual(errors, []);
  await context.close();
});
