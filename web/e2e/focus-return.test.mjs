/**
 * 焦點不會掉到 body：點分頁後可以直接打字；方向鍵可以連續切換分頁；改名後焦點留在分頁上；
 * 從工作項目回到文件（Esc、關掉分頁）、關閉並排後，游標回到編輯器。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, runCommand, setText } from "./helpers.mjs";

const inEditor = (page) => page.evaluate(() => !!document.activeElement?.closest(".cm-editor"));
const onTab = (page) => page.evaluate(() => document.activeElement?.closest("#tab-bar [role=tab]")?.textContent.trim() ?? null);
const tab = (page, name) => page.locator("#tab-bar .tab", { has: page.locator(".tab-name", { hasText: new RegExp(`^${name}$`) }) });

async function twoDocs(page) {
  await setText(page, "# 甲");
  await runCommand(page, "新增文件");
  await setText(page, "# 乙");
  await page.waitForFunction(() => [...document.querySelectorAll("#tab-bar .tab-name")].map((n) => n.textContent).join() === "甲,乙");
}

test("點分頁後可以直接打字；方向鍵連續切換；改名後焦點留在分頁上", async () => {
  const { page, context, errors } = await open();
  await twoDocs(page);
  await tab(page, "甲").click();
  assert.equal(await inEditor(page), true, "點分頁後游標在編輯器");
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("內文");
  assert.match(await page.locator(".cm-content").first().textContent(), /內文/);

  // 方向鍵：焦點留在分頁上，可以連續切換。
  await tab(page, "甲").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await onTab(page), "乙");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await onTab(page), "甲");
  assert.equal(await page.locator("#tab-bar .tab[aria-selected=true] .tab-name").textContent(), "甲");

  // 改名後焦點留在（重畫後的）分頁上。
  await tab(page, "乙").dblclick();
  const input = page.locator("#tab-bar input");
  await input.fill("丙");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll("#tab-bar .tab-name")].some((n) => n.textContent === "丙"));
  assert.equal(await onTab(page), "丙");
  assert.deepEqual(errors, []);
  await context.close();
});

test("關閉並排後游標回到左邊的編輯器", async () => {
  const { page, context, errors } = await open();
  await twoDocs(page);
  await runCommand(page, "把目前的文件移到右邊");
  await page.waitForSelector("#side-pane-head:not([hidden])");
  await page.locator("#tab-bar .tab-pair .tab-pair-close").click();
  await page.waitForSelector("#side-pane-head", { state: "hidden" });
  assert.equal(await inEditor(page), true);
  assert.deepEqual(errors, []);
  await context.close();
});

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

test("從工作項目回到文件（Esc、關掉工作項目的分頁）：游標回到編輯器", async () => {
  const { page, context, errors } = await open({ desktop: { ado_account: { url: "https://ado.test/c", name: "王小明" }, ado_work_item: ITEM } });
  await page.keyboard.press("Control+N");
  await setText(page, "# 週報");
  const openItem = async () => {
    await page.keyboard.press("Control+P");
    await page.locator("dialog[open] input").first().fill("#42");
    await page.locator("dialog[open] [role=option]").first().waitFor();
    await page.keyboard.press("Enter");
    await page.waitForSelector(".ado-hero h1");
  };
  await openItem();
  await page.locator(".ado-hero h1").click();
  await page.keyboard.press("Escape");
  await page.waitForSelector(".ado-hero h1", { state: "hidden" });
  assert.equal(await inEditor(page), true, "Esc 之後");
  await openItem();
  await page.locator(".ado-hero h1").click();
  await page.keyboard.press("Control+W");
  await page.waitForFunction(() => ![...document.querySelectorAll("#tab-bar .tab-name")].some((n) => n.textContent.includes("修正登入")));
  assert.equal(await inEditor(page), true, "關掉分頁之後");
  assert.deepEqual(errors, []);
  await context.close();
});
