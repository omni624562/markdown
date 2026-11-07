/**
 * 工作項目的關聯：「相關工作項目」段落的「加入關聯」設定上層、加子項目；每個關聯後面的移除鈕拿掉關聯
 * （用假的原生端，見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";
import { Unlink } from "lucide";

const base = { project: "產品", assignedTo: "王小明", changed: "2026-10-30T00:00:00Z", priority: 2 };
const item = (id, title, kind = "Task", state = "Active") => ({ ...base, id, title, kind, state, webUrl: `https://ado.test/c/產品/_workitems/edit/${id}` });
const STORY = item(10, "整理文件", "User Story");
const CHILD = item(7, "子工作");
const DETAIL = {
  ...item(42, "修正登入"),
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

async function openItem(page) {
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill("#42");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ado-hero");
}

const updates = async (page) => (await calls(page)).filter((c) => c.cmd === "ado_work_item_update").map((c) => c.args);

test("加入關聯：沒有關聯時也有段落，選「上層」再找工作項目，送出上層與修訂版本", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_work_item: DETAIL,
      // 搜尋結果裡有自己：不列出來（不能連到自己）。
      ado_work_items: [[DETAIL, STORY]],
    },
  });
  await openItem(page);
  const sec = page.locator('.ado-sec[data-kind="relations"]');
  await sec.locator(".ado-sec-empty").waitFor();
  await sec.locator("#wi-add-link").click();
  assert.equal(await sec.getAttribute("open"), "", "按鈕在段落標題列：按了不會收合段落");
  const menu = page.locator("#wi-add-link-popover");
  assert.deepEqual(
    (await menu.locator("button").allTextContents()).map((s) => s.trim()),
    ["上層…", "子項目…", "相關…", "前置項目…", "後續項目…"],
  );
  await menu.locator("button", { hasText: "上層…" }).click();
  const input = page.locator("dialog.palette[open] input");
  assert.equal(await input.getAttribute("placeholder"), "上層項目：輸入標題關鍵字或編號");
  await input.fill("整理");
  const options = page.locator("dialog.palette[open] [role=option]");
  await options.first().waitFor();
  assert.deepEqual(await options.allTextContents().then((l) => l.map((s) => s.includes("整理文件"))), [true]);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_work_item_update"));
  const [sent] = await updates(page);
  assert.equal(sent.id, 42);
  assert.deepEqual(sent.change, { parent: 10, rev: 3 });
  await page.locator(".toast", { hasText: "已把上層設成 User Story 10" }).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test("加入關聯：已經有上層時是「換上層」；加子項目送 linksAdd；移除關聯先問過", async () => {
  const detail = {
    ...DETAIL,
    relations: [
      { ...STORY, link: "parent", linkName: "Parent" },
      { ...CHILD, link: "child", linkName: "Child" },
    ],
  };
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_work_item: detail,
      ado_work_items_by_ids: [[STORY, CHILD]],
      // 已經是子項目的（7）不列出來。
      ado_work_items: [[CHILD, item(8, "新的子工作")]],
    },
  });
  await openItem(page);
  const sec = page.locator('.ado-sec[data-kind="relations"]');
  await sec.locator("li", { hasText: "子工作" }).first().waitFor();
  await sec.locator("#wi-add-link").click();
  const menu = page.locator("#wi-add-link-popover");
  assert.match(await menu.locator("button").first().textContent(), /換上層…/);
  await menu.locator("button", { hasText: "子項目…" }).click();
  await page.locator("dialog.palette[open] input").fill("子工作");
  const options = page.locator("dialog.palette[open] [role=option]");
  await options.first().waitFor();
  assert.equal(await options.count(), 1);
  assert.match(await options.first().textContent(), /新的子工作/);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_work_item_update"));
  assert.deepEqual((await updates(page))[0].change, { linksAdd: [{ kind: "child", id: 8 }], rev: 3 });

  // 移除子項目的關聯：先問，取消不送出；確定才送出。
  const row = sec.locator("li", { hasText: "Task 7" });
  await row.hover();
  // 圖示是斷開的鏈結（不是 ✕），說明寫清楚工作項目本身不會刪除。
  assert.equal(await row.locator(".ado-link-remove").getAttribute("title"), "移除關聯（工作項目本身不會刪除）");
  const firstPath = await row.locator(".ado-link-remove svg > *").first().getAttribute("d");
  assert.equal(firstPath, Unlink.find(([tag]) => tag === "path")[1].d);
  await row.locator(".ado-link-remove").click();
  await page.locator("dialog.choice[open] button", { hasText: "取消" }).click();
  assert.equal((await updates(page)).length, 1);
  await row.hover();
  await row.locator(".ado-link-remove").click();
  await page.locator("dialog.choice[open] button", { hasText: "移除" }).click();
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "ado_work_item_update").length === 2);
  assert.deepEqual((await updates(page))[1].change, { linksRemove: [{ kind: "child", id: 7 }], rev: 3 });
  // 上層那一組也有移除鈕，送出的是上層的關聯。
  assert.equal(await sec.locator("li", { hasText: "User Story 10" }).locator(".ado-link-remove").count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
});
