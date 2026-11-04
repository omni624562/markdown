/**
 * 工作項目、Wiki 內容裡的「#編號」換成工作項目連結：伺服器上有這個工作項目才換（兩位數以下、程式碼裡、
 * 查不到的都不換）；滑鼠停一下顯示摘要卡片，點一下在 oMarker 開啟。用假的原生端（見 helpers.mjs）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const base = { project: "產品", assignedTo: "王小明", changed: "2026-10-30T00:00:00Z", priority: 2 };
const item = (id, title, kind = "Task", state = "New") => ({ ...base, id, title, kind, state, webUrl: `https://ado.test/c/產品/_workitems/edit/${id}` });
const detail = (w, description) => ({
  ...w,
  createdBy: "王小明",
  area: "產品",
  iteration: "產品",
  tags: [],
  description,
  details: null,
  rev: 1,
  relations: [],
  attachments: [],
  comments: [],
});
const STORY = item(1895964, "會員點數查詢與調整", "User Story", "Active");
const TASK = item(1895969, "更新需求說明書範圍");
const MAIN = detail(
  item(42, "需求差異整理"),
  [
    "<p>Story #1895964 / Task #1895969（New）：update</p>",
    "<p>第 #12 點、#9999999 已刪除</p>",
    "<p><code>#1895970</code></p>",
    "<table><tr><th>類型</th><th>Work Item ID</th></tr><tr><td>Story</td><td>#1895964</td></tr></table>",
  ].join(""),
);
const refs = (page) => page.locator(".issue-body a.wi-ref").allTextContents();
/** 為了「#編號」問伺服器的編號（狀態標籤等其他功能也會用同一個指令，只看有內文編號的）。 */
const lookups = async (page) =>
  (await calls(page)).filter((c) => c.cmd === "ado_work_items_by_ids" && c.args.ids.includes(1895964)).map((c) => c.args.ids);

async function openItem(page, id) {
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill(`#${id}`);
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ado-hero");
}

test("工作項目內容：有的「#編號」換成連結，滑鼠停一下顯示摘要，點一下在 oMarker 開啟", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_work_item: { $by: "id", values: { 42: MAIN, 1895964: detail(STORY, "<p>Story</p>"), 1895969: detail(TASK, "<p>範圍</p>") } },
      // 9999999 查不到（刪除了、沒有權限）：伺服器不回傳。
      ado_work_items_by_ids: [[STORY, TASK]],
    },
  });
  await openItem(page, 42);
  await page.waitForFunction(() => document.querySelectorAll(".issue-body a.wi-ref").length === 3);
  assert.deepEqual(await refs(page), ["#1895964", "#1895969", "#1895964"], "內文與表格裡的編號都換了");
  assert.deepEqual(await lookups(page), [[1895964, 1895969, 9999999]], "一次問完；兩位數以下、程式碼裡、段落標題列摘要裡的不問");
  assert.equal(await page.locator(".issue-body p", { hasText: "第 #12 點" }).locator("a").count(), 0, "#12、查不到的 #9999999 維持文字");
  assert.equal(await page.locator(".issue-body code").textContent(), "#1895970", "程式碼裡的不換");

  // 滑鼠停一下：摘要卡片。
  await page.locator(".issue-body a.wi-ref", { hasText: "#1895969" }).hover();
  const card = page.locator(".remote-card-floating");
  await card.locator(".remote-card-title", { hasText: "更新需求說明書範圍" }).waitFor();
  assert.match(await card.locator(".remote-card-source").textContent(), /Task 1895969/);

  // 點一下：在 oMarker 開那個工作項目（不開瀏覽器）。
  await page.locator(".issue-body a.wi-ref", { hasText: "#1895969" }).click();
  await page.locator(".ado-hero", { hasText: "更新需求說明書範圍" }).waitFor();
  assert.deepEqual((await calls(page)).filter((c) => c.cmd === "open_external"), []);
  // 回到原本的工作項目：查過的編號不再問伺服器。
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForFunction(() => document.querySelectorAll(".issue-body a.wi-ref").length === 3);
  assert.equal((await lookups(page)).length, 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test("Wiki 頁面裡的「#編號」也換成工作項目連結（表格、內文）", async () => {
  const WIKI = {
    id: "w1",
    name: "Contoso.wiki",
    project: "Contoso",
    projectId: "p1",
    code: false,
    repositoryId: "r1",
    mappedPath: "/",
    version: "wikiMaster",
    webUrl: "https://ado.test/c/Contoso/_wiki/wikis/Contoso.wiki",
  };
  const content = ["# 對焦紀錄", "", "| 類型 | Work Item ID |", "| --- | --- |", "| Feature | #1940122 |", "", "相關：Story #1895964"].join("\n");
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_wikis: [[WIKI]],
      ado_wiki_pages: [[{ path: "/對焦紀錄", id: 1, children: [] }]],
      ado_wiki_page: { content, webUrl: null, etag: null },
      ado_work_items_by_ids: [[item(1940122, "專案", "Feature"), STORY]],
    },
  });
  await page.click("#side-tab-wiki");
  await page.click('#wiki-host .wiki-page[data-path="/對焦紀錄"]');
  await page.waitForFunction(() => document.querySelectorAll(".issue-body a.wi-ref").length === 2);
  assert.deepEqual(await refs(page), ["#1940122", "#1895964"]);
  assert.deepEqual(errors, []);
  await context.close();
});
