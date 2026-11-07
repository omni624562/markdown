/**
 * 「依上層項目分組」排成樹：Epic → Feature → Story → Task，每一項只出現一次；不在清單上的上層
 * （例如不是指派給我的 Feature）也列出來當標題列，淡色、不算數。標題列寫摘要（「1 個 User Story・3 個 Task」），
 * 每一層縮排一點（最多 3 層）；「全部收合」收到只剩最上層。用假的原生端（見 helpers.mjs）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const item = (id, title, kind = "Task") => ({
  id,
  title,
  state: "Active",
  kind,
  project: "產品",
  assignedTo: "王小明",
  changed: "2026-11-01T00:00:00Z",
  priority: 2,
  webUrl: `https://ado.test/c/產品/_workitems/edit/${id}`,
});
const EPIC = item(1000, "數位訂單", "Epic");
const FEATURE = item(100, "訂單明細查詢", "Feature");
const STORY10 = item(10, "查詢條件", "User Story");
// 清單（指派給我的）：Task 1、2 在 Story 10（不是我的）底下；Story 20（我的）和 Story 10 都在 Feature 100 底下。
const LISTED = [item(1, "API 規格"), item(20, "退貨申請", "User Story"), item(2, "畫面切版"), item(3, "申請表單"), item(4, "修錯字", "Bug")];
const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_work_items: [LISTED],
  // 一層一層往上讀：清單上的 → Story 10、Feature 100 → Epic 1000。
  ado_work_item_parents: [
    { links: [[1, 10], [2, 10], [20, 100], [3, 20]], parents: [STORY10, FEATURE] },
    { links: [[10, 100], [100, 1000]], parents: [FEATURE, EPIC] },
    { links: [], parents: [] },
  ],
  ado_work_item_children: { links: [], items: [] },
};

/** 清單上每一列：[標題, 淡色, 縮排第幾層, 摘要]；分組的標題列寫成 `# 標題`。 */
const rows = (page) =>
  page.locator("#workitems-host .workitems-list > li").evaluateAll((lis) =>
    lis.map((li) =>
      li.classList.contains("workitems-group")
        ? `# ${li.querySelector(".workitems-group-name").textContent}`
        : [
            li.querySelector(".workitem-title").textContent,
            li.classList.contains("workitems-dim"),
            Number(li.dataset.depth ?? 0),
            li.querySelector(".workitem-summary")?.textContent ?? "",
          ],
    ),
  );

/** 「畫面切版」的內容（從捷徑開啟用）。 */
const DETAIL = {
  ...item(2, "畫面切版"),
  createdBy: "王小明",
  area: "產品",
  iteration: "產品",
  tags: [],
  description: "<p>說明</p>",
  details: null,
  rev: 1,
  relations: [],
  attachments: [],
  comments: [],
};

async function treeList() {
  const opened = await open({ desktop: { ...desktop, ado_work_item: DETAIL } });
  await opened.page.evaluate(() => {
    localStorage.setItem("md-editor:workitem-arrange", "parent");
    localStorage.setItem("md-editor:wiki-shortcuts", JSON.stringify([{ workItem: 2, kind: "Task", title: "畫面切版" }]));
  });
  await opened.page.reload();
  await opened.page.locator("#side-tab-workitems").click();
  await opened.page.locator("#workitems-host .workitem-title", { hasText: "數位訂單" }).waitFor();
  return opened;
}

test("樹狀：一路讀到最上層，每一項只出現一次；不在清單上的上層淡色；標題列寫摘要；每一層縮排", async () => {
  const { page, context, errors } = await treeList();
  assert.deepEqual(await rows(page), [
    ["數位訂單", true, 0, "1 個 User Story・3 個 Task"],
    ["訂單明細查詢", true, 1, "1 個 User Story・3 個 Task"],
    ["查詢條件", true, 2, "2 個 Task"],
    ["API 規格", false, 3, ""],
    ["畫面切版", false, 3, ""],
    ["退貨申請", false, 2, "1 個 Task"],
    ["申請表單", false, 3, ""],
    ["修錯字", false, 0, ""],
  ]);
  // 每一層往右 12px：子項目的內容比上一層的內容多 12px（第 3 層以後一樣）。
  const lefts = await page
    .locator("#workitems-host .workitems-list > li:not(.workitems-group) .workitem")
    .evaluateAll((bs) => bs.map((b) => Math.round(b.getBoundingClientRect().left - b.closest("ul").getBoundingClientRect().left)));
  const [root, f, s10, t1, t2, s20, t3, bug] = lefts;
  assert.deepEqual([f - root, s10 - f, t1 - s10, t2 - t1, s20 - f, t3 - s20], [12, 12, 12, 0, 12, 12], `內容的位置：${lefts}`);
  // 最上層沒有子項目的「修錯字」和旁邊可以展開的「數位訂單」對齊（空出箭頭的位置），上面一樣有分隔線。
  assert.equal(bug, root, `最上層沒有子項目的列要和可以展開的卡片對齊：${lefts}`);
  const line = await page.locator("#workitems-host .workitems-list > li", { hasText: "修錯字" }).evaluate((li) => getComputedStyle(li).borderTopStyle);
  assert.equal(line, "solid");
  // 往上讀了三次：清單上的、上層（Story 10、Feature 100）、最上層（Epic 1000）。
  const asked = (await calls(page)).filter((c) => c.cmd === "ado_work_item_parents").map((c) => [...c.args.ids].sort((a, b) => a - b));
  assert.deepEqual(asked, [[1, 2, 3, 4, 20], [10, 100], [1000]]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("收合一層、全部收合到只剩最上層、全部展開；開啟收起來的項目時展開它的上層", async () => {
  const { page, context, errors } = await treeList();
  const titles = async () => (await rows(page)).map((r) => (typeof r === "string" ? r : r[0]));
  // 收合「查詢條件」：它底下的 Task 不見了。
  await page.locator('#workitems-host .workitems-group-toggle[data-key="parent:tree:10"]').click();
  assert.deepEqual(await titles(), ["數位訂單", "訂單明細查詢", "查詢條件", "退貨申請", "申請表單", "修錯字"]);
  // 全部收合：只剩最上層（沒有上層的 Bug 也是最上層的一列，排在 Epic 後面）。
  await page.click("#workitems-host .workitems-fold");
  assert.deepEqual(await titles(), ["數位訂單", "修錯字"]);
  // 全部展開：裡面收起來的也打開。
  await page.click("#workitems-host .workitems-fold");
  assert.equal((await titles()).length, 8);
  // 再全部收合，然後從左側圖示列的捷徑開啟「畫面切版」：清單展開它的上層、標出來。
  await page.click("#workitems-host .workitems-fold");
  await page.locator(".activity-wiki-page").first().click();
  await page.locator('#workitems-host .workitem[aria-current="true"]', { hasText: "畫面切版" }).waitFor();
  // 只展開它的上層；其他收起來的（「退貨申請」）維持收起來。
  assert.deepEqual(await titles(), ["數位訂單", "訂單明細查詢", "查詢條件", "API 規格", "畫面切版", "退貨申請", "修錯字"]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("編號由大到小：按排列方式旁邊的按鈕，每一層編號大的在上面；記住選擇；不是樹狀的排列方式不顯示", async () => {
  const { page, context, errors } = await treeList();
  const titles = async () => (await rows(page)).map((r) => (typeof r === "string" ? r : r[0]));
  const order = page.locator("#workitems-host .workitems-order");
  assert.equal(await order.getAttribute("aria-pressed"), "false");
  await order.click();
  assert.equal(await order.getAttribute("aria-pressed"), "true");
  // Story 20 在 Story 10 上面，Task 2 在 Task 1 上面；最上層照樣 Epic 在 Bug 前面。
  assert.deepEqual(await titles(), ["數位訂單", "訂單明細查詢", "退貨申請", "申請表單", "查詢條件", "畫面切版", "API 規格", "修錯字"]);
  // 記住選擇（下次開啟還是由大到小）。
  assert.equal(await page.evaluate(() => localStorage.getItem("md-editor:workitem-order")), "desc");
  // 「最近更新」不是依編號排：不顯示這個按鈕。
  await page.locator("#workitems-host select.workitems-arrange").selectOption("recent");
  await order.waitFor({ state: "hidden" });
  // 換回樹狀：按鈕回來，再按一次改回由小到大。
  await page.locator("#workitems-host select.workitems-arrange").selectOption("parent");
  await order.click();
  assert.equal(await order.getAttribute("aria-pressed"), "false");
  assert.equal((await titles())[2], "查詢條件");
  assert.deepEqual(errors, []);
  await context.close();
});
