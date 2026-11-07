/**
 * 工作項目進度：
 * - 「依上層項目分組」時 Feature、Story 那一列有進度條與「完成數/全部」，Feature 算的是底下所有的 Task；
 *   排列方式旁邊可以切換依數量／依工時。
 * - 工作項目分頁「子項目」上方有分色長條、「4/8 完成」與圖例；點圖例只留那個狀態的子項目，再點一次全部顯示。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const item = (id, title, kind = "Task", state = "Active", extra = {}) => ({
  id,
  title,
  state,
  kind,
  project: "產品",
  assignedTo: "王小明",
  changed: "2026-11-01T00:00:00Z",
  priority: 2,
  webUrl: `https://ado.test/tfs/DefaultCollection/產品/_workitems/edit/${id}`,
  ...extra,
});

const FEATURE = item(200, "會員中心", "Feature");
const STORY = item(201, "登入與註冊", "User Story");
const STORY2 = item(202, "個人資料編輯", "User Story");
const TASKS = [
  item(1001, "畫面切版", "Task", "Closed", { remaining: 0, completed: 6 }),
  item(1002, "串接登入 API", "Task", "Active", { remaining: 4, completed: 2 }),
  item(1003, "忘記密碼信", "Bug", "Resolved"),
  item(1004, "記住我", "Task", "New", { remaining: 3 }),
  item(1005, "頭像上傳", "Task", "Done", { remaining: 0, completed: 5 }),
];
const LINKS = [[201, 200], [202, 200], [1001, 201], [1002, 201], [1003, 201], [1004, 201], [1005, 202]];
const FILTER = { role: "assigned", person: "", state: "all", kinds: [], projects: ["產品"], areas: [] };

test("依上層項目分組：Feature、Story 有進度條，可以切換依工時", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/tfs/DefaultCollection", name: "王小明" },
      ado_work_items: [TASKS],
      ado_work_item_parents: [
        { links: LINKS.filter(([c]) => c > 1000), parents: [STORY, STORY2] },
        { links: [[201, 200], [202, 200]], parents: [FEATURE] },
        { links: [], parents: [] },
      ],
      ado_work_item_children: { links: [], items: [] },
    },
  });
  await page.evaluate((filter) => {
    localStorage.setItem("md-editor:workitem-arrange", "parent");
    localStorage.setItem("md-editor:workitem-filter", JSON.stringify(filter));
  }, FILTER);
  await page.reload();
  await page.locator("#side-tab-workitems").click();
  const card = (title) => page.locator("#workitems-host .workitems-group-card", { hasText: title });
  await card("會員中心").locator(".workitem-progress").waitFor();
  // Feature 算的是底下所有的 Task（5 個，完成的是 Closed 與 Done），不是 Story 的數量。
  assert.equal(await card("會員中心").locator(".workitem-progress-num").first().textContent(), "2/5");
  const story = card("登入與註冊").locator(".workitem-progress");
  assert.equal(await story.locator(".workitem-progress-num").textContent(), "1/4");
  const segments = await story.locator(".wi-bar > i").evaluateAll((els) => els.map((el) => [el.className, el.style.width]));
  assert.deepEqual(segments, [["wi-bar-closed", "25%"], ["wi-bar-resolved", "25%"], ["wi-bar-active", "25%"], ["wi-bar-new", "25%"]]);
  const tip = await story.getAttribute("title");
  assert.match(tip, /User Story 201：1\/4 完成（25%）/);
  assert.match(tip, /待驗證 1（Resolved）/);
  assert.match(tip, /剩餘 7 小時・已完成 8 小時/);
  // Task 沒有子項目：沒有進度條。
  assert.equal(await page.locator("#workitems-host .workitems-child", { hasText: "畫面切版" }).locator(".workitem-progress").count(), 0);

  // 切換成依工時：已完成 8、剩餘 7。
  const toggle = page.locator("#workitems-host .workitems-progress");
  assert.equal(await toggle.getAttribute("aria-pressed"), "false");
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  assert.equal(await card("登入與註冊").locator(".workitem-progress-num").textContent(), "8/15 h");
  assert.equal(await page.evaluate(() => localStorage.getItem("md-editor:workitem-progress-hours")), "1");
  assert.deepEqual(errors, []);
  await context.close();
});

const DETAIL = {
  ...STORY,
  createdBy: "王小明",
  area: "產品",
  iteration: "產品",
  tags: [],
  description: "<p>說明</p>",
  details: null,
  rev: 3,
  relations: [{ ...FEATURE, link: "parent" }, ...TASKS.slice(0, 4).map((t) => ({ ...t, link: "child" }))],
  attachments: [],
  comments: [],
};

test("工作項目分頁：子項目上方的分色長條，點圖例只看那個狀態", async () => {
  const { page, context, errors } = await open({
    desktop: { ado_account: { url: "https://ado.test/tfs/DefaultCollection", name: "王小明" }, ado_work_item: DETAIL },
  });
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill("#201");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
  const box = page.locator(".issue-pane .wi-progress");
  await box.waitFor();
  assert.equal(await box.locator(".wi-progress-head").textContent(), "1/4 完成・25%");
  assert.deepEqual(await box.locator(".wi-progress-legend button").allTextContents(), ["完成 1", "待驗證 1", "進行中 1", "還沒開始 1"]);
  assert.equal(await box.locator(".wi-progress-hours").textContent(), "剩餘 7 小時・已完成 8 小時・合計 15 小時");
  // 進度條在「子項目」標題的下面、子項目清單的上面。
  assert.equal(await box.evaluate((el) => el.previousElementSibling?.textContent), "子項目");
  const rows = page.locator(".issue-pane .wi-progress + ul > li");
  assert.equal(await rows.count(), 4);
  const visible = () => rows.evaluateAll((els) => els.filter((el) => !el.hidden).map((el) => el.querySelector("a")?.textContent));
  await box.getByRole("button", { name: "進行中 1" }).click();
  assert.deepEqual(await visible(), [(await rows.nth(1).locator("a").textContent())]);
  assert.match((await visible())[0], /串接登入 API/);
  assert.equal(await box.getByRole("button", { name: "進行中 1" }).getAttribute("aria-pressed"), "true");
  // 再點一次：全部顯示。
  await box.getByRole("button", { name: "進行中 1" }).click();
  assert.equal((await visible()).length, 4);
  assert.deepEqual(errors, []);
  await context.close();
});
