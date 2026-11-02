/**
 * 工作項目、Wiki 頁面的分頁：從外面（Ctrl+P、側邊欄、捷徑）開的每一項各自一個分頁，已經開著就切過去；
 * 分頁內容裡的連結留在同一個分頁，可以回上一頁。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const item = (id, title, description, relations = []) => ({
  id,
  title,
  state: "Active",
  kind: "Task",
  project: "產品",
  assignedTo: null,
  changed: "2026-10-30T00:00:00Z",
  priority: null,
  webUrl: `https://ado.test/c/產品/_workitems/edit/${id}`,
  createdBy: null,
  area: null,
  iteration: null,
  tags: [],
  description,
  details: null,
  rev: 1,
  relations,
  attachments: [],
  comments: [],
});

const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_work_item: {
    $by: "id",
    values: {
      42: item(42, "第一個項目", '<p>請看 <a href="https://ado.test/c/產品/_workitems/edit/43">另一個項目</a></p>', [
        { ...item(43, "第二個項目", null), link: "related", linkName: "Related" },
      ]),
      43: item(43, "第二個項目", "<p>沒有連結</p>"),
      44: item(44, "第三個項目", "<p>內容</p>"),
    },
  },
};

/** 看得到的分頁名稱。 */
const tabs = (page) =>
  page.$$eval("#tab-bar .tab", (list) =>
    list.filter((t) => getComputedStyle(t).display !== "none" && getComputedStyle(t).visibility !== "hidden").map((t) => t.textContent.trim()),
  );
const heading = (page) => page.locator(".ado-hero h1").first().textContent();

async function quickOpen(page, query, title) {
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill(query);
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
  await page.waitForFunction((t) => document.querySelector(".ado-hero h1")?.textContent?.includes(t), title);
}

test("從外面開的每一項各自一個分頁；已經開著就切過去", async () => {
  const { page, context, errors } = await open({ desktop });
  await quickOpen(page, "#42", "第一個項目");
  await quickOpen(page, "#44", "第三個項目");
  // 以前第二個會換掉第一個（預覽分頁），現在兩個都留著。
  assert.deepEqual(await tabs(page), ["42 第一個項目", "44 第三個項目"]);
  assert.equal(await page.locator("#tab-bar .tab.preview").count(), 0, "沒有預覽分頁（斜體）了");
  // 再開一次已經開著的：切過去，不多開。
  await quickOpen(page, "#42", "第一個項目");
  assert.deepEqual(await tabs(page), ["42 第一個項目", "44 第三個項目"]);
  assert.equal(await page.locator('#tab-bar .tab[aria-selected="true"]').textContent(), "42 第一個項目");
  assert.deepEqual(errors, []);
  await context.close();
});

test("分頁裡點連結：留在同一個分頁，可以回上一頁", async () => {
  const { page, context, errors } = await open({ desktop });
  await quickOpen(page, "#42", "第一個項目");
  await page.click(".issue-body a:has-text('另一個項目')");
  await page.waitForFunction(() => document.querySelector(".ado-hero h1")?.textContent?.includes("第二個項目"));
  assert.deepEqual(await tabs(page), ["43 第二個項目"], "同一個分頁換成連結的內容");
  await page.keyboard.press("<");
  await page.waitForFunction(() => document.querySelector(".ado-hero h1")?.textContent?.includes("第一個項目"));
  assert.match(await heading(page), /第一個項目/);
  assert.deepEqual(await tabs(page), ["42 第一個項目"]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("舊版留下的預覽分頁，還原後是一般分頁", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.evaluate(() =>
    localStorage.setItem(
      "md-editor:item-tabs",
      JSON.stringify([{ key: "ado:44", name: "第三個項目", title: "Task 44：第三個項目", origin: "ado", preview: true, ref: { workItem: 44, kind: "Task", title: "第三個項目" } }]),
    ),
  );
  await page.reload();
  await page.waitForSelector(".cm-editor .cm-content");
  await page.waitForFunction(() => [...document.querySelectorAll("#tab-bar .tab")].some((t) => t.textContent.includes("第三個項目")));
  assert.equal(await page.locator("#tab-bar .tab.preview").count(), 0);
  await quickOpen(page, "#42", "第一個項目");
  assert.ok((await tabs(page)).includes("44 第三個項目"), "開別的項目不會換掉它");
  assert.deepEqual(errors, []);
  await context.close();
});
