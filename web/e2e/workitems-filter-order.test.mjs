/**
 * 工作項目篩選列的排列：專案在最上面一整列；「指派給我」和「已儲存的查詢…」同一列、同樣高；
 * 類型、狀態在它們下面。用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

test("篩選列：專案在最上面一整列，「已儲存的查詢…」在「指派給我」旁邊", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_work_items: [[]],
      ado_work_item_filters: { projects: ["產品", "平台"], kinds: ["Task", "Bug"] },
    },
  });
  await page.locator("#side-tab-workitems").click();
  await page.locator("#workitems-host .workitems-filter-toggle:not(.workitems-query)").click();
  await page.locator("#workitems-host .workitems-filters .workitems-project").waitFor();
  const look = await page.evaluate(() => {
    const bar = document.querySelector("#workitems-host .workitems-filters");
    const box = (el) => el.getBoundingClientRect();
    const visible = [...bar.children].filter((el) => !el.hidden && el.getClientRects().length);
    const pick = (text) => visible.find((el) => el.textContent.includes(text));
    const project = bar.querySelector(".workitems-project");
    const query = bar.querySelector(".workitems-query-open");
    return {
      first: visible[0] === project,
      projectFull: Math.abs(box(project).width - bar.clientWidth) < 2,
      person: box(pick("指派給我")),
      query: box(query),
      project: box(project),
      kind: box(pick("所有類型")),
      queryArrow: getComputedStyle(query).backgroundImage,
    };
  });
  assert.ok(look.first, "專案是篩選列的第一個");
  assert.ok(look.projectFull, "專案佔一整列");
  assert.ok(look.person.top > look.project.bottom - 1, "指派給我在專案下面");
  assert.ok(Math.abs(look.person.top - look.query.top) < 2, "已儲存的查詢和指派給我同一列");
  assert.ok(look.query.left > look.person.right - 1, "已儲存的查詢在指派給我右邊");
  assert.ok(Math.abs(look.person.height - look.query.height) < 1, "兩個一樣高");
  assert.equal(look.queryArrow, "none", "已儲存的查詢開的是對話框，不畫下拉箭頭");
  assert.ok(look.kind.top > look.person.bottom - 1, "類型在下一列");
  assert.deepEqual(errors, []);
  await context.close();
});
