/**
 * 工作項目、Wiki 頁面右上角的「在瀏覽器開啟」：一定用瀏覽器開。
 * （內容裡連到工作項目的網址會在 oMarker 裡開；這個按鈕的網址就是項目自己，不能也走那條路，不然按了沒反應。）
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ITEM = {
  id: 42,
  title: "修正登入",
  state: "Active",
  kind: "Task",
  project: "產品",
  assignedTo: "王小明",
  changed: "2026-10-30T00:00:00Z",
  priority: 2,
  webUrl: "https://ado.test/c/產品/_workitems/edit/42",
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

test("工作項目的「在瀏覽器開啟」：用瀏覽器開這個項目的網址", async () => {
  const { page, context, errors } = await open({
    desktop: { ado_account: { url: "https://ado.test/c", name: "王小明" }, ado_work_item: ITEM },
  });
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill("#42");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ado-hero h1");
  const before = (await calls(page)).filter((c) => c.cmd === "ado_work_item").length;
  await page.getByRole("button", { name: "在瀏覽器開啟" }).click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "open_external"));
  const opened = (await calls(page)).filter((c) => c.cmd === "open_external").map((c) => c.args.url);
  assert.deepEqual(opened, [ITEM.webUrl]);
  assert.equal((await calls(page)).filter((c) => c.cmd === "ado_work_item").length, before, "沒有又在 oMarker 裡開一次");
  assert.deepEqual(errors, []);
  await context.close();
});
