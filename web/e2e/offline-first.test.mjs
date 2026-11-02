/**
 * 先顯示上次存下的副本，背景讀完再換上新的；連不上時留著副本並說明（用假的原生端，見 helpers.mjs）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const FILTER = { role: "assigned", person: "@me", state: "open", kinds: [], projects: [], areas: [] };
const KEY = `list:wi-list::${JSON.stringify(FILTER)}`;
const item = (id, title) => ({
  id,
  title,
  state: "Active",
  kind: "Task",
  project: "產品",
  assignedTo: "王小明",
  changed: "2026-10-30T00:00:00Z",
  priority: 2,
  webUrl: `https://ado.test/c/產品/_workitems/edit/${id}`,
});
const copy = (value) => JSON.stringify({ $copy: 1, savedAt: Date.now() - 3600_000, value });

async function showWorkItems(page) {
  await page.locator("#side-tab-workitems").click();
}
const titles = (page) => page.$$eval("#workitems-host .workitem-title, #workitems-host .workitem .title", (l) => l.map((e) => e.textContent.trim()));

test("工作項目清單：先顯示副本，背景讀到新的再換上去", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      offline_get: { $by: "key", values: { [KEY]: copy([item(1, "副本裡的項目")]) } },
      ado_work_items: { $delay: 1500, value: [item(2, "伺服器上的新項目")] },
    },
  });
  await showWorkItems(page);
  const host = page.locator("#workitems-host");
  await host.getByText("副本裡的項目").waitFor({ timeout: 1000 });
  assert.match(await host.locator(".workitems-status").textContent(), /更新中/);
  await host.getByText("伺服器上的新項目").waitFor();
  assert.equal(await host.getByText("副本裡的項目").count(), 0);
  assert.doesNotMatch(await host.locator(".workitems-status").textContent(), /更新中/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("工作項目清單：連不上時留著副本，說明是幾點的資料，可以重試", async () => {
  const { page, context, errors } = await open({
    desktop: {
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      offline_get: { $by: "key", values: { [KEY]: copy([item(1, "副本裡的項目")]) } },
      ado_work_items: [{ $error: "連不上伺服器" }, [item(2, "恢復後的項目")]],
    },
  });
  await showWorkItems(page);
  const host = page.locator("#workitems-host");
  await host.getByText("副本裡的項目").waitFor();
  await host.locator(".workitems-status", { hasText: "連不上伺服器，顯示" }).waitFor();
  await host.locator(".workitems-status button", { hasText: "重試" }).click();
  await host.getByText("恢復後的項目").waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});
