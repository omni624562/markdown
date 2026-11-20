/**
 * 工作項目的開始、完成、目標日期（app/work-item-dates.ts）：有填的日期顯示在標題下的小標籤；
 * 點一下打開小視窗選日期，儲存時送出那天本地午夜的時間；也可以清除。用假的原生端（見 helpers.mjs）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const DETAIL = {
  id: 42,
  title: "上線準備",
  state: "New",
  kind: "User Story",
  project: "產品",
  assignedTo: "王小明",
  changed: "2026-11-19T00:00:00Z",
  priority: 2,
  webUrl: "https://ado.test/c/產品/_workitems/edit/42",
  createdBy: "李大同",
  area: "產品",
  iteration: "產品\\Sprint 104",
  // 台灣時間 2026-12-04 00:00（Azure DevOps 存成 UTC）。
  finishDate: "2026-12-03T16:00:00Z",
  tags: [],
  description: null,
  details: null,
  rev: 3,
  relations: [],
  attachments: [],
  comments: [],
};

async function openItem(extra = {}) {
  const opened = await open({
    timezoneId: "Asia/Taipei",
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_work_items: [[DETAIL]],
      ado_work_item: { ...DETAIL, ...extra },
      ado_work_item_update: null,
    },
  });
  const { page } = opened;
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill("#42");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ado-hero");
  return opened;
}

test("完成日期顯示在 Sprint 旁邊；點一下改日期、存回 Azure DevOps；可以清除；沒填的日期不顯示", async () => {
  const { page, context, errors } = await openItem();
  const chip = page.locator("button#wi-edit-finishDate");
  assert.match(await chip.textContent(), /完成日期 2026-12-04/);
  assert.equal(await page.locator('.ado-fact[data-field="startDate"], .ado-fact[data-field="targetDate"]').count(), 0, "沒填的日期不顯示");
  await chip.click();
  const box = page.locator("#wi-date-popover");
  await box.waitFor();
  const input = box.locator("input[type=date]");
  assert.equal(await input.inputValue(), "2026-12-04");
  await input.fill("2026-12-11");
  await box.getByRole("button", { name: "儲存" }).click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_work_item_update"));
  const update = (await calls(page)).filter((c) => c.cmd === "ado_work_item_update").map((c) => c.args.change);
  // 台灣的 12/11 午夜 = UTC 12/10 16:00（和 Azure DevOps 網頁版選日期時存的一樣）。
  assert.equal(update[0].finishDate, "2026-12-10T16:00:00.000Z");
  await box.waitFor({ state: "detached" });

  // 清除。
  await page.locator("button#wi-edit-finishDate").click();
  await page.locator("#wi-date-popover").getByRole("button", { name: "清除日期" }).click();
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "ado_work_item_update").length === 2);
  const second = (await calls(page)).filter((c) => c.cmd === "ado_work_item_update")[1].args.change;
  assert.equal(second.finishDate, "");
  assert.deepEqual(errors, []);
  await context.close();
});
