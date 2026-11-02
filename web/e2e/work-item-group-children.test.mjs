/**
 * 「依上層項目分組」：清單只取最近更新的 100 個，比較早更新的子項目不在清單上；
 * 另外讀上層底下符合篩選條件的子項目補進組裡，組裡的數量才和上層項目實際的子項目一致。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const item = (id, title, kind = "Task", state = "Active", changed = "2026-11-01T00:00:00Z") => ({
  id,
  title,
  state,
  kind,
  project: "產品",
  assignedTo: "王小明",
  changed,
  priority: 2,
  webUrl: `https://ado.test/c/產品/_workitems/edit/${id}`,
});
const STORY = item(10, "整理文件", "User Story");
// 清單上（最近更新的）只有兩個子項目。
const LISTED = [STORY, item(11, "同步範例"), item(12, "使用範例")];
// 比較早更新、已經關閉的子項目：不在清單上。
const OLDER = [
  item(13, "整合教學", "Task", "Closed", "2026-09-01T00:00:00Z"),
  item(14, "更新角色", "Task", "Closed", "2026-10-01T00:00:00Z"),
  item(15, "發佈流程", "Task", "Closed", "2026-08-01T00:00:00Z"),
];
const FILTER = { role: "assigned", person: "", state: "all", kinds: [], projects: ["產品"], areas: [] };

test("依上層項目分組：組裡補上不在清單上的子項目，數量和上層項目的子項目一致", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_work_items: [LISTED],
      ado_work_item_parents: { links: [[11, 10], [12, 10]], parents: [STORY] },
      ado_work_item_children: {
        links: [[11, 10], [12, 10], [13, 10], [14, 10], [15, 10]],
        items: [LISTED[1], LISTED[2], ...OLDER],
      },
    },
  });
  await page.evaluate((filter) => {
    localStorage.setItem("md-editor:workitem-arrange", "parent");
    localStorage.setItem("md-editor:workitem-filter", JSON.stringify(filter));
  }, FILTER);
  await page.reload();
  await page.locator("#side-tab-workitems").click();
  const head = page.locator("#workitems-host .workitems-group-card", { hasText: "整理文件" });
  await head.locator(".workitems-group-count", { hasText: "5" }).waitFor();
  // 照更新時間排：清單上的在前面，補上的依序是 10/1、9/1、8/1。
  const children = await page.locator("#workitems-host .workitems-child").allTextContents();
  const order = ["同步範例", "使用範例", "更新角色", "整合教學", "發佈流程"].map((title) => children.findIndex((c) => c.includes(title)));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), `子項目的順序：${children.join(" | ")}`);
  // 讀子項目時用的是同一組篩選條件，只讀分組裡的上層。
  const req = (await calls(page)).find((c) => c.cmd === "ado_work_item_children").args;
  assert.deepEqual(req.parents, [10]);
  assert.equal(req.search, "");
  assert.equal(req.filter.state, "all");
  assert.deepEqual(req.filter.projects, ["產品"]);
  // 清單本身的數量不變（標題寫的是清單上的個數）。
  assert.match(await page.textContent("#workitems-host .workitems-status"), /符合篩選條件的工作項目（3）/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("依上層項目分組：讀不到子項目（舊版伺服器）時照原本的清單分組，不跳錯誤", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_work_items: [LISTED],
      ado_work_item_parents: { links: [[11, 10], [12, 10]], parents: [STORY] },
      ado_work_item_children: { $error: "伺服器回應 400" },
    },
  });
  await page.evaluate((filter) => {
    localStorage.setItem("md-editor:workitem-arrange", "parent");
    localStorage.setItem("md-editor:workitem-filter", JSON.stringify(filter));
  }, FILTER);
  await page.reload();
  await page.locator("#side-tab-workitems").click();
  const head = page.locator("#workitems-host .workitems-group-card", { hasText: "整理文件" });
  await head.locator(".workitems-group-count", { hasText: "2" }).waitFor();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_work_item_children"));
  await page.waitForTimeout(300);
  assert.equal(await head.locator(".workitems-group-count").textContent(), "2");
  assert.equal(await page.locator(".toast-error").count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
