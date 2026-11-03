/**
 * 工作項目清單選好幾個一起改：Ctrl＋點一下加選、Shift＋點一下選一段，或按「選取」進入選取模式；
 * 「一起改…」只列選的類型都有的狀態，一個一個送出，最後說改好幾個、哪幾個沒改成。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const item = (id, title, kind, state, priority = 2) => ({
  id,
  title,
  kind,
  state,
  project: "產品",
  assignedTo: "王小明",
  changed: "2026-11-01T00:00:00Z",
  priority,
  webUrl: `https://ado.test/c/產品/_workitems/edit/${id}`,
});
const ITEMS = [item(11, "寫測試", "Task", "Active"), item(12, "整理文件", "Task", "New"), item(13, "登入失敗", "Bug", "Active", 1)];
const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_work_items: [ITEMS],
  ado_work_item_states: { $by: "kind", values: { Task: ["New", "Active", "Closed"], Bug: ["New", "Active", "Resolved", "Closed"] } },
  ado_iterations: [[{ path: "產品\\Sprint 1", start: "2026-10-26T00:00:00Z", finish: "2099-11-06T00:00:00Z" }]],
};

async function openList(page) {
  await page.locator("#side-tab-workitems").click();
  await page.locator('#workitems-host .workitem[data-id="13"]').waitFor();
}
const row = (page, id) => page.locator(`#workitems-host .workitem[data-id="${id}"]`);

test("一起改：Ctrl、Shift 選一段，只列共同的狀態，一個一個送出，說哪幾個沒改成", async () => {
  const { page, context, errors } = await open({
    desktop: { ...desktop, ado_work_item_update: [null, { $error: "被別人改過了" }, null] },
  });
  await openList(page);
  await row(page, 11).click({ modifiers: ["Control"] });
  await row(page, 13).click({ modifiers: ["Shift"] });
  const bar = page.locator("#workitems-host .workitems-bulk");
  assert.match(await bar.textContent(), /已選 3 項/);
  assert.equal(await page.locator("#workitems-host .workitem.selected").count(), 3);
  // 選取時不會開啟工作項目。
  assert.equal((await calls(page)).filter((c) => c.cmd === "ado_work_item").length, 0);

  await bar.locator("button", { hasText: "一起改…" }).click();
  const dialog = page.locator("dialog.wi-bulk[open]");
  await dialog.locator("h2", { hasText: "一起修改 3 個工作項目" }).waitFor();
  const state = dialog.locator("select").nth(0);
  await page.waitForFunction(() => document.querySelector("dialog.wi-bulk select").options.length > 1);
  assert.deepEqual(await state.locator("option").allTextContents(), ["（不變）", "New", "Active", "Closed"]);
  await state.selectOption("Closed");
  await dialog.locator("select").nth(1).selectOption("me");
  await dialog.locator("textarea").fill("已完成");
  await dialog.locator("button", { hasText: "套用" }).click();
  await page.locator(".toast", { hasText: "改好 2 個，1 個沒改成" }).waitFor();
  assert.match(await page.locator(".toast", { hasText: "改好 2 個" }).textContent(), /12：被別人改過了/);
  const sent = (await calls(page)).filter((c) => c.cmd === "ado_work_item_update").map((c) => c.args);
  assert.deepEqual(
    sent.map((s) => s.id),
    [11, 12, 13],
  );
  for (const s of sent) {
    assert.equal(s.change.state, "Closed");
    assert.equal(s.change.assignToMe, true);
    assert.match(s.change.comment, /<p>已完成<\/p>/);
    assert.equal(s.change.rev, null, "清單上沒有修訂版本，不帶");
  }
  // 改完取消選取、重新讀清單。
  assert.equal(await page.locator("#workitems-host .workitem.selected").count(), 0);
  assert.equal(await bar.isHidden(), true);
  assert.ok((await calls(page)).filter((c) => c.cmd === "ado_work_items").length >= 2);
  assert.deepEqual(errors, []);
  await context.close();
});

test("一起改：「選取」模式點一下就是選取；狀態和現在一樣的不送；沒選要改什麼時提醒；Esc 取消選取", async () => {
  const { page, context, errors } = await open({ desktop });
  await openList(page);
  await page.locator("#workitems-host .workitems-pick").click();
  const bar = page.locator("#workitems-host .workitems-bulk");
  assert.match(await bar.textContent(), /點項目選取/);
  await row(page, 11).click();
  await row(page, 13).click();
  assert.match(await bar.textContent(), /已選 2 項/);
  await bar.locator("button", { hasText: "一起改…" }).click();
  const dialog = page.locator("dialog.wi-bulk[open]");
  await page.waitForFunction(() => document.querySelector("dialog.wi-bulk select").options.length > 1);
  // 沒選要改什麼。
  await dialog.locator("button", { hasText: "套用" }).click();
  assert.match(await dialog.locator(".wi-create-error").textContent(), /沒有選要改什麼/);
  // Sprint：同一個專案可以改；狀態改成 Active（兩個都已經是 Active）、優先順序改成 1（13 已經是 1）。
  await dialog.locator("select").nth(0).selectOption("Active");
  await dialog.locator("select").nth(2).selectOption("1");
  await dialog.locator("select").nth(3).selectOption("產品\\Sprint 1");
  await dialog.locator("button", { hasText: "套用" }).click();
  await page.locator(".toast", { hasText: "已修改 2 個工作項目" }).waitFor();
  const sent = (await calls(page)).filter((c) => c.cmd === "ado_work_item_update").map((c) => c.args);
  assert.deepEqual(sent, [
    { id: 11, change: { priority: 1, iteration: "產品\\Sprint 1", rev: null } },
    { id: 13, change: { iteration: "產品\\Sprint 1", rev: null } },
  ]);
  // 再選一次，Esc 取消選取；之後點一下照常開啟。
  await row(page, 12).click({ modifiers: ["Control"] });
  assert.match(await bar.textContent(), /已選 1 項/);
  await row(page, 12).focus();
  await page.keyboard.press("Escape");
  assert.equal(await bar.isHidden(), true);
  await row(page, 12).click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_work_item"));
  assert.deepEqual(errors, []);
  await context.close();
});
