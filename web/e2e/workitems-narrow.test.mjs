/**
 * 側邊欄拉窄時，工作項目清單上方的版面不亂：「N 個…」與排列方式、收合按鈕一直是一列（文字截短，
 * 滑鼠移上去看完整的；數字在最前面不會被截掉），按鈕不被切掉；「有 N 個新的或有更新」是說明一行、
 * 動作一行。用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const item = (id) => ({
  id,
  title: `工作項目 ${id}`,
  state: "Active",
  kind: "Task",
  project: "產品",
  assignedTo: "王小明",
  changed: "2026-11-01T00:00:00Z",
  priority: 2,
  webUrl: `https://ado.test/c/產品/_workitems/edit/${id}`,
});

test("側邊欄拉寬拉窄：清單上方一直是一列、按鈕不被切掉；新的或有更新的說明一行、動作一行", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_work_items: [Array.from({ length: 100 }, (_, i) => item(i + 1))],
      ado_work_item_parents: { links: [], parents: [] },
      ado_work_item_children: { links: [], items: [] },
    },
  });
  await page.evaluate(() => {
    localStorage.setItem("md-editor:workitem-seen", "{}");
    localStorage.setItem("md-editor:workitem-arrange", "parent");
  });
  await page.reload();
  await page.locator("#side-tab-workitems").click();
  await page.locator(".workitems-unseen").waitFor();
  for (const width of [360, 290, 230]) {
    await page.evaluate((w) => document.documentElement.style.setProperty("--outline-width", `${w}px`), width);
    await page.waitForTimeout(200);
    const look = await page.evaluate(() => {
      const host = document.querySelector("#workitems-host").getBoundingClientRect();
      const status = document.querySelector("#workitems-host .workitems-status");
      const tools = document.querySelector("#workitems-host .workitems-tools").getBoundingClientRect();
      const line = parseFloat(getComputedStyle(status).lineHeight) || 18;
      const [text, ...actions] = [...document.querySelectorAll(".workitems-unseen > *")].map((e) => e.getBoundingClientRect());
      return {
        statusLines: Math.round(status.getBoundingClientRect().height / line),
        statusText: status.textContent,
        statusTitle: status.title,
        toolsInside: tools.right <= host.right + 1,
        actionsBelowText: actions.every((a) => a.top >= text.bottom - 1),
        actionsSameRow: actions.every((a) => Math.abs(a.top - actions[0].top) < 2),
      };
    });
    assert.equal(look.statusLines, 1, `${width}px：清單上方是一列`);
    assert.match(look.statusText, /^100 個/, "數字在最前面");
    assert.equal(look.statusTitle, look.statusText, "滑鼠移上去看完整的");
    assert.ok(look.toolsInside, `${width}px：按鈕沒有被切掉`);
    assert.ok(look.actionsBelowText && look.actionsSameRow, `${width}px：說明一行、動作一行`);
  }
  assert.deepEqual(errors, []);
  await context.close();
});
