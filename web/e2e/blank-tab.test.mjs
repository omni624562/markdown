/**
 * 只剩一份空白文件、還開著工作項目時：不會留下關不掉的「未命名」分頁。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const ITEM = {
  id: 42,
  title: "修正登入",
  state: "Active",
  kind: "Task",
  project: "產品",
  assignedTo: "王小明",
  changed: "2026-10-30T00:00:00Z",
  priority: 2,
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
const desktop = { ado_account: { url: "https://ado.test/c", name: "王小明" }, ado_work_item: ITEM };

/** 看得到的分頁名稱。 */
const tabs = (page) =>
  page.$$eval("#tab-bar .tab", (list) => list.filter((t) => getComputedStyle(t).display !== "none" && getComputedStyle(t).visibility !== "hidden").map((t) => t.textContent.trim()));

async function openItem(page) {
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill("#42");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ado-hero h1");
}

test("沒有開文件時打開工作項目：只看得到工作項目的分頁", async () => {
  const { page, context, errors } = await open({ desktop });
  await openItem(page);
  assert.deepEqual(await tabs(page), ["42 修正登入"]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("關掉最後一份有內容的文件：換到工作項目，不留下空白的「未命名」", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.keyboard.press("Control+N");
  await page.waitForSelector(".cm-content");
  await page.locator(".cm-content").click();
  await page.keyboard.type("內容");
  await openItem(page);
  // 回到文件（分頁用第一行命名），清空後關掉（清空了就不會問要不要存檔）。
  await page.locator("#tab-bar .tab", { hasText: "內容" }).click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  // 清空之後分頁名稱換回「未命名」（畫面更新後才換）。
  await page.waitForFunction(() => [...document.querySelectorAll("#tab-bar .tab-name")].some((n) => n.textContent === "未命名"));
  while ((await tabs(page)).some((n) => n.startsWith("未命名"))) {
    await page.keyboard.press("Control+W");
    await page.waitForTimeout(100);
  }
  assert.deepEqual(await tabs(page), ["42 修正登入"]);
  assert.ok(await page.locator(".ado-hero h1").isVisible(), "顯示工作項目");
  assert.deepEqual(errors, []);
  await context.close();
});

test("文件都關掉後再按新增文件：只會有一個「未命名」", async () => {
  const { page, context, errors } = await open({ desktop });
  await openItem(page);
  await page.keyboard.press("Control+N");
  await page.waitForSelector(".cm-content");
  assert.deepEqual((await tabs(page)).sort(), ["42 修正登入", "未命名"]);
  await page.locator(".cm-content").click();
  await page.keyboard.type("內容");
  // 打了字的文件用第一行命名：沒有留下另一個空白的「未命名」。
  await page.waitForFunction(() => [...document.querySelectorAll("#tab-bar .tab-name")].some((n) => n.textContent === "內容"));
  assert.deepEqual((await tabs(page)).sort(), ["42 修正登入", "內容"]);
  assert.deepEqual(errors, []);
  await context.close();
});
