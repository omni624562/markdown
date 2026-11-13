/**
 * 網頁檔（.html、.htm）的預覽：狀態列有原始碼、分割、預覽；預覽照網頁本身的樣子顯示（iframe，不執行腳本）。
 * 其他程式碼檔（.css 等）只有原始碼。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const HTML = "<!doctype html><html><head><title>報價單</title><style>h1 { color: rgb(200, 0, 0); }</style></head>\n<body><h1>Contoso 報價單</h1><p>聯絡人：王小明</p></body></html>";
const FILE = { kind: "file", path: "/notes/報價單.html", name: "報價單.html", text: HTML, encoding: "utf-8" };

const shownViews = (page) => page.$$eval(".view-switch:not([hidden]) [data-view]:not([hidden])", (bs) => bs.map((b) => b.dataset.view));

test("網頁檔：狀態列有原始碼、分割、預覽；預覽照網頁本身的樣子顯示", async () => {
  const { page, context, errors } = await open({ desktop: { startup_target: FILE } });
  await page.locator("#tab-bar .tab", { hasText: "報價單.html" }).waitFor();
  // 網頁檔沒有即時預覽：等狀態列換成這份文件的模式。
  await page.locator('.view-switch [data-view="live"]').waitFor({ state: "hidden" });
  assert.deepEqual(await shownViews(page), ["editor", "split", "preview"]);
  await page.locator('button[data-view="preview"]').click();
  const h1 = page.frameLocator("iframe.html-preview").locator("h1", { hasText: "Contoso 報價單" });
  await h1.waitFor();
  // 網頁自己的樣式照樣套用。
  assert.equal(await h1.evaluate((el) => getComputedStyle(el).color), "rgb(200, 0, 0)");
  // 指令面板也有同樣的模式。
  await page.keyboard.press("Control+Shift+P");
  const input = page.locator("dialog[open] input").first();
  await input.waitFor();
  await input.fill("分割");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  assert.ok((await page.locator("dialog[open] [role=option] .palette-title").allTextContents()).some((t) => /分割/.test(t)));
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  await context.close();
});

test("其他程式碼檔（.css）只有原始碼，狀態列不顯示檢視切換", async () => {
  const css = { kind: "file", path: "/notes/style.css", name: "style.css", text: "h1 { color: red; }\n", encoding: "utf-8" };
  const { page, context, errors } = await open({ desktop: { startup_target: css } });
  await page.locator("#tab-bar .tab", { hasText: "style.css" }).waitFor();
  await page.locator(".view-switch").waitFor({ state: "hidden" });
  assert.deepEqual(await shownViews(page), []);
  assert.deepEqual(errors, []);
  await context.close();
});
