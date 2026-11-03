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
