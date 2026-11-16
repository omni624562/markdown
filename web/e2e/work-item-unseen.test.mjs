/**
 * 圖示上的數字：清單上方說明有幾個新的或有更新、可以只看這些；開過的項目（含自己改過的）記成看過。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const item = (id, title, changed = "2026-11-01T00:00:00Z") => ({
  id,
  title,
  state: "Active",
  kind: "Task",
  project: "產品",
  assignedTo: "王小明",
  changed,
  priority: 2,
  webUrl: `https://ado.test/c/產品/_workitems/edit/${id}`,
});
const detail = (w, changed) => ({
  ...w,
  changed,
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
});

test("清單上方：有幾個新的或有更新，只看這些；開過就少一個", async () => {
  const mine = [item(1, "第一個"), item(2, "第二個"), item(3, "第三個")];
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_work_items: [mine],
      // 伺服器上的最後更新時間比清單上的晚（例如自己剛改過）：開過之後也算看過。
      ado_work_item: { $by: "id", values: { 2: detail(mine[1], "2026-11-02T00:00:00Z") } },
    },
  });
  // 第一次使用時清單上的都算看過；把記錄清掉，模擬三個都是新的。
  await page.evaluate(() => localStorage.setItem("md-editor:workitem-seen", "{}"));
  await page.reload();
  await page.locator("#side-tab-workitems").click();
  const line = page.locator(".workitems-unseen");
  await line.getByText("有 3 個新的或有更新").waitFor();
  assert.match(await page.locator("#side-tab-workitems .ado-badge, #ado-badge").first().getAttribute("title"), /別人的、已結束的不算/);
  await line.getByRole("button", { name: "只看這些" }).click();
  await page.locator("#workitems-host .workitems-status", { hasText: "3 個指派給你、新的或有更新的工作項目" }).waitFor();
  await page.locator("#workitems-host .workitem", { hasText: "第二個" }).click();
  await line.getByText("只列出新的或有更新的（2）").waitFor();
  assert.equal(await page.textContent("#ado-badge"), "2");
  await line.getByRole("button", { name: "顯示完整清單" }).click();
  await line.getByText("有 2 個新的或有更新").waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test("重新整理清單：上方那一行字和「有幾個新的」不會先清掉再出現（看起來像整個重刷）", async () => {
  const mine = [item(1, "第一個"), item(2, "第二個"), item(3, "第三個")];
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      // 之後的讀取慢一點：看得出讀取中畫面有沒有變。
      ado_work_items: [mine, { $delay: 600, value: mine }],
    },
  });
  await page.evaluate(() => localStorage.setItem("md-editor:workitem-seen", "{}"));
  await page.reload();
  await page.locator("#side-tab-workitems").click();
  const line = page.locator(".workitems-unseen");
  await line.getByText("有 3 個新的或有更新").waitFor();
  const status = page.locator("#workitems-host .workitems-status");
  await status.getByText("3 個指派給你").waitFor();
  const before = await status.textContent();
  // 記下「有幾個新的」那一列的按鈕：沒變就不重畫，按鈕還是同一個。
  await line.getByRole("button", { name: "只看這些" }).evaluate((b) => (b.dataset.mark = "same"));
  await page.locator("#workitems-refresh").click();
  await page.waitForTimeout(200);
  assert.equal(await status.textContent(), before, "讀取中：那一行字不換成「讀取中…」");
  assert.equal(await status.evaluate((el) => el.classList.contains("updating")), true, "只淡一點表示正在更新");
  await page.waitForFunction(() => !document.querySelector("#workitems-host .workitems-status")?.classList.contains("updating"));
  assert.equal(await line.locator('[data-mark="same"]').count(), 1, "「有幾個新的」那一列沒有重畫");
  assert.deepEqual(errors, []);
  await context.close();
});

test("改了工作項目之後清單在背景更新：不先換上剛才的副本（「…的資料，更新中…」），清單上方那一行高度不變", async () => {
  const mine = [item(1, "第一個"), item(2, "第二個")];
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      // 改完之後的那次讀取慢一點：這段時間畫面不能變。
      ado_work_items: [mine, { $delay: 800, value: [{ ...mine[0], state: "Resolved" }, mine[1]] }],
      // 本機存著剛才清單的副本：背景更新時會先拿到它（「…的資料，更新中…」）。
      offline_get: JSON.stringify({ $copy: 1, savedAt: Date.now() - 60_000, value: mine }),
      ado_work_item: { $by: "id", values: { 1: detail(mine[0], mine[0].changed) } },
      ado_work_item_states: [["New", "Active", "Resolved"]],
    },
  });
  await page.locator("#side-tab-workitems").click();
  const status = page.locator("#workitems-host .workitems-status");
  await status.getByText("指派給你").waitFor();
  await page.locator("#workitems-host .workitem", { hasText: "第一個" }).click();
  await page.waitForSelector(".ado-hero");
  const before = await status.evaluate((el) => [el.textContent, el.getBoundingClientRect().height]);
  await page.locator("button#wi-edit-state").click();
  await page.locator("#wi-edit-state-popover button", { hasText: "Resolved" }).click();
  await page.locator(".toast", { hasText: "已把狀態改成「Resolved」" }).waitFor();
  await page.waitForTimeout(300);
  assert.deepEqual(await status.evaluate((el) => [el.textContent, el.getBoundingClientRect().height]), before, "讀取中：那一行不變");
  await page.locator("#workitems-host .workitem", { hasText: "第一個" }).getByText("Resolved").waitFor();
  assert.equal(await status.evaluate((el) => el.getBoundingClientRect().height), before[1], "讀完：高度不變");
  assert.deepEqual(errors, []);
  await context.close();
});
