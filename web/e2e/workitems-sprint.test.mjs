/**
 * 工作項目的 Sprint 篩選（app/work-items-panel.ts）：只選一個專案時，專案下面多一列 Sprint，預設是自己所屬團隊
 * 目前的 Sprint（伺服器判斷；不屬於任何團隊時用專案的預設團隊）；可以多選，含「沒有排進 Sprint」；選了別的只在這次有效，重開回到本週；
 * 沒選或選了好幾個專案時不顯示、不篩選。用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const item = (id, title) => ({ id, title, state: "Active", kind: "Task", project: "產品", assignedTo: "王小明", changed: "2026-11-14T00:00:00Z", priority: 2, webUrl: `https://ado.test/c/產品/_workitems/edit/${id}` });
const sprint = (n, start, finish, current = false) => ({ id: `it-${n}`, name: `Sprint ${n}`, path: `產品\\Sprint ${n}`, start, finish, current });
const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_work_items: [[item(1201, "登入頁面在窄螢幕跑版"), item(1198, "匯出 PDF 加上頁碼")]],
  ado_work_item_filters: { projects: ["產品", "平台", "內部工具"], kinds: ["Task", "Bug"] },
  ado_work_item_scope: { areas: ["產品", "產品\\前端"], people: ["王小明", "李大同"] },
  ado_teams: {
    $by: "project",
    values: {
      產品: [
        { id: "team-1", name: "產品團隊", default: true, mine: false },
        { id: "team-2", name: "前端小組", default: false, mine: true },
      ],
    },
  },
  // 慢一點回應：先看得到「讀取中」。
  ado_team_iterations: {
    $delay: 300,
    value: [
      sprint(41, "2026-09-29T00:00:00Z", "2026-10-05T00:00:00Z"),
      sprint(42, "2026-10-06T00:00:00Z", "2026-10-12T00:00:00Z"),
      sprint(43, "2026-10-13T00:00:00Z", "2026-10-19T00:00:00Z"),
      sprint(44, "2026-10-20T00:00:00Z", "2026-10-26T00:00:00Z"),
      sprint(45, "2026-10-27T00:00:00Z", "2026-11-02T00:00:00Z"),
      sprint(46, "2026-11-03T00:00:00Z", "2026-11-09T00:00:00Z"),
      sprint(47, "2026-11-10T00:00:00Z", "2026-11-23T00:00:00Z", true),
      sprint(48, "2026-11-24T00:00:00Z", "2026-12-07T00:00:00Z"),
    ],
  },
};
const lists = async (page) => (await calls(page)).filter((c) => c.cmd === "ado_work_items").map((c) => c.args.filter);
const sprintButton = (page) => page.locator('#workitems-host .multi-select[aria-label^="Sprint："]');

async function pick(page, label, values) {
  await page.locator(`#workitems-host .multi-select[aria-label^="${label}："]`).click();
  const pop = page.locator(".multi-select-pop:popover-open");
  await pop.waitFor();
  for (const v of values) {
    const row = pop.locator(".multi-select-item", { hasText: v });
    await row.locator("input").click();
  }
  await page.keyboard.press("Escape");
}

async function onlyProject(page, name) {
  await page.locator('#workitems-host .multi-select[aria-label^="專案："]').click();
  const row = page.locator(".multi-select-pop:popover-open .multi-select-item", { hasText: new RegExp(`^${name}`) });
  await row.hover();
  await row.locator(".multi-select-only").click();
  await page.keyboard.press("Escape");
}

async function openList(page) {
  // 重開之後工作項目面板可能還開著（記得上次的面板）：已經開著就不要再按（再按一次會關上）。
  await page.locator("#side-tab-workitems").waitFor();
  await page.waitForTimeout(300);
  if (!(await page.locator("#workitems-host .workitem-title").first().isVisible())) await page.locator("#side-tab-workitems").click();
  await page.locator("#workitems-host .workitem-title").first().waitFor();
}

test("只選一個專案時出現 Sprint：先顯示讀取中，預設本週；可以多選（含沒有排進 Sprint）；重開回到本週", async () => {
  const { page, context, errors } = await open({ desktop });
  await openList(page);
  assert.equal(await sprintButton(page).isVisible(), false, "沒選專案：沒有 Sprint");
  await onlyProject(page, "產品");
  await sprintButton(page).waitFor();
  // 讀到之前：按鈕先寫讀取中（不是空白）。
  await page.waitForFunction(() => /Sprint 讀取中/.test(document.querySelector('#workitems-host .multi-select[aria-label^="Sprint："]')?.textContent ?? ""));
  await page.waitForFunction(() => /Sprint 47（本週/.test(document.querySelector('#workitems-host .multi-select[aria-label^="Sprint："]')?.textContent ?? ""));
  // 位置：在專案下面、人的上面，佔一整列。
  const box = await page.evaluate(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const bar = r("#workitems-host .workitems-filters");
    return { sprint: r('#workitems-host .multi-select[aria-label^="Sprint："]'), project: r(".workitems-filter-top"), person: r('#workitems-host .multi-select[aria-label^="人："]'), bar };
  });
  assert.ok(box.sprint.top >= box.project.bottom && box.sprint.bottom <= box.person.top, JSON.stringify(box));
  assert.ok(box.sprint.width > box.bar.width * 0.9, "一整列");
  // 預設的本週 Sprint 不算改過：按鈕不用強調色。
  assert.equal(await sprintButton(page).evaluate((el) => el.classList.contains("chosen")), false);
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "ado_work_items").some((c) => c.args.filter.iterations?.length));
  assert.deepEqual((await lists(page)).at(-1).iterations, ["產品\\Sprint 47"]);
  const asked = (await calls(page)).find((c) => c.cmd === "ado_team_iterations").args;
  assert.deepEqual(asked, { project: "產品", team: "team-2" }, "用自己所屬的團隊，不是專案的預設團隊");

  // 選單：上面標出是哪個團隊的 Sprint；新的在上面，最後是沒有排進 Sprint。
  await sprintButton(page).click();
  assert.equal(await page.locator(".multi-select-pop:popover-open .multi-select-caption").textContent(), "前端小組 的 Sprint");
  // 分「目前與之後」「已結束」兩組；名稱旁邊標本週、下一個，日期靠右；本週那一列底色標出；沒有滑鼠提示。
  const pop = page.locator(".multi-select-pop:popover-open");
  const visibleRows = () =>
    pop.locator(".multi-select-list").evaluate((list) =>
      [...list.children]
        .filter((el) => el.getClientRects().length)
        .map((el) =>
          el.classList.contains("multi-select-item")
            ? [el.querySelector(".multi-select-name")?.textContent ?? el.textContent, el.querySelector(".multi-select-aside")?.textContent ?? ""].join(" | ")
            : `[${el.textContent}]`,
        ),
    );
  assert.deepEqual(await visibleRows(), [
    "[目前與之後]",
    "Sprint 48下一個 | 11/24 – 12/7",
    "Sprint 47本週 | 11/10 – 11/23",
    "[已結束6]",
    "Sprint 46 | 11/3 – 11/9",
    "Sprint 45 | 10/27 – 11/2",
    "Sprint 44 | 10/20 – 10/26",
    "[顯示更早的 3 個]",
    "沒有排進 Sprint（Backlog）只選這個 | ",
  ]);
  assert.equal(await pop.locator(".multi-select-item.current .multi-select-name").textContent(), "Sprint 47本週");
  assert.equal(await pop.locator(".multi-select-item.rich[title]").count(), 0, "沒有重複的滑鼠提示");
  const rights = await pop.locator(".multi-select-aside").evaluateAll((els) => els.filter((e) => e.getClientRects().length).map((e) => Math.round(e.getBoundingClientRect().right)));
  assert.equal(new Set(rights).size, 1, `日期靠右對齊：${rights}`);
  // 打字找時收起來的也找得到；清掉後再按「顯示更早的」展開。
  await pop.locator(".multi-select-search").fill("Sprint 42");
  assert.equal(await pop.locator(".multi-select-item", { hasText: "Sprint 42" }).isVisible(), true);
  assert.equal(await pop.locator(".multi-select-group").first().isVisible(), false, "找的時候不顯示組名");
  await pop.locator(".multi-select-search").fill("");
  assert.equal(await pop.locator(".multi-select-item", { hasText: "Sprint 42" }).isVisible(), false);
  await pop.getByRole("button", { name: "顯示更早的 3 個" }).click();
  assert.equal(await pop.locator(".multi-select-item", { hasText: "Sprint 42" }).isVisible(), true);
  // 選單和按鈕左右對齊（按鈕夠寬時不會比按鈕寬）。
  const edges = await page.evaluate(() => {
    const b = document.querySelector('#workitems-host .multi-select[aria-label^="Sprint："]').getBoundingClientRect();
    const p = document.querySelector(".multi-select-pop:popover-open").getBoundingClientRect();
    return { b: [b.left, b.right], p: [p.left, p.right] };
  });
  assert.equal(Math.round(edges.p[0]), Math.round(edges.b[0]), JSON.stringify(edges));
  await page.keyboard.press("Escape");
  // 多選：加上上一個 Sprint 與沒有排進 Sprint。
  const before = (await lists(page)).length;
  await pick(page, "Sprint", ["Sprint 46", "沒有排進 Sprint"]);
  await page.waitForFunction((n) => window.__fake.calls.filter((c) => c.cmd === "ado_work_items").length > n, before);
  assert.deepEqual((await lists(page)).at(-1).iterations.sort(), ["產品", "產品\\Sprint 46", "產品\\Sprint 47"].sort());
  assert.equal(await sprintButton(page).evaluate((el) => el.classList.contains("chosen")), true, "改過：強調色");

  // 重開：專案還記得，Sprint 回到本週。
  await page.reload();
  await openList(page);
  await page.waitForFunction(() => /Sprint 47（本週/.test(document.querySelector('#workitems-host .multi-select[aria-label^="Sprint："]')?.textContent ?? ""));
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "ado_work_items").some((c) => c.args.filter.iterations?.length));
  assert.deepEqual((await lists(page)).at(-1).iterations, ["產品\\Sprint 47"]);

  // 選了兩個專案（全部勾等於不限，所以有三個專案）：Sprint 不顯示、不篩選。
  await pick(page, "專案", ["平台"]);
  await sprintButton(page).waitFor({ state: "hidden" });
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "ado_work_items").at(-1).args.filter.projects.length === 2);
  assert.deepEqual((await lists(page)).at(-1).iterations, []);
  assert.deepEqual(errors, []);
  await context.close();
});

test("讀不到 Sprint（權限不足）：不顯示、不篩選，清單照常", async () => {
  const { page, context, errors } = await open({ desktop: { ...desktop, ado_teams: { $error: "沒有權限讀取團隊" } } });
  await openList(page);
  await onlyProject(page, "產品");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_teams"));
  await sprintButton(page).waitFor({ state: "hidden" });
  assert.deepEqual((await lists(page)).at(-1).iterations, []);
  assert.deepEqual(errors, []);
  await context.close();
});

test("不屬於任何團隊（或舊版伺服器讀不到）：用專案的預設團隊", async () => {
  const teams = [
    { id: "team-1", name: "產品團隊", default: true, mine: false },
    { id: "team-2", name: "前端小組", default: false, mine: false },
  ];
  const { page, context, errors } = await open({ desktop: { ...desktop, ado_teams: { $by: "project", values: { 產品: teams } } } });
  await openList(page);
  await onlyProject(page, "產品");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_team_iterations"));
  assert.deepEqual((await calls(page)).find((c) => c.cmd === "ado_team_iterations").args, { project: "產品", team: "team-1" });
  assert.deepEqual(errors, []);
  await context.close();
});
