/**
 * 工作項目的篩選一直顯示在清單上面（沒有展開、收合的按鈕）：專案一整列（有條件時右邊是清掉全部的 ×）；
 * 人與區域（沒選專案時人佔一整列，輸入名字的框在這列下面）；類型與狀態；最後是搜尋框，右端的 ⌄ 開 TFS 的已儲存查詢，
 * 正在用查詢時搜尋框左邊是「查詢：名稱 ×」，篩選最上面有說明。用假的原生端（見 helpers.mjs）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const item = (id, title) => ({
  id,
  title,
  state: "Active",
  kind: "Task",
  project: "產品",
  assignedTo: "王小明",
  changed: "2026-11-01T00:00:00Z",
  priority: 2,
  webUrl: `https://ado.test/c/產品/_workitems/edit/${id}`,
});
const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_work_items: [[item(1, "登入頁面跑版"), item(2, "匯出加上頁碼")]],
  ado_work_item_filters: { projects: ["產品", "平台"], kinds: ["Task", "Bug"] },
  ado_work_item_scope: { areas: ["產品", "產品\\前端"], people: ["王小明", "陳大文"] },
  // 回應是陣列時會依序用掉（見 helpers.mjs），所以清單外面再包一層。
  ado_queries: [[
    { id: "q1", project: "產品", name: "本週要上線的項目", folder: "Shared Queries" },
    { id: "q2", project: "產品", name: "我的 Bug", folder: "My Queries" },
  ]],
  ado_query_run: [[item(3, "查詢找到的項目")]],
};

/** 篩選裡各個元素的位置（看得到的才算）。 */
const layout = (page) =>
  page.evaluate(() => {
    const bar = document.querySelector("#workitems-host .workitems-filters");
    const at = (sel) => {
      const el = bar.querySelector(sel);
      if (!el || !el.getClientRects().length) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, mid: (r.top + r.bottom) / 2 };
    };
    const b = bar.getBoundingClientRect();
    return {
      bar: { left: b.left, right: b.right, width: bar.clientWidth },
      first: [...bar.children].find((el) => el.getClientRects().length)?.className,
      project: at('.multi-select[aria-label^="專案："]'),
      clear: at(".workitems-filter-clear"),
      person: at('.multi-select[aria-label^="人："]'),
      area: at('.multi-select[aria-label^="區域："]'),
      name: at(".workitems-person"),
      kind: at('.multi-select[aria-label^="類型："]'),
      state: at('.multi-select[aria-label^="狀態："]'),
      box: at(".workitems-search-box"),
      search: at(".workitems-search-box .workitems-search"),
      pick: at(".workitems-search-box .workitems-query-pick"),
      chip: at(".workitems-search-box .workitems-query-chip"),
      note: at(".workitems-query-note"),
    };
  });

/** 在複選選單裡只選某一項。 */
async function pickOnly(page, label, value) {
  await page.locator(`#workitems-host .multi-select[aria-label^="${label}："]`).click();
  const row = page.locator(".multi-select-pop:popover-open .multi-select-item", { hasText: new RegExp(`^${value}`) });
  await row.hover();
  await row.locator(".multi-select-only").click();
  await page.keyboard.press("Escape");
}

test("篩選一直顯示：專案一整列（右邊是 ×）、人｜區域、類型｜狀態，最後是搜尋框（右端是 ⌄）", async () => {
  const { page, context, errors } = await open({ desktop });
  // 以前存的「篩選展開」不再有作用。
  await page.evaluate(() => localStorage.setItem("md-editor:workitem-filter-open", ""));
  await page.reload();
  await page.locator("#side-tab-workitems").click();
  await page.locator("#workitems-host .workitem-title", { hasText: "登入頁面跑版" }).waitFor();
  assert.equal(await page.locator("#workitems-host .workitems-filter-toggle, #workitems-host .workitems-filter-count").count(), 0, "沒有展開、收合篩選的按鈕");
  assert.ok(await page.locator("#workitem-filters").isVisible(), "篩選一直顯示");

  // 預設（沒選專案）：專案一整列、沒有 ×；人佔一整列、沒有區域。
  let look = await layout(page);
  assert.equal(look.first, "workitems-filter-top", "專案那一列是篩選的第一列");
  assert.equal(look.clear, null, "沒有條件時沒有 ×");
  assert.ok(Math.abs(look.project.width - look.bar.width) < 2, "專案佔一整列");
  assert.equal(look.area, null, "沒選專案時沒有區域");
  assert.ok(look.person.top > look.project.bottom - 1, "人在專案下面");
  assert.ok(Math.abs(look.person.width - look.bar.width) < 2, "沒有區域時人佔一整列");
  assert.ok(look.kind.top > look.person.bottom - 1, "類型在人的下一列");
  assert.ok(Math.abs(look.kind.top - look.state.top) < 2 && look.state.left > look.kind.right - 1, "狀態在類型右邊");
  assert.ok(look.box.top > look.kind.bottom - 1, "搜尋框在類型、狀態下面");
  assert.ok(Math.abs(look.box.width - look.bar.width) < 2, "搜尋框佔一整列");
  assert.ok(look.search.left >= look.box.left && look.search.right <= look.pick.left + 1, "輸入框在框裡、⌄ 的左邊");
  assert.ok(look.pick.right <= look.box.right && look.box.right - look.pick.right < 6, "⌄ 在搜尋框的右端");
  assert.equal(look.chip, null, "沒有用查詢時沒有查詢名稱");
  // 側邊欄預設的寬度（248px）放得下整句提示文字。
  const fits = await page.locator("#workitems-host .workitems-search").evaluate((input) => {
    const cs = getComputedStyle(input);
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
    const room = input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return { text: input.placeholder, need: ctx.measureText(input.placeholder).width, room };
  });
  assert.equal(fits.text, "搜尋標題、內容或 #編號");
  assert.ok(fits.need <= fits.room, `提示文字放得下（需要 ${fits.need}，有 ${fits.room}）`);

  // 選了專案：專案右邊出現 ×，區域在人的右邊。
  await pickOnly(page, "專案", "產品");
  await page.locator('#workitems-host .multi-select[aria-label^="區域："]:not([hidden])').waitFor();
  look = await layout(page);
  assert.ok(look.clear, "有條件時專案右邊有 ×");
  assert.ok(look.clear.left >= look.project.right - 1 && Math.abs(look.clear.mid - look.project.mid) < 2, "× 和專案同一列、在右邊");
  assert.ok(look.bar.right - look.clear.right < 2, "× 在這一列的右端");
  assert.ok(Math.abs(look.area.top - look.person.top) < 2 && look.area.left > look.person.right - 1, "區域在人的右邊");
  assert.ok(look.kind.top > look.person.bottom - 1, "類型、狀態在人、區域下面");

  // 「指派給…」：輸入名字的框在人、區域那一列下面，類型、狀態上面。
  await page.locator('#workitems-host .multi-select[aria-label^="人："]').click();
  await page.locator(".multi-select-pop:popover-open .multi-select-item", { hasText: /^指派給…/ }).click();
  await page.locator("#workitems-host .workitems-person:not([hidden])").waitFor();
  look = await layout(page);
  assert.ok(look.name.top > look.person.bottom - 1 && look.name.bottom < look.kind.top + 1, "名字的框在人、區域下面，類型、狀態上面");

  // 按 ×：回到預設，× 與區域都不見。
  await page.locator("#workitems-host .workitems-filter-clear").click();
  await page.locator('#workitems-host .multi-select[aria-label^="區域："]').waitFor({ state: "hidden" });
  look = await layout(page);
  assert.equal(look.clear, null, "清掉後 × 不見");
  assert.equal(look.name, null, "清掉後名字的框不見");
  assert.ok(Math.abs(look.person.width - look.bar.width) < 2, "人又佔一整列");
  assert.deepEqual(errors, []);
  await context.close();
});

test("搜尋框右端的 ⌄ 開已儲存的查詢；選了查詢顯示「查詢：名稱 ×」與說明，按 × 回到篩選條件", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.locator("#side-tab-workitems").click();
  await page.locator("#workitems-host .workitem-title", { hasText: "登入頁面跑版" }).waitFor();
  const pick = page.locator("#workitems-host .workitems-search-box .workitems-query-pick");
  assert.equal(await pick.getAttribute("aria-label"), "已儲存的查詢");
  assert.equal(await pick.getAttribute("title"), "已儲存的查詢");

  // ⌄ 開 TFS 的已儲存查詢。
  await pick.click();
  const dialog = page.locator('dialog[open][aria-label="TFS 的已儲存查詢"]');
  await dialog.waitFor();
  await dialog.locator("li", { hasText: "我的 Bug" }).waitFor();
  await dialog.locator("li", { hasText: "本週要上線的項目" }).click();

  // 選了查詢：搜尋框左邊是查詢名稱，篩選最上面是說明，清單是查詢的結果。
  const chip = page.locator("#workitems-host .workitems-search-box .workitems-query-chip");
  await chip.waitFor();
  assert.equal((await chip.textContent()).trim(), "查詢：本週要上線的項目");
  await page.locator("#workitems-host .workitem-title", { hasText: "查詢找到的項目" }).waitFor();
  assert.match(await page.textContent("#workitems-host .workitems-status"), /1 個結果：查詢「本週要上線的項目」/);
  const look = await layout(page);
  assert.equal(look.first, "workitems-query-note", "說明在篩選的最上面");
  assert.ok(look.note.bottom <= look.project.top + 1, "說明在專案上面");
  assert.ok(look.chip.left >= look.box.left && look.chip.right <= look.search.left + 1, "查詢名稱在輸入框左邊");
  assert.ok(Math.abs(look.chip.mid - look.box.mid) < 2, "查詢名稱在搜尋框那一列");
  assert.match(await page.textContent("#workitems-host .workitems-query-note"), /目前列出查詢「本週要上線的項目」的結果，下面的篩選條件暫時不套用。/);
  assert.ok(look.clear, "用查詢時專案右邊也有 ×（一次清掉）");
  const ran = await page.evaluate(() => window.__fake.calls.filter((c) => c.cmd === "ado_query_run").map((c) => c.args.id));
  assert.deepEqual(ran, ["q1"]);

  // 按查詢名稱旁的 ×：不用查詢，回到篩選條件；游標回到搜尋框。
  await chip.locator(".workitems-query-cancel").click();
  await chip.waitFor({ state: "hidden" });
  assert.ok(await page.locator("#workitems-host .workitems-query-note").isHidden(), "說明不見");
  assert.ok(await page.locator("#workitems-host .workitems-filter-clear").isHidden(), "沒有條件了，× 也不見");
  // 清單回到篩選條件的結果（剛讀過的不用再向伺服器讀）。
  await page.locator("#workitems-host .workitem-title", { hasText: "登入頁面跑版" }).waitFor();
  assert.match(await page.textContent("#workitems-host .workitems-status"), /2 個指派給你、還沒結束的工作項目/);
  assert.equal(await page.evaluate(() => localStorage.getItem("md-editor:workitem-query")), null, "不再記住查詢");
  assert.ok(await page.locator("#workitems-host .workitems-search").evaluate((el) => el === document.activeElement), "游標回到搜尋框");
  assert.deepEqual(errors, []);
  await context.close();
});
