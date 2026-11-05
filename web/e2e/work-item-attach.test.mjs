/**
 * 工作項目的附件：「加入附件…」選檔案、把檔案拖到工作項目上，都會上傳後掛到工作項目；
 * 在留言框貼上圖片會上傳成附件並插入圖片；點附件時只有允許清單裡的類型直接開啟，其他只能另存新檔。
 * 用假的原生端（見 helpers.mjs）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const base = { project: "產品", assignedTo: "王小明", changed: "2026-10-30T00:00:00Z", priority: 2 };
const DETAIL = {
  ...base,
  id: 42,
  title: "修正登入",
  state: "Active",
  kind: "Bug",
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
const URL = "https://ado.test/c/_apis/wit/attachments/abc?fileName=log.txt";

async function openItem(page) {
  await page.keyboard.press("Control+P");
  await page.locator("dialog[open] input").first().fill("#42");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
  await page.locator(".issue-pane .issue-body", { hasText: "說明" }).waitFor();
}

const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_work_item: DETAIL,
  ado_attachment_upload: URL,
};
const updates = async (page) => (await calls(page)).filter((c) => c.cmd === "ado_work_item_update").map((c) => c.args.change);

test("附件：沒有附件也有「加入附件…」，選檔案上傳後掛到工作項目", async () => {
  const { page, context, errors } = await open({ desktop });
  await openItem(page);
  const sec = page.locator('.ado-sec[data-kind="attachments"]');
  assert.match(await sec.textContent(), /還沒有附件/);
  const chooser = page.waitForEvent("filechooser");
  await sec.locator(".ado-attach-add").click();
  await (await chooser).setFiles([{ name: "log.txt", mimeType: "text/plain", buffer: Buffer.from("錯誤記錄") }]);
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_work_item_update"));
  assert.equal((await calls(page)).filter((c) => c.cmd === "ado_attachment_upload").length, 1);
  const [change] = await updates(page);
  assert.deepEqual(change.attachments, [URL]);
  assert.equal(change.rev, 3, "帶修訂版本");
  await page.waitForSelector(".toast", { hasText: "已加入附件「log.txt」" });
  assert.deepEqual(errors, []);
  await context.close();
});

test("附件：把檔案拖到工作項目上就加入附件，不會開成文件", async () => {
  const { page, context, errors } = await open({ desktop });
  await openItem(page);
  const tabs = await page.locator(".tab").count();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["a"], "a.txt", { type: "text/plain" }));
    dt.items.add(new File(["b"], "b.txt", { type: "text/plain" }));
    const target = document.querySelector(".issue-pane .issue-body");
    target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_work_item_update"));
  assert.equal((await calls(page)).filter((c) => c.cmd === "ado_attachment_upload").length, 2);
  assert.deepEqual((await updates(page))[0].attachments, [URL, URL]);
  await page.waitForSelector(".toast", { hasText: "已加入 2 個附件" });
  assert.equal(await page.locator(".tab").count(), tabs, "沒有開成新的文件分頁");
  assert.deepEqual(errors, []);
  await context.close();
});

test("附件：在留言框貼上圖片，上傳後插入圖片，送出的留言帶圖片", async () => {
  const img = "https://ado.test/c/_apis/wit/attachments/img1?fileName=image.png";
  const { page, context, errors } = await open({ desktop: { ...desktop, ado_attachment_upload: img } });
  await openItem(page);
  const box = page.locator(".ado-compose textarea").first();
  await box.click();
  await box.evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
  });
  await page.waitForFunction(() => document.querySelector(".ado-compose textarea")?.value.includes("![image-"));
  assert.match(await box.inputValue(), /!\[image-\d{8}-\d{6}\.png\]\(<https:\/\/ado\.test\/c\/_apis\/wit\/attachments\/img1\?fileName=image\.png>\)/);
  assert.equal((await updates(page)).length, 0, "貼上圖片不會掛成工作項目的附件");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_work_item_update"));
  const [change] = await updates(page);
  assert.match(change.comment, /<img [^>]*src="https:\/\/ado\.test\/c\/_apis\/wit\/attachments\/img1\?fileName=image\.png"/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("附件：PDF 直接開啟；.rdp 這類不在允許清單裡的類型（連結的檔名結尾多一個點也一樣）只能另存新檔", async () => {
  const pdf = "https://ado.test/c/_apis/wit/attachments/p1";
  const rdp = "https://ado.test/c/_apis/wit/attachments/r1";
  const created = "2026-10-29T03:00:00Z";
  const detail = {
    ...DETAIL,
    description: `<p>請看 <a href="${rdp}?fileName=${encodeURIComponent("遠端.rdp.")}">遠端連線</a></p>`,
    attachments: [
      { name: "規格書.pdf", url: pdf, size: 2048, created, comment: null },
      { name: "遠端.rdp", url: rdp, size: 512, created, comment: null },
    ],
  };
  const { page, context, errors } = await open({
    desktop: { ...desktop, ado_work_item: detail, ado_attachment_save: "C:\\Users\\me\\Downloads\\遠端.rdp" },
  });
  await openItem(page);
  const names = async (cmd) => (await calls(page)).filter((c) => c.cmd === cmd).map((c) => c.args.name);
  const count = (cmd, n) => page.waitForFunction(([cmd, n]) => window.__fake.calls.filter((c) => c.cmd === cmd).length === n, [cmd, n]);
  const tiles = page.locator(".ado-att");

  // PDF：點小方塊就下載後用預設的程式開啟。
  await tiles.filter({ hasText: "規格書.pdf" }).click();
  await count("ado_attachment_open", 1);
  assert.deepEqual(await names("ado_attachment_open"), ["規格書.pdf"]);

  // .rdp：小方塊寫明只能另存，點了是另存新檔。
  const rdpTile = tiles.filter({ hasText: "遠端.rdp" });
  assert.match(await rdpTile.getAttribute("title"), /另存新檔（為了安全不直接開啟）/);
  await rdpTile.click();
  await count("ado_attachment_save", 1);
  assert.deepEqual(await names("ado_attachment_save"), ["遠端.rdp"]);

  // 說明裡連到 .rdp 附件的連結：不開啟，提示改用另存新檔。
  await page.locator(".issue-body a", { hasText: "遠端連線" }).click();
  const tip = page.locator(".toast", { hasText: "為了安全不直接開啟" });
  await tip.waitFor();
  assert.match(await tip.textContent(), /直接開啟的只有 PDF/);
  await tip.locator("button", { hasText: "另存新檔" }).click();
  await count("ado_attachment_save", 2);
  assert.deepEqual(await names("ado_attachment_save"), ["遠端.rdp", "遠端.rdp."]);
  assert.deepEqual(await names("ado_attachment_open"), ["規格書.pdf"], "只有 PDF 直接開啟");
  assert.deepEqual(errors, []);
  await context.close();
});
