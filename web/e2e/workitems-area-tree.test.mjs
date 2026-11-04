/**
 * 工作項目清單「依區域＋上層項目分組」：外層和「依區域分組」一樣一個區域一組（順序、標題、數量），
 * 組裡再和「依上層項目分組」一樣排成樹，只用這一組的項目。上層在別的區域時（Task 在 Cobalt、它的 Story 在 IRIS），
 * Story 淡淡地列在 Cobalt 那一組當上層，Task 只出現在 Cobalt；組與樹的節點各自收合，不會和別組、別的排法混在一起。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const P = "Contoso-Cloud_Platform";
/** 區域下拉選單的順序（伺服器的樹狀順序）。 */
const AREAS = ["2048", "2048\\前端", "IRIS", "IRIS\\監控", "IRIS\\維運", "Cobalt", "Cobalt\\API", "DevOps", "共用服務"].map((a) => `${P}\\${a}`);
const at = (rel) => `${P}\\${rel}`;
const item = (id, title, kind, state, area) => ({
  id,
  title,
  state,
  kind,
  project: P,
  assignedTo: "王小明",
  changed: "2026-11-01T00:00:00Z",
  priority: 2,
  area,
  webUrl: `https://ado.test/c/${P}/_workitems/edit/${id}`,
});

const STORY_2048 = item(1938720, "雲端平台帳號申請流程上線", "User Story", "Active", at("2048"));
const TASK_2048 = item(1941002, "調整登入頁面版面", "Task", "Active", at("2048\\前端"));
const STORY_IRIS = item(1936947, "提供 SRE 監控儀表板", "User Story", "Active", at("IRIS"));
const TASK_IRIS = item(1940131, "監控告警規則調整", "Task", "Active", at("IRIS\\監控"));
const STORY_COBALT = item(1939500, "Cobalt API 閘道整合", "User Story", "Active", at("Cobalt"));
const TASK_COBALT = item(1940129, "撰寫 Cobalt API 串接文件", "Task", "New", at("Cobalt"));
const TASK_API = item(1940140, "API 金鑰輪替", "Task", "Active", at("Cobalt\\API"));
/** 在 Cobalt，但它的 Story 在 IRIS。 */
const TASK_CROSS = item(1940150, "Cobalt 告警串接 SRE 儀表板", "Task", "Active", at("Cobalt"));
/** 兩個區域的 Story 共同的 Feature（不是指派給我的，不在清單上）。 */
const FEATURE = item(1900179, "雲端平台維運自動化", "Feature", "Active", at("IRIS"));
/** 選了 2048、IRIS、Cobalt 時伺服器回的（最近更新的在前面）。 */
const LISTED = [TASK_IRIS, STORY_2048, TASK_COBALT, TASK_CROSS, STORY_IRIS, TASK_API, TASK_2048, STORY_COBALT];
const FILTER = { role: "assigned", person: "@me", state: "open", states: [], kinds: [], projects: [P], areas: [at("2048"), at("IRIS"), at("Cobalt")] };

/** 「提供 SRE 監控儀表板」的內容（從捷徑開啟用）。 */
const DETAIL = { ...STORY_IRIS, createdBy: "王小明", iteration: P, tags: [], description: "<p>說明</p>", details: null, rev: 1, relations: [], attachments: [], comments: [] };

/** 清單上每一列：[標題〔子區域〕, 淡色, 縮排第幾層, 摘要]；區域的標題列寫成 `# 標題（數量）`。 */
const rows = (page) =>
  page.locator("#workitems-host .workitems-list > li").evaluateAll((lis) =>
    lis.map((li) => {
      if (li.classList.contains("workitems-group")) return `# ${li.querySelector(".workitems-group-name").textContent}（${li.querySelector(".workitems-group-count").textContent}）`;
      const note = li.querySelector(".workitem-note")?.textContent;
      return [
        li.querySelector(".workitem-title").textContent + (note ? `〔${note}〕` : ""),
        li.classList.contains("workitems-dim"),
        Number(li.dataset.depth ?? 0),
        li.querySelector(".workitem-summary")?.textContent ?? "",
      ];
    }),
  );
const titles = async (page) => (await rows(page)).map((r) => (typeof r === "string" ? r : r[0].replace(/〔.*〕$/, "")));

/** 等清單排好（上層在背景讀到後才排成樹），不對就照最後一次的結果比對。 */
async function expectRows(page, read, expected) {
  let got;
  for (let i = 0; i < 50; i++) {
    got = await read(page);
    if (JSON.stringify(got) === JSON.stringify(expected)) return;
    await page.waitForTimeout(100);
  }
  assert.deepEqual(got, expected);
}

const TREES = [
  "# 2048（2）",
  ["雲端平台帳號申請流程上線", false, 0, "1 個 Task"],
  ["調整登入頁面版面〔前端〕", false, 1, ""],
  // Feature 不在清單上：在 IRIS、Cobalt 兩組各淡淡地出現一次，摘要只算這一組的項目。
  "# IRIS（2）",
  ["雲端平台維運自動化", true, 0, "1 個 User Story・1 個 Task"],
  ["提供 SRE 監控儀表板", false, 1, "1 個 Task"],
  ["監控告警規則調整〔監控〕", false, 2, ""],
  // 「Cobalt 告警串接 SRE 儀表板」只在 Cobalt；它的 Story（在 IRIS）在這裡是淡色的上層，數量不算它。
  "# Cobalt（4）",
  ["雲端平台維運自動化", true, 0, "1 個 User Story・3 個 Task"],
  ["提供 SRE 監控儀表板", true, 1, "1 個 Task"],
  ["Cobalt 告警串接 SRE 儀表板", false, 2, ""],
  ["Cobalt API 閘道整合", false, 1, "2 個 Task"],
  ["撰寫 Cobalt API 串接文件", false, 2, ""],
  ["API 金鑰輪替〔API〕", false, 2, ""],
];

test("依區域＋上層項目分組：區域一組，組裡排成樹；上層在別的區域時淡色地列在這一組，項目不重複；收合各自獨立", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_work_item_filters: { projects: [P], kinds: ["Feature", "User Story", "Task"] },
      ado_work_item_scope: { areas: AREAS, people: ["王小明"] },
      ado_work_items: [LISTED],
      ado_work_item: DETAIL,
      // 一層一層往上讀：清單上的 → Feature。第一次慢一點，先看得到依區域分組的樣子。
      ado_work_item_parents: [
        {
          $delay: 800,
          value: {
            links: [
              [TASK_2048.id, STORY_2048.id],
              [TASK_IRIS.id, STORY_IRIS.id],
              [TASK_COBALT.id, STORY_COBALT.id],
              [TASK_API.id, STORY_COBALT.id],
              [TASK_CROSS.id, STORY_IRIS.id],
              [STORY_IRIS.id, FEATURE.id],
              [STORY_COBALT.id, FEATURE.id],
            ],
            parents: [STORY_2048, STORY_IRIS, STORY_COBALT, FEATURE],
          },
        },
        { links: [], parents: [] },
      ],
      ado_work_item_children: { links: [], items: [] },
    },
  });
  await page.evaluate((filter) => {
    localStorage.setItem("md-editor:workitem-filter", JSON.stringify(filter));
    localStorage.setItem("md-editor:wiki-shortcuts", JSON.stringify([{ workItem: 1936947, kind: "User Story", title: "提供 SRE 監控儀表板" }]));
  }, FILTER);
  await page.reload();
  await page.locator("#side-tab-workitems").click();
  await page.locator("#workitems-host .workitem-title", { hasText: "監控告警規則調整" }).waitFor();

  // 排列方式的選單裡有「依區域＋上層項目分組」，在「依區域分組」後面；原本的兩個不變。
  const arrange = page.locator("#workitems-host .workitems-arrange");
  const labels = await arrange.locator("option").allTextContents();
  assert.equal(labels[labels.indexOf("依區域分組") + 1], "依區域＋上層項目分組", labels.join("、"));
  assert.ok(labels.includes("依上層項目分組"), labels.join("、"));
  await arrange.selectOption({ label: "依區域＋上層項目分組" });
  assert.equal(await page.evaluate(() => localStorage.getItem("md-editor:workitem-arrange")), "area-parent", "記住排列方式");

  // 上層還沒讀到：先和依區域分組一樣（組、數量、子區域的小字）。
  assert.deepEqual(
    (await rows(page)).map((r) => (typeof r === "string" ? r : r[0])),
    ["# 2048（2）", "雲端平台帳號申請流程上線", "調整登入頁面版面〔前端〕", "# IRIS（2）", "監控告警規則調整〔監控〕", "提供 SRE 監控儀表板", "# Cobalt（4）", "撰寫 Cobalt API 串接文件", "Cobalt 告警串接 SRE 儀表板", "API 金鑰輪替〔API〕", "Cobalt API 閘道整合"],
  );
  // 讀到上層後：每一組排成樹。
  await expectRows(page, rows, TREES);
  // 跨區域的 Task 只出現一次；它的 Story 在 IRIS 是一般的列、在 Cobalt 是淡色的上層；Feature 兩組都是淡色。
  const shown = (id) => page.locator(`#workitems-host .workitems-list > li:has(> .workitem[data-id="${id}"])`).evaluateAll((lis) => lis.map((li) => li.classList.contains("workitems-dim")));
  assert.deepEqual(await shown(TASK_CROSS.id), [false]);
  assert.deepEqual(await shown(STORY_IRIS.id), [false, true]);
  assert.deepEqual(await shown(FEATURE.id), [true, true]);
  // 不補不在清單上的子項目（組和依區域分組一樣）。
  assert.ok(!(await calls(page)).some((c) => c.cmd === "ado_work_item_children"), "沒有讀子項目");

  // 收合 Cobalt 那一組的 Feature：IRIS 那一組的 Feature 還開著。
  // 收合的識別裡有區域路徑的「\」：選取器裡要寫成「\\」。
  const toggle = (key) => page.locator(`#workitems-host .workitems-group-toggle[data-key="${key.replaceAll("\\", "\\\\")}"]`);
  const cometFeature = `area-parent:area:${P.toLowerCase()}\\cobalt:tree:${FEATURE.id}`;
  const itaFeature = `area-parent:area:${P.toLowerCase()}\\iris:tree:${FEATURE.id}`;
  await toggle(cometFeature).click();
  assert.equal(await toggle(cometFeature).getAttribute("aria-expanded"), "false");
  assert.equal(await toggle(itaFeature).getAttribute("aria-expanded"), "true");
  assert.deepEqual(await titles(page), [
    "# 2048（2）",
    "雲端平台帳號申請流程上線",
    "調整登入頁面版面",
    "# IRIS（2）",
    "雲端平台維運自動化",
    "提供 SRE 監控儀表板",
    "監控告警規則調整",
    "# Cobalt（4）",
    "雲端平台維運自動化",
  ]);
  // 收合 IRIS 那一組：Cobalt 不受影響。
  await page.locator("#workitems-host .workitems-group button", { hasText: "IRIS" }).click();
  assert.deepEqual(await titles(page), ["# 2048（2）", "雲端平台帳號申請流程上線", "調整登入頁面版面", "# IRIS（2）", "# Cobalt（4）", "雲端平台維運自動化"]);

  // 換到「依上層項目分組」：Feature 是開著的（收合各排法分開記）；在那裡收合也不影響依區域＋上層項目分組。
  await arrange.selectOption({ label: "依上層項目分組" });
  assert.equal(await toggle(`parent:tree:${FEATURE.id}`).getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator(`#workitems-host .workitem[data-id="${TASK_CROSS.id}"]`).count(), 1);
  await toggle(`parent:tree:${FEATURE.id}`).click();
  await arrange.selectOption({ label: "依區域＋上層項目分組" });
  assert.deepEqual(await titles(page), ["# 2048（2）", "雲端平台帳號申請流程上線", "調整登入頁面版面", "# IRIS（2）", "# Cobalt（4）", "雲端平台維運自動化"]);

  // 從左側圖示列開啟「提供 SRE 監控儀表板」：展開它自己那一列所在的 IRIS，Cobalt 裡淡色的那一份維持收著。
  await page.locator(".activity-wiki-page").first().click();
  await page.locator('#workitems-host li:not(.workitems-dim) > .workitem[aria-current="true"]', { hasText: "提供 SRE 監控儀表板" }).waitFor();
  assert.deepEqual(await titles(page), [
    "# 2048（2）",
    "雲端平台帳號申請流程上線",
    "調整登入頁面版面",
    "# IRIS（2）",
    "雲端平台維運自動化",
    "提供 SRE 監控儀表板",
    "監控告警規則調整",
    "# Cobalt（4）",
    "雲端平台維運自動化",
  ]);

  // 全部展開：收起來的組與裡面收起來的節點都打開。
  const fold = page.locator("#workitems-host .workitems-fold:not(.workitems-pick)");
  await fold.click();
  assert.equal(await fold.getAttribute("aria-label"), "全部展開");
  assert.deepEqual(await titles(page), ["# 2048（2）", "# IRIS（2）", "# Cobalt（4）"]);
  await fold.click();
  await expectRows(page, rows, TREES);
  assert.deepEqual(errors, []);
  await context.close();
});
