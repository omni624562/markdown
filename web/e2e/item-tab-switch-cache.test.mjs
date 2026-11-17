/**
 * 工作項目分頁來回切換：讀過的直接顯示，只問伺服器修訂版本（很便宜），沒變就不重讀、不重畫
 * （工作項目一次要讀好幾個請求，分頁多時伺服器慢就會卡）；修訂版本變了才重讀；按「重新整理」照樣重讀（用假的原生端，見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const base = { project: "產品", assignedTo: "王小明", changed: "2026-10-30T00:00:00Z", priority: 2, kind: "Task", state: "Active" };
const detail = (id, title) => ({
  ...base,
  id,
  title,
  webUrl: `https://ado.test/c/產品/_workitems/edit/${id}`,
  createdBy: "王小明",
  area: "產品",
  iteration: "產品",
  tags: [],
  description: `<p>${title}的說明</p>`,
  details: null,
  rev: 3,
  relations: [],
  attachments: [],
  comments: [],
});
const A = detail(41, "修正登入");
const B = detail(42, "匯出 PDF");

async function openById(page, id, text) {
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill(`#${id}`);
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
  await page.locator(".issue-body", { hasText: text }).waitFor();
}

test("工作項目分頁來回切換：修訂版本沒變就不重讀；變了才重讀；按「重新整理」照樣重讀", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_work_items: [[A, B]],
      ado_work_item: { $by: "id", values: { 41: A, 42: B } },
      // 前六次（來回切三次）修訂版本都沒變；之後有人改了。
      ado_work_item_rev: [3, 3, 3, 3, 3, 3, 4],
    },
  });
  await openById(page, 41, "修正登入的說明");
  await openById(page, 42, "匯出 PDF的說明");
  const reads = async () => (await calls(page)).filter((c) => c.cmd === "ado_work_item").length;
  const before = await reads();
  for (let i = 0; i < 3; i++) {
    await page.locator('#tab-bar [data-id]', { hasText: "修正登入" }).click();
    await page.locator(".issue-body", { hasText: "修正登入的說明" }).waitFor();
    await page.locator('#tab-bar [data-id]', { hasText: "匯出 PDF" }).click();
    await page.locator(".issue-body", { hasText: "匯出 PDF的說明" }).waitFor();
  }
  await page.waitForTimeout(300);
  assert.equal(await reads(), before, "修訂版本沒變：切換分頁沒有再讀整份");
  assert.equal((await calls(page)).filter((c) => c.cmd === "ado_work_item_rev").length, 6, "每次切換只問修訂版本");
  // 修訂版本變了：讀整份。
  await page.locator('#tab-bar [data-id]', { hasText: "修正登入" }).click();
  await page.waitForFunction((n) => window.__fake.calls.filter((c) => c.cmd === "ado_work_item").length === n + 1, before);
  const after = await reads();
  await page.locator(".issue-pane").getByRole("button", { name: "重新整理" }).click();
  await page.waitForFunction((n) => window.__fake.calls.filter((c) => c.cmd === "ado_work_item").length > n, after);
  assert.deepEqual(errors, []);
  await context.close();
});

test("從捲到下面的工作項目切到另一個：標頭不會閃出新分頁的標題（淡出的動畫不帶到新分頁）", async () => {
  const long = { ...A, description: `<p>${"很長的說明。".repeat(40)}</p>`.repeat(30) };
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_work_items: [[long, B]],
      ado_work_item: { $by: "id", values: { 41: long, 42: B } },
      ado_work_item_rev: 3,
    },
  });
  await openById(page, 42, "匯出 PDF的說明");
  await openById(page, 41, "很長的說明");
  // 捲到下面：標頭帶出標題。
  await page.evaluate(() => document.querySelector(".issue-pane .issue-scroll").scrollBy(0, 2000));
  await page.waitForSelector(".issue-pane.issue-title-away");
  await page.waitForTimeout(300);
  // 切到另一個分頁：之後每一個畫面都記下標頭標題的不透明度。
  await page.evaluate(() => {
    window.__seen = [];
    const title = document.querySelector(".issue-pane .issue-head .issue-title");
    const tick = () => {
      window.__seen.push([title.textContent, Number(getComputedStyle(title).opacity), getComputedStyle(title).visibility]);
      if (window.__seen.length < 30) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.locator('#tab-bar [data-id]', { hasText: "匯出 PDF" }).click();
  await page.locator(".issue-body", { hasText: "匯出 PDF的說明" }).waitFor();
  await page.waitForTimeout(600);
  const flashes = (await page.evaluate(() => window.__seen)).filter(([text, opacity, vis]) => text.includes("匯出 PDF") && opacity > 0 && vis === "visible");
  assert.deepEqual(flashes, [], "新分頁的標題沒有出現在標頭");
  assert.deepEqual(errors, []);
  await context.close();
});

test("切換回工作項目分頁：直接換上之前畫好的畫面，不重畫（內容長、分頁多時才不會卡）", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_work_items: [[A, B]],
      ado_work_item: { $by: "id", values: { 41: A, 42: B } },
      ado_work_item_rev: 3,
    },
  });
  await openById(page, 41, "修正登入的說明");
  // 在畫好的畫面上做記號：重畫的話記號就不見了。
  await page.evaluate(() => (document.querySelector(".issue-body .ado-hero").__kept = true));
  await openById(page, 42, "匯出 PDF的說明");
  await page.locator('#tab-bar [data-id]', { hasText: "修正登入" }).click();
  await page.locator(".issue-body", { hasText: "修正登入的說明" }).waitFor();
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.querySelector(".issue-body .ado-hero")?.__kept), true, "是同一個畫面，沒有重畫");
  // 標頭的類型標籤也一起換回來。
  assert.match(await page.textContent(".issue-head .issue-meta"), /Task/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("切換回 Wiki 分頁：只問頁面的版本（ETag），沒被改過就不重讀、不重畫；改過才重讀", async () => {
  const WIKI = { id: "w1", name: "Contoso.wiki", project: "Contoso", projectId: "p1", code: false, repositoryId: "r1", mappedPath: "/", version: "wikiMaster", webUrl: "https://ado.test/c/Contoso/_wiki/wikis/Contoso.wiki" };
  const pages = [{ path: "/首頁", id: 1, children: [] }, { path: "/規格", id: 2, children: [] }];
  const page = (content, etag) => ({ content, webUrl: null, etag });
  const { page: p, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_wikis: [[WIKI]],
      ado_wiki_pages: [pages],
      ado_wiki_page: { $by: "path", values: { "/首頁": page("# 首頁\n\n歡迎", "v1"), "/規格": page("# 規格\n\n內容", "s1") } },
      // 來回切兩次（問四次版本）都沒變；之後有人改了「首頁」。
      ado_wiki_page_etag: [
        ...Array(4).fill({ $by: "path", values: { "/首頁": "v1", "/規格": "s1" } }),
        { $by: "path", values: { "/首頁": "v2", "/規格": "s1" } },
      ],
    },
  });
  await p.click("#side-tab-wiki");
  await p.click('#wiki-host .wiki-page[data-path="/首頁"]');
  await p.locator(".issue-body", { hasText: "歡迎" }).waitFor();
  await p.evaluate(() => (document.querySelector(".issue-body h1").__kept = true));
  await p.click('#wiki-host .wiki-page[data-path="/規格"]');
  await p.locator(".issue-body", { hasText: "內容" }).waitFor();
  const reads = async () => (await calls(p)).filter((c) => c.cmd === "ado_wiki_page" && c.args.path === "/首頁").length;
  const before = await reads();
  for (let i = 0; i < 2; i++) {
    await p.locator("#tab-bar [data-id]", { hasText: "首頁" }).click();
    await p.locator(".issue-body", { hasText: "歡迎" }).waitFor();
    await p.waitForTimeout(200);
    assert.equal(await p.evaluate(() => document.querySelector(".issue-body h1")?.__kept), true, "換上之前畫好的畫面");
    await p.locator("#tab-bar [data-id]", { hasText: "規格" }).click();
    await p.locator(".issue-body", { hasText: "內容" }).waitFor();
  }
  assert.equal(await reads(), before, "版本沒變：沒有再讀整頁");
  await p.locator("#tab-bar [data-id]", { hasText: "首頁" }).click();
  await p.waitForFunction((n) => window.__fake.calls.filter((c) => c.cmd === "ado_wiki_page" && c.args.path === "/首頁").length > n, before);
  assert.deepEqual(errors, []);
  await context.close();
});
