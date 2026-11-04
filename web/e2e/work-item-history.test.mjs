/**
 * 工作項目的修改紀錄：標頭的「修改紀錄」開在同一個分頁，依日期排成時間軸，列出誰、什麼時候改了哪些欄位；
 * 雜訊欄位不列、只調整 Backlog 順序的不列。按上一頁回到工作項目。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const base = { project: "產品", assignedTo: "王小明", changed: "2026-10-30T00:00:00Z", priority: 2 };
const DETAIL = {
  ...base,
  id: 42,
  title: "修正登入",
  state: "Active",
  kind: "Bug",
  webUrl: "https://ado.test/c/產品/_workitems/edit/42",
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
};
const HISTORY = [
  {
    rev: 4,
    author: "李大同",
    date: "2026-10-30T02:00:00Z",
    fields: [
      { field: "System.State", old: "New", new: "Active", long: false },
      { field: "System.Reason", old: "New", new: "Implementation started", long: false },
      { field: "Microsoft.VSTS.Common.ActivatedBy", old: null, new: "李大同", long: false },
      { field: "WEF_1_Kanban.Column", old: "New", new: "Active", long: false },
    ],
    comment: "<p>開始處理</p>",
    added: [{ kind: "parent", id: 7, name: "Parent" }],
    removed: [],
  },
  {
    rev: 3,
    author: "李大同",
    date: "2026-10-30T01:58:00Z",
    fields: [{ field: "Microsoft.VSTS.Common.StackRank", old: "1000000002.0", new: "799907902.0", long: false }],
    comment: null,
    added: [],
    removed: [],
  },
  {
    rev: 2,
    author: "陳小華",
    date: "2026-10-15T02:00:00Z",
    fields: [{ field: "Microsoft.VSTS.Common.StackRank", old: "1.0", new: "2.0", long: false }],
    comment: null,
    added: [],
    removed: [],
  },
  { rev: 1, author: "王小明", date: "2026-10-01T02:00:00Z", fields: [{ field: "System.Title", old: null, new: "修正登入", long: false }], comment: null, added: [], removed: [] },
];

test("工作項目的修改紀錄：同一個分頁開啟，排成時間軸，按上一頁回到工作項目", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_work_item: DETAIL,
      ado_work_item_history: [HISTORY],
    },
  });
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill("#42");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
  await page.locator(".issue-pane .issue-body", { hasText: "說明" }).waitFor();
  const tabs = await page.locator(".tab").count();
  await page.locator(".issue-pane button[aria-label^='修改紀錄']").click();
  const body = page.locator(".issue-pane .issue-body");
  await body.locator(".wih-entry", { hasText: "李大同" }).waitFor();
  assert.equal((await calls(page)).find((c) => c.cmd === "ado_work_item_history").args.id, 42);
  const text = await body.textContent();
  // 複製文字、在內容中尋找時還是「欄位：值」。
  assert.match(text, /狀態：New → Active（Implementation started）/);
  assert.match(text, /調整 Backlog 順序/);
  assert.match(text, /加入上層 #7/);
  assert.match(text, /開始處理/);
  assert.match(text, /工作項目標題：修正登入/);
  assert.doesNotMatch(text, /1000000002|799907902|ActivatedBy|啟用者|Column/, "雜訊欄位與 Backlog 順序的數字不列");
  assert.equal(await page.locator(".tab").count(), tabs, "開在同一個分頁");

  // 精簡的標頭：類型標籤與編號、標題（不是很大的字），下面是共幾次修改；標頭列不再重複標題。
  const head = body.locator(".wih-head");
  assert.equal(await head.locator(".ado-kind-badge").textContent(), "Bug");
  assert.equal(await head.locator(".ado-kind-badge").getAttribute("data-wi-kind"), "bug");
  assert.equal(await head.locator(".wih-id").textContent(), "42");
  assert.equal(await head.locator("h1").textContent(), "修正登入");
  const size = (loc) => loc.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  assert.ok((await size(head.locator("h1"))) <= (await size(body)) * 1.25, "標題大約 1.2 倍字");
  assert.equal(await head.locator(".wih-summary").textContent(), "共 2 次修改（另有 1 次只調整 Backlog 順序，沒有列出）");
  assert.equal(await body.locator(":scope > h1").count(), 0, "沒有原本的大標題");
  assert.equal(await page.locator(".issue-pane .issue-head .issue-title").isVisible(), false);

  // 依日期分段：最新的在前面。
  const days = await body.locator(".wih-day > h2").allTextContents();
  assert.equal(days.length, 2);
  for (const d of days) assert.match(d, /^2026年10月\d+日 週.$/);

  // 每一項一個頭像，名字與時間在右邊。
  const entries = body.locator(".wih-entry");
  assert.equal(await entries.count(), 2);
  assert.equal(await body.locator(".wih-avatar").count(), 2);
  for (let i = 0; i < 2; i++) assert.equal(await entries.nth(i).locator(":scope > .wih-avatar").count(), 1);
  assert.equal(await entries.nth(0).locator(".wih-avatar").textContent(), "李");
  assert.equal(await entries.nth(0).locator(".wih-name").textContent(), "李大同");
  assert.match(await entries.nth(0).locator(".wih-time").textContent(), /^\d\d:00$/);
  assert.equal(await entries.nth(1).locator(".wih-name").textContent(), "王小明");

  // 欄位排成兩欄：名稱、值（原本淡色、之後粗體，原因在後面）。
  const state = entries.nth(0).locator(".wih-changes > li", { hasText: "狀態" });
  assert.equal(await state.evaluate((el) => getComputedStyle(el).display), "grid");
  assert.equal(await state.locator(".wih-field").textContent(), "狀態");
  assert.equal(await state.locator(".wih-old").textContent(), "New");
  assert.equal(await state.locator(".wih-new").textContent(), "Active");
  assert.equal(await state.locator(".wih-reason").textContent(), "（Implementation started）");
  const [field, value] = await Promise.all([state.locator(".wih-field").boundingBox(), state.locator(".wih-value").boundingBox()]);
  assert.ok(value.x > field.x + field.width, "值在欄位名稱右邊");
  assert.ok(Math.abs(value.y - field.y) < 4, "同一行");
  assert.ok(await entries.nth(0).locator(".wih-changes > li.wih-muted", { hasText: "調整 Backlog 順序" }).count());
  assert.match(await entries.nth(0).locator(".wih-comment").textContent(), /留言：\s*開始處理/);

  // 上一頁：回到工作項目。
  await page.keyboard.press("Alt+ArrowLeft");
  await page.locator(".issue-pane .issue-body", { hasText: "說明" }).waitFor();
  assert.doesNotMatch(await body.textContent(), /狀態：New → Active/);
  assert.equal(await body.locator(".wih-head").count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
