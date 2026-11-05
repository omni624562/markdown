/**
 * 工作項目在文件右邊並排時，右半邊被工作項目佔住：
 * 按「預覽」在左半邊顯示預覽，按「分割」當成即時預覽；關掉工作項目後回到一般的分割檢視。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, setText } from "./helpers.mjs";

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

const shown = (page, selector) => page.locator(selector).first().isVisible();
const box = (page, selector) => page.locator(selector).first().boundingBox();
const view = (page, name) => page.locator(`.view-switch [data-view="${name}"]`);

test("工作項目並排時：「預覽」在左半邊顯示預覽，「分割」當成即時預覽", async () => {
  const { page, context, errors } = await open({ desktop: { ado_account: { url: "https://ado.test/c", name: "王小明" }, ado_work_item: ITEM } });
  await page.keyboard.press("Control+N");
  await setText(page, "# 週報\n\n本週完成登入頁。");
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill("#42");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ado-hero h1");
  await page.locator("#tab-bar .tab", { hasText: "修正登入" }).click({ button: "right" });
  await page.locator("#tab-menu-anchor-popover button", { hasText: "在文件右邊並排顯示" }).click();
  await page.waitForSelector(".workspace.issue-side");

  // 預覽：編輯區藏起來，預覽放在左半邊，工作項目還在右邊。
  await view(page, "preview").click();
  assert.equal(await shown(page, ".editor-pane"), false, "編輯區藏起來");
  assert.equal(await shown(page, ".preview-pane"), true, "看得到預覽");
  assert.equal(await shown(page, ".issue-pane"), true, "工作項目還在");
  assert.ok((await box(page, ".preview-pane")).x < (await box(page, ".issue-pane")).x, "預覽在工作項目左邊");
  await page.waitForFunction(() => document.querySelector("#preview h1")?.textContent === "週報");
  assert.equal(await view(page, "preview").getAttribute("aria-checked"), "true");

  // 分割：左邊是即時預覽的編輯區（不是原始碼），預覽藏起來。
  await view(page, "split").click();
  assert.equal(await shown(page, ".editor-pane"), true);
  assert.equal(await shown(page, ".preview-pane"), false);
  assert.equal(await page.locator(".workspace.live").count(), 1, "左邊是即時預覽");
  assert.equal(await view(page, "split").getAttribute("aria-checked"), "true", "按下去的「分割」標成選取");

  // 並排時改了內容，關掉工作項目後：回到一般的分割，預覽是新的內容。
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n\n下週處理登出。");
  const itemTab = page.locator("#tab-bar .tab", { hasText: "修正登入" });
  await itemTab.hover();
  await itemTab.locator(".tab-close").click();
  await page.waitForSelector(".workspace:not(.issue-open)");
  assert.equal(await page.locator(".workspace.live").count(), 0);
  assert.equal(await shown(page, ".editor-pane"), true);
  assert.equal(await shown(page, ".preview-pane"), true);
  assert.ok((await box(page, ".editor-pane")).x < (await box(page, ".preview-pane")).x, "預覽回到右邊");
  await page.waitForFunction(() => document.querySelector("#preview")?.textContent.includes("下週處理登出。"));
  assert.deepEqual(errors, []);
  await context.close();
});
