/**
 * 常駐與背景檢查（桌面版）：設定「一般」有「關閉視窗時縮到系統匣」（預設開啟）與「背景檢查間隔」（最短 10 分鐘）；
 * 系統匣的「立即檢查」馬上檢查工作項目與新版本；在背景時有新版本就跳出系統通知（同一版只通知一次）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const LATEST = { build: 900, version: "9.9.0", commit: "", date: "", notes: "", changes: "", url: "", sha256: "", signature: "" };
const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_work_items: [[]],
  update_check: { current: { version: "1.0.0", build: 1, commit: null, updatable: true }, latest: LATEST },
};

test("設定：背景執行（縮到系統匣預設開啟、檢查間隔 10／15／30／60 分鐘）", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.keyboard.press("Control+,");
  await page.locator("dialog[open].settings").waitFor();
  assert.equal(await page.locator("#setting-closeToTray").isChecked(), true);
  const options = await page.locator("#setting-backgroundCheck option").evaluateAll((list) => list.map((o) => o.value));
  assert.deepEqual(options, ["10", "15", "30", "60"]);
  assert.equal(await page.locator("#setting-backgroundCheck").inputValue(), "10");
  assert.deepEqual(errors, []);
  await context.close();
});

test("系統匣的「立即檢查」：馬上檢查工作項目與新版本；在背景時有新版本跳出系統通知，同一版只通知一次", async () => {
  const { page, context, errors } = await open({ desktop });
  // 模擬 oMarker 藏到系統匣：網頁看不到焦點。
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.hasFocus = () => false;
  });
  const before = (await calls(page)).length;
  await page.evaluate(() => window.__fake.emit("tray-check", null));
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "notify_app_update"));
  const after = (await calls(page)).slice(before).map((c) => c.cmd);
  assert.ok(after.includes("ado_work_items"), `有檢查工作項目：${after}`);
  assert.ok(after.includes("update_check"), "有檢查新版本");
  assert.deepEqual((await calls(page)).find((c) => c.cmd === "notify_app_update").args, { version: "9.9.0" });
  await page.evaluate(() => window.__fake.emit("tray-check", null));
  await page.waitForTimeout(300);
  assert.equal((await calls(page)).filter((c) => c.cmd === "notify_app_update").length, 1, "同一版只通知一次");
  assert.deepEqual(errors, []);
  await context.close();
});

test("設定：新版本另外設定多久檢查一次（每 12 小時、每天、每週，預設每天）", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.keyboard.press("Control+,");
  await page.locator("dialog[open].settings").waitFor();
  const options = await page.locator("#setting-updateCheck option").evaluateAll((list) => list.map((o) => o.value));
  assert.deepEqual(options, ["12", "24", "168"]);
  assert.equal(await page.locator("#setting-updateCheck").inputValue(), "24");
  assert.deepEqual(errors, []);
  await context.close();
});

test("開著的 Wiki 分頁被別人改了：背景檢查只問版本，在背景時跳出通知（同一次修改只通知一次）", async () => {
  const WIKI = { id: "w1", name: "Contoso.wiki", project: "Contoso", projectId: "p1", code: false, repositoryId: "r1", mappedPath: "/", version: "wikiMaster", webUrl: "https://ado.test/c/Contoso/_wiki/wikis/Contoso.wiki" };
  const { page, context, errors } = await open({
    desktop: {
      ...desktop,
      ado_wikis: [[WIKI]],
      ado_wiki_pages: [[{ path: "/安裝說明", id: 1, children: [] }]],
      ado_wiki_page: { content: "# 安裝說明\n\n步驟", webUrl: null, etag: "v1" },
      ado_wiki_page_etag: "v2",
    },
  });
  await page.click("#side-tab-wiki");
  await page.click('#wiki-host .wiki-page[data-path="/安裝說明"]');
  await page.locator(".issue-body", { hasText: "步驟" }).waitFor();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.hasFocus = () => false;
  });
  await page.evaluate(() => window.__fake.emit("tray-check", null));
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "notify_wiki_pages"));
  assert.deepEqual((await calls(page)).find((c) => c.cmd === "notify_wiki_pages").args, { pages: ["安裝說明"] });
  assert.equal((await calls(page)).filter((c) => c.cmd === "ado_wiki_page").length, 1, "背景檢查只問版本，不讀內容");
  await page.evaluate(() => window.__fake.emit("tray-check", null));
  await page.waitForTimeout(300);
  assert.equal((await calls(page)).filter((c) => c.cmd === "notify_wiki_pages").length, 1, "同一次修改只通知一次");
  assert.deepEqual(errors, []);
  await context.close();
});
