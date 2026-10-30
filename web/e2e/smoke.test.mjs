/**
 * 網頁版的冒煙測試：用 Playwright 開啟建置好的 dist/，確認主要流程沒有壞掉。
 * 先執行 `npm run build`，再 `npm run test:e2e`（第一次要 `npx playwright install chromium`）。
 *
 * 不啟動伺服器：攔截瀏覽器的請求，直接回應 dist/ 裡的檔案；其他網址一律擋掉（也確認不會連到外部）。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const ORIGIN = "http://omarker.test";
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

let browser;
before(async () => {
  assert.ok(existsSync(join(DIST, "index.html")), "請先執行 npm run build");
  browser = await chromium.launch();
});
after(() => browser?.close());

/** 開一個新頁面；回傳頁面、頁面上的錯誤，以及被擋下的外部請求。 */
async function open() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-TW" });
  const page = await context.newPage();
  const errors = [];
  const external = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      external.push(url.href);
      return route.abort();
    }
    const file = join(DIST, decodeURIComponent(url.pathname));
    if (!existsSync(file) || url.pathname.endsWith("/")) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
  await page.goto(`${ORIGIN}/index.html`);
  await page.waitForSelector(".cm-editor .cm-content");
  return { page, context, errors, external };
}

/** 把編輯器的內容換成 `text`。 */
async function setText(page, text) {
  await page.click(".cm-content");
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(text);
}

const view = (page, name) => page.click(`button[data-view="${name}"]`);

test("開啟後沒有錯誤，也不會連到外部網站", async () => {
  const { context, errors, external } = await open();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await context.close();
});

test("編輯後預覽跟著更新，四種檢視都能切換", async () => {
  const { page, context, errors } = await open();
  await setText(page, "# 煙霧測試\n\n這是**粗體**與 `程式碼`。\n\n- [ ] 待辦一\n- [x] 待辦二\n");
  for (const name of ["editor", "live", "split", "preview"]) {
    await view(page, name);
    // 即時預覽也是編輯區（.workspace 的 data-view 是 editor），看切換按鈕的狀態。
    assert.equal(await page.getAttribute(`button[data-view="${name}"]`, "aria-checked"), "true", name);
  }
  await page.waitForFunction(() => document.querySelector("#preview h1")?.textContent === "煙霧測試");
  assert.equal(await page.textContent("#preview strong"), "粗體");
  assert.equal(await page.locator('#preview input[type="checkbox"]').count(), 2);
  // 改一個字，預覽也要更新（增量更新）。
  await view(page, "split");
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n## 新段落\n");
  await page.waitForFunction(() => [...document.querySelectorAll("#preview h2")].some((h) => h.textContent === "新段落"));
  assert.deepEqual(errors, []);
  await context.close();
});

test("即時預覽直接顯示表格與公式", async () => {
  const { page, context, errors } = await open();
  await view(page, "live");
  await setText(page, "第一段\n\n| 名稱 | 數量 |\n|---|---|\n| 蘋果 | 3 |\n\n$$E=mc^2$$\n\n最後一段");
  await page.keyboard.press("Control+Home");
  await page.waitForSelector(".cm-content table");
  assert.match(await page.textContent(".cm-content table"), /蘋果/);
  await page.waitForSelector(".cm-content .katex");
  assert.deepEqual(errors, []);
  await context.close();
});

test("重新整理後還原分頁與沒存的內容", async () => {
  const { page, context, errors } = await open();
  await setText(page, "# 還原測試\n\n沒存檔的內容");
  // 等草稿寫入（停手一下才寫）。
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForSelector(".cm-editor .cm-content");
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("沒存檔的內容"));
  assert.deepEqual(errors, []);
  await context.close();
});

test("指令面板可以找到指令並執行", async () => {
  const { page, context, errors } = await open();
  await page.click(".cm-content");
  await page.keyboard.press("Control+Shift+P");
  const input = page.locator("dialog[open] input").first();
  await input.waitFor();
  await input.fill("預覽");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  assert.deepEqual(errors, []);
  await context.close();
});
