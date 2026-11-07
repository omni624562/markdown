/**
 * 篩選的多選選單不會「一個都沒勾」：都沒勾和全部勾著意思一樣，畫面卻相反，容易誤會。
 * 取消「全部」時維持全部勾著並說明怎麼只看一項；最後一個勾著的取消不了。用假的原生端（見 helpers.mjs）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const item = (id, kind) => ({
  id,
  title: `工作 ${id}`,
  state: "Active",
  kind,
  project: "產品",
  assignedTo: "王小明",
  changed: "2026-11-01T00:00:00Z",
  priority: 2,
  webUrl: `https://ado.test/c/產品/_workitems/edit/${id}`,
});
const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_work_items: [[item(1, "Task"), item(2, "Bug")]],
  ado_work_item_filters: { projects: ["產品"], kinds: ["Bug", "Task", "User Story"], stateSets: [] },
  ado_work_item_scope: { areas: [], people: [] },
};

const checked = (pop) => pop.locator(".multi-select-list input").evaluateAll((ls) => ls.map((l) => l.checked));

test("多選篩選：取消「全部」還是全部勾著，最後一項取消不了，底下說明怎麼做", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.click("#side-tab-workitems");
  await page.locator("#workitems-host .workitem-title", { hasText: "工作 1" }).waitFor();
  await page.locator('#workitems-host .multi-select[aria-label^="類型："]').click();
  const pop = page.locator(".multi-select-pop:popover-open");
  const foot = pop.locator(".multi-select-foot");
  assert.deepEqual(await checked(pop), [true, true, true]);

  // 取消「全部」：還是全部勾著，提示改用「只選這個」。
  await pop.locator(".multi-select-all input").click();
  assert.deepEqual(await checked(pop), [true, true, true]);
  assert.equal(await pop.locator(".multi-select-all input").isChecked(), true);
  assert.match(await foot.textContent(), /已經是全部；要只看某一項，按那一項右邊的「只選這個」/);

  // 只選 Bug，再取消 Bug：取消不了。
  const bug = pop.locator(".multi-select-list .multi-select-item", { hasText: "Bug" });
  await bug.hover();
  await bug.locator(".multi-select-only").click();
  assert.deepEqual(await checked(pop), [true, false, false]);
  await bug.locator("input").click();
  assert.deepEqual(await checked(pop), [true, false, false]);
  assert.match(await foot.textContent(), /至少要勾一項；要看全部請勾「全部」/);
  assert.doesNotMatch(await foot.textContent(), /都沒勾/);

  // 勾「全部」回到全部。
  await pop.locator(".multi-select-all input").click();
  assert.deepEqual(await checked(pop), [true, true, true]);
  assert.match(await foot.textContent(), /全部/);
  assert.deepEqual(errors, []);
  await context.close();
});
