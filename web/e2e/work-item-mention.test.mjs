/**
 * 留言 @ 同事：打 @ 跳出專案預設團隊的成員，打了字再用伺服器的身分搜尋補上其他人；
 * 選了之後送出的是 Azure DevOps 的 @（對方會收到通知）。編輯留言時原本的 @ 保留。
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
};
const MENTION = '<a href="#" data-vss-mention="version:2.0,id-2">@李大同</a>';
const DETAIL = {
  ...ITEM,
  createdBy: "王小明",
  area: "產品",
  iteration: "產品",
  tags: [],
  description: "<p>說明</p>",
  details: null,
  rev: 3,
  relations: [],
  attachments: [],
  comments: [{ id: 7, author: "王小明", created: "2026-10-28T01:00:00Z", text: `<div>${MENTION} 好了嗎</div>` }],
};
const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_work_item: DETAIL,
  ado_project_members: [
    [
      { name: "王小明", unique: "CORP\\ming", id: "id-1" },
      { name: "李大同", unique: "CORP\\tong", id: "id-2" },
      // 舊版伺服器沒給編號：@ 了也收不到通知，不列出來。
      { name: "王沒有", unique: "CORP\\none", id: "" },
    ],
  ],
  // 身分搜尋：團隊以外的人也找得到；團隊裡已經有的不重複。
  ado_search_people: [[{ name: "王小明", unique: "CORP\\ming", id: "id-1" }, { name: "王大文", unique: "CORP\\wen", id: "id-3" }]],
};

async function openItem(page) {
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill("#42");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ado-comment[data-index]");
}

const names = (page) => page.locator(".mention-list:not([hidden]) li .mention-name").allTextContents();

test("留言 @ 同事：先列團隊成員，打字後補上搜尋到的人，選了送出的是 @", async () => {
  const { page, context, errors } = await open({ desktop });
  await openItem(page);
  // 現有留言裡的 @ 顯示成「@李大同」文字，不是連到 # 的連結。
  const card = page.locator(".ado-comment[data-index='0']");
  assert.match(await card.textContent(), /@李大同 好了嗎/);
  assert.equal(await card.locator('a[href="#"]').count(), 0);

  const box = page.locator(".ado-compose:not(.ado-comment-edit) textarea");
  await box.click();
  await box.pressSequentially("請 @");
  await page.locator(".mention-list:not([hidden]) li").first().waitFor();
  assert.deepEqual(await names(page), ["王小明", "李大同"]);
  await box.pressSequentially("王");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_search_people"));
  await page.waitForFunction(() => document.querySelectorAll(".mention-list:not([hidden]) li").length === 2);
  assert.deepEqual(await names(page), ["王小明", "王大文"]);
  // 往下選第二個，Enter 選人（不是換行），接著打字。
  await box.press("ArrowDown");
  await box.press("Enter");
  assert.equal(await box.inputValue(), "請 @王大文 ");
  assert.equal(await page.locator(".mention-list:not([hidden])").count(), 0);
  await box.pressSequentially("看一下");
  await box.press("Control+Enter");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_work_item_update"));
  const all = await calls(page);
  const sent = all.find((c) => c.cmd === "ado_work_item_update").args.change.comment;
  assert.match(sent, /<a href="#" data-vss-mention="version:2\.0,id-3">@王大文<\/a> 看一下/);
  assert.deepEqual(all.find((c) => c.cmd === "ado_project_members").args, { project: "產品" });
  assert.deepEqual(all.filter((c) => c.cmd === "ado_search_people").map((c) => c.args.query), ["王"]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("留言 @ 同事：Esc 關清單不收起留言框；找不到人時說明；編輯留言時原本的 @ 保留", async () => {
  const { page, context, errors } = await open({ desktop: { ...desktop, ado_search_people: [[]] } });
  await openItem(page);
  const box = page.locator(".ado-compose:not(.ado-comment-edit) textarea");
  await box.click();
  await box.pressSequentially("@zz");
  await page.locator(".mention-list:not([hidden]) .mention-none", { hasText: "找不到「zz」" }).waitFor();
  await box.press("Escape");
  assert.equal(await page.locator(".mention-list:not([hidden])").count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA", "Esc 只關清單");
  assert.equal(await box.inputValue(), "@zz");

  const card = page.locator(".ado-comment[data-index='0']");
  await card.hover();
  await card.locator("button[aria-label='編輯留言']").click();
  const edit = card.locator(".ado-comment-edit textarea");
  assert.equal(await edit.inputValue(), "@李大同 好了嗎");
  await edit.fill("@李大同 好了嗎？");
  await edit.press("Control+Enter");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_comment_update"));
  const html = (await calls(page)).find((c) => c.cmd === "ado_comment_update").args.html;
  assert.match(html, /<a href="#" data-vss-mention="version:2\.0,id-2">@李大同<\/a> 好了嗎？/);
  assert.deepEqual(errors, []);
  await context.close();
});
