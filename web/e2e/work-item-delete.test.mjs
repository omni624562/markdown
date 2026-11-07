/**
 * 刪除工作項目：分頁的右鍵選單最後一項「刪除工作項目…」（紅字），或指令面板。
 * 確認對話框寫出類型、編號、標題，有子項目時提醒不會一起刪除，焦點在「取消」；刪除後關掉分頁、
 * 提示可以在網頁版的回收筒還原（「打開回收筒」用瀏覽器開）。沒有權限時顯示原因，分頁留著。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const base = (id, title, kind = "Task") => ({
  id,
  title,
  state: "Active",
  kind,
  project: "產品",
  assignedTo: "王小明",
  changed: "2026-11-01T00:00:00Z",
  priority: 2,
  webUrl: `https://ado.test/tfs/DefaultCollection/產品/_workitems/edit/${id}`,
});
const ITEM = {
  ...base(1001, "畫面切版"),
  createdBy: "王小明",
  area: "產品",
  iteration: "產品",
  tags: [],
  description: "<p>說明</p>",
  details: null,
  rev: 3,
  relations: [
    { ...base(10, "查詢條件", "User Story"), link: "parent" },
    { ...base(1002, "畫面切版（手機）"), state: "New", link: "child" },
  ],
  attachments: [],
  comments: [],
};
const DESKTOP = { ado_account: { url: "https://ado.test/tfs/DefaultCollection", name: "王小明" }, ado_work_item: ITEM, ado_work_item_delete: null };

async function openItem(desktop = DESKTOP) {
  const opened = await open({ desktop });
  const { page } = opened;
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill("#1001");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
  await page.locator(".issue-pane .issue-body", { hasText: "說明" }).waitFor();
  return opened;
}
const tab = (page) => page.locator("#tab-bar .tab", { hasText: "畫面切版" });
const deletes = async (page) => (await calls(page)).filter((c) => c.cmd === "ado_work_item_delete").map((c) => c.args);

async function menuDelete(page) {
  await tab(page).click({ button: "right" });
  const item = page.locator("#tab-menu-anchor-popover").getByRole("menuitem", { name: "刪除工作項目…" });
  await item.waitFor();
  return item;
}

test("右鍵選單「刪除工作項目…」：確認後刪除（進回收筒），關掉分頁，可以打開回收筒", async () => {
  const { page, context, errors } = await openItem();
  let item = await menuDelete(page);
  // 紅字，排在選單最後一項（工作項目的動作之後）。
  assert.equal(await item.evaluate((el) => el.classList.contains("menu-danger")), true);
  await item.click();
  const dialog = page.locator("dialog[open]", { hasText: "刪除 Task 1001「畫面切版」？" });
  await dialog.waitFor();
  const text = await dialog.textContent();
  assert.match(text, /底下有 1 個子項目（Task 1002），不會一起刪除，刪除後它會變成沒有上層。/);
  assert.match(text, /可以在網頁版的回收筒還原/);
  // 焦點在「取消」：直接按 Enter 不會刪除。
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "取消");
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(await deletes(page), []);
  assert.equal(await tab(page).count(), 1);

  item = await menuDelete(page);
  await item.click();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "刪除" }).click();
  const toast = page.locator(".toast", { hasText: "已刪除 Task 1001「畫面切版」，可以在網頁版的回收筒還原" });
  await toast.waitFor();
  assert.deepEqual(await deletes(page), [{ id: 1001 }]);
  await tab(page).waitFor({ state: "detached" });
  await toast.getByRole("button", { name: "打開回收筒" }).click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "open_external"));
  const opened = (await calls(page)).find((c) => c.cmd === "open_external").args.url;
  assert.equal(opened, "https://ado.test/tfs/DefaultCollection/產品/_workitems/recyclebin");
  assert.deepEqual(errors, []);
  await context.close();
});

test("沒有刪除權限：顯示原因，分頁留著", async () => {
  const reason = "你沒有刪除這個工作項目的權限（需要「刪除和還原工作項目」權限，請找專案管理員）";
  const { page, context, errors } = await openItem({ ...DESKTOP, ado_work_item_delete: { $error: reason } });
  await (await menuDelete(page)).click();
  const dialog = page.locator("dialog[open]", { hasText: "刪除 Task 1001「畫面切版」？" });
  await dialog.getByRole("button", { name: "刪除" }).click();
  await page.locator(".toast", { hasText: reason }).waitFor();
  assert.equal(await tab(page).count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test("指令面板「工作項目：刪除目前的工作項目…」：顯示工作項目時才有", async () => {
  const { page, context, errors } = await openItem();
  // 工作項目開著時編輯區是隱藏的：直接用快速鍵開指令面板。
  await page.keyboard.press("Control+Shift+P");
  const input = page.locator("dialog[open] input").first();
  await input.fill("刪除目前的工作項目");
  await page.locator("dialog[open] [role=option]", { hasText: "工作項目：刪除目前的工作項目…" }).first().click();
  const dialog = page.locator("dialog[open]", { hasText: "刪除 Task 1001「畫面切版」？" });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "取消" }).click();
  assert.deepEqual(await deletes(page), []);
  // 換到一般文件：指令面板裡沒有這個指令。
  await page.keyboard.press("Control+N");
  await page.locator(".cm-content").waitFor();
  await page.keyboard.press("Control+Shift+P");
  await page.locator("dialog[open] input").first().fill("刪除目前的工作項目");
  await page.waitForTimeout(200);
  assert.equal(await page.locator("dialog[open] [role=option]", { hasText: "工作項目：刪除目前的工作項目…" }).count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
