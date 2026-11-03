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
const EPIC = item(1000, "數位帳務", "Epic");
const FEATURE = item(100, "消費明細查詢", "Feature");
const STORY10 = item(10, "查詢條件", "User Story");
// 清單（指派給我的）：Task 1、2 在 Story 10（不是我的）底下；Story 20（我的）和 Story 10 都在 Feature 100 底下。
const LISTED = [item(1, "API 規格"), item(20, "爭議帳申請", "User Story"), item(2, "畫面切版"), item(3, "申請表單"), item(4, "修錯字", "Bug")];
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
  await opened.page.locator("#workitems-host .workitem-title", { hasText: "數位帳務" }).waitFor();
  return opened;
}

test("樹狀：一路讀到最上層，每一項只出現一次；不在清單上的上層淡色；標題列寫摘要；每一層縮排", async () => {
  const { page, context, errors } = await treeList();
  assert.deepEqual(await rows(page), [
    ["數位帳務", true, 0, "1 個 User Story・3 個 Task"],
    ["消費明細查詢", true, 1, "1 個 User Story・3 個 Task"],
    ["查詢條件", true, 2, "2 個 Task"],
    ["API 規格", false, 3, ""],
    ["畫面切版", false, 3, ""],
    ["爭議帳申請", false, 2, "1 個 Task"],
    ["申請表單", false, 3, ""],
    "# 沒有上層項目",
    ["修錯字", false, 0, ""],
  ]);
  // 每一層往右 12px：子項目的內容比上一層的內容多 12px（第 3 層以後一樣）。
  const lefts = await page
    .locator("#workitems-host .workitems-list > li:not(.workitems-group) .workitem")
    .evaluateAll((bs) => bs.map((b) => Math.round(b.getBoundingClientRect().left - b.closest("ul").getBoundingClientRect().left)));
  const [root, f, s10, t1, t2, s20, t3] = lefts;
  assert.deepEqual([f - root, s10 - f, t1 - s10, t2 - t1, s20 - f, t3 - s20], [12, 12, 12, 0, 12, 12], `內容的位置：${lefts}`);
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
  assert.deepEqual(await titles(), ["數位帳務", "消費明細查詢", "查詢條件", "爭議帳申請", "申請表單", "# 沒有上層項目", "修錯字"]);
  // 全部收合：只剩最上層與「沒有上層項目」的標題。
  await page.click("#workitems-host .workitems-fold");
  assert.deepEqual(await titles(), ["數位帳務", "# 沒有上層項目"]);
  // 全部展開：裡面收起來的也打開。
  await page.click("#workitems-host .workitems-fold");
  assert.equal((await titles()).length, 9);
  // 再全部收合，然後從左側圖示列的捷徑開啟「畫面切版」：清單展開它的上層、標出來。
  await page.click("#workitems-host .workitems-fold");
  await page.locator(".activity-wiki-page").first().click();
  await page.locator('#workitems-host .workitem[aria-current="true"]', { hasText: "畫面切版" }).waitFor();
  // 只展開它的上層；其他收起來的（「爭議帳申請」、「沒有上層項目」）維持收起來。
  assert.deepEqual(await titles(), ["數位帳務", "消費明細查詢", "查詢條件", "API 規格", "畫面切版", "爭議帳申請", "# 沒有上層項目"]);
  assert.deepEqual(errors, []);
  await context.close();
});
