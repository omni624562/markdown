/**
 * 工作項目清單「依區域分組」：沒選區域時依專案底下的第一層區域分組（直接在專案底下的是專案那一組），
 * 篩選選了區域時一個區域一組（照區域下拉選單的順序），子區域的項目放在上層那一組、列上標出子區域；
 * 沒有區域的（更新前存下的離線副本）放在最後的「其他」。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const P = "Contoso-Cloud_Platform";
/** 區域下拉選單的順序（伺服器的樹狀順序，不是依名稱排）。 */
const AREAS = ["2048", "2048\\前端", "IRIS", "IRIS\\監控", "IRIS\\維運", "Cobalt", "DevOps", "AI 平台", "資安", "數據中台", "共用服務"].map((a) => `${P}\\${a}`);

/** 區域的完整路徑：`at("IRIS\\監控")`；空字串是專案本身。 */
const at = (rel) => (rel ? `${P}\\${rel}` : P);
/** `area` 是 undefined 時沒有這個欄位（更新前存下的離線副本）。 */
const item = (id, title, kind, state, area) => ({
  id,
  title,
  state,
  kind,
  project: P,
  assignedTo: "王小明",
  changed: "2026-11-01T00:00:00Z",
  priority: 2,
  ...(area === undefined ? {} : { area }),
  webUrl: `https://ado.test/c/${P}/_workitems/edit/${id}`,
});
/** 選了 2048、IRIS、Cobalt 時伺服器回的（最近更新的在前面）。 */
const PICKED = [
  item(1940131, "監控告警規則調整", "Task", "Active", at("IRIS\\監控")),
  item(1938720, "雲端平台帳號申請流程上線", "User Story", "Active", at("2048")),
  item(1940129, "撰寫 Cobalt API 串接文件", "Task", "New", at("Cobalt")),
  item(1936947, "提供 SRE 監控儀表板", "User Story", "Active", at("IRIS")),
  item(1941002, "調整登入頁面版面", "Task", "Active", at("2048\\前端")),
];
/** 沒選區域時：還有別的區域、直接在專案底下的，以及沒有區域的（舊的離線副本）。 */
const ALL = [
  ...PICKED,
  item(1942010, "弱點掃描報告追蹤", "Task", "Active", at("資安")),
  item(1930001, "年度系統盤點", "Task", "New", at("")),
  item(1937001, "報表權限調整", "User Story", "Active", at("數據中台")),
  item(1929999, "舊的離線副本", "Task", "Active", undefined),
];
const FILTER = { role: "assigned", person: "@me", state: "open", states: [], kinds: [], projects: [P], areas: [] };

/** 清單畫成文字：每組一行「標題（數量）：項目標題〔子區域〕…」。 */
const groups = (page) =>
  page.evaluate(() => {
    const out = [];
    for (const li of document.querySelectorAll("#workitems-host .workitems-list > li")) {
      if (li.classList.contains("workitems-group")) {
        const name = li.querySelector(".workitems-group-name").textContent;
        const count = li.querySelector(".workitems-group-count").textContent;
        out.push({ head: `${name}（${count}）`, items: [] });
        continue;
      }
      const note = li.querySelector(".workitem-note")?.textContent;
      out.at(-1).items.push(li.querySelector(".workitem-title").textContent + (note ? `〔${note}〕` : ""));
    }
    return out.map((g) => `${g.head}：${g.items.join("、")}`);
  });

/** 等清單分好組（區域的順序在背景讀到後才確定），不對就照最後一次的結果比對。 */
async function expectGroups(page, expected) {
  let got;
  for (let i = 0; i < 50; i++) {
    got = await groups(page);
    if (JSON.stringify(got) === JSON.stringify(expected)) return;
    await page.waitForTimeout(100);
  }
  assert.deepEqual(got, expected);
}

/** 在區域的複選選單裡只勾 `values`（完整路徑）。 */
async function pickAreas(page, values) {
  await page.locator('#workitems-host .multi-select[aria-label^="區域："]').click();
  const pop = page.locator(".multi-select-pop:popover-open");
  // 不限時全部都勾著：先取消全部，再勾要的。
  await pop.locator(".multi-select-all input").uncheck();
  for (const v of values) await pop.locator(`.multi-select-list input[value="${v.replaceAll("\\", "\\\\")}"]`).check();
  await page.keyboard.press("Escape");
}

test("依區域分組：沒選區域依第一層區域分組；選了區域時一個區域一組，照下拉選單的順序，子區域標在列上", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_work_item_filters: { projects: [P, "Contoso-Infra"], kinds: ["User Story", "Task"] },
      ado_work_item_scope: { areas: AREAS, people: ["王小明", "張志明"] },
      ado_work_items: [ALL],
    },
  });
  // 伺服器依篩選的區域回不同的清單。
  await context.addInitScript(
    ({ all, picked }) => {
      const invoke = window.__TAURI__.core.invoke;
      window.__TAURI__.core.invoke = (cmd, args) => {
        if (cmd !== "ado_work_items") return invoke(cmd, args);
        window.__fake.calls.push({ cmd, args });
        return Promise.resolve(args?.filter?.areas?.length ? picked : all);
      };
    },
    { all: ALL, picked: PICKED },
  );
  await page.evaluate((filter) => localStorage.setItem("md-editor:workitem-filter", JSON.stringify(filter)), FILTER);
  await page.reload();
  await page.locator("#side-tab-workitems").click();
  await page.locator("#workitems-host .workitem-title", { hasText: "監控告警規則調整" }).waitFor();

  // 排列方式的選單裡有「依區域分組」，在「依類型分組」旁邊。
  const arrange = page.locator("#workitems-host .workitems-arrange");
  const labels = await arrange.locator("option").allTextContents();
  assert.equal(labels[labels.indexOf("依類型分組") + 1], "依區域分組", labels.join("、"));
  await arrange.selectOption({ label: "依區域分組" });

  // 沒選區域：專案本身那一組在最前面，接著依下拉選單的順序；子區域標在列上；沒有區域的放最後的「其他」。
  await expectGroups(page, [
    `${P}（1）：年度系統盤點`,
    "2048（2）：雲端平台帳號申請流程上線、調整登入頁面版面〔前端〕",
    "IRIS（2）：監控告警規則調整〔監控〕、提供 SRE 監控儀表板",
    "Cobalt（1）：撰寫 Cobalt API 串接文件",
    "資安（1）：弱點掃描報告追蹤",
    "數據中台（1）：報表權限調整",
    "其他（1）：舊的離線副本",
  ]);
  assert.equal(await page.evaluate(() => localStorage.getItem("md-editor:workitem-arrange")), "area", "記住排列方式");

  // 選了 2048、IRIS、Cobalt：一個區域一組，照下拉選單的順序（不是依名稱）。
  await pickAreas(page, [`${P}\\Cobalt`, `${P}\\2048`, `${P}\\IRIS`]);
  await expectGroups(page, [
    "2048（2）：雲端平台帳號申請流程上線、調整登入頁面版面〔前端〕",
    "IRIS（2）：監控告警規則調整〔監控〕、提供 SRE 監控儀表板",
    "Cobalt（1）：撰寫 Cobalt API 串接文件",
  ]);
  const req = (await page.evaluate(() => window.__fake.calls)).filter((c) => c.cmd === "ado_work_items").at(-1).args;
  assert.deepEqual(req.filter.areas, [`${P}\\2048`, `${P}\\IRIS`, `${P}\\Cobalt`]);
  // 子區域的小字和類型、編號、狀態在同一行（不會多佔一行），滑鼠移上去看得到完整的區域。
  const row = page.locator("#workitems-host .workitem", { hasText: "監控告警規則調整" });
  assert.equal(await row.locator(".workitem-meta .workitem-note").getAttribute("title"), `區域：${P} › IRIS › 監控`);
  const tops = await row.evaluate((b) => [".workitem-meta-text", ".workitem-note", ".workitem-state"].map((s) => Math.round(b.querySelector(s).getBoundingClientRect().top)));
  assert.ok(Math.max(...tops) - Math.min(...tops) <= 2, `同一行：${tops}`);

  // 組可以收合，和其他分組一樣。
  await page.locator("#workitems-host .workitems-group button", { hasText: "IRIS" }).click();
  assert.deepEqual(await groups(page), ["2048（2）：雲端平台帳號申請流程上線、調整登入頁面版面〔前端〕", "IRIS（2）：", "Cobalt（1）：撰寫 Cobalt API 串接文件"]);
  assert.equal(await page.locator("#workitems-host .workitems-fold:not(.workitems-pick)").getAttribute("aria-label"), "全部收合", "可以一鍵全部收合");
  assert.deepEqual(errors, []);
  await context.close();
});
