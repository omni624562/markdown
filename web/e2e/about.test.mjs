/**
 * 「設定」→「關於」：標語、「複製版本資訊」、「回報」開 GitHub 新問題時帶著版本資訊；
 * 從「關於 oMarker」打開時焦點在「關於」上（不會留在「一般」）。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

/** 桌面版沒有開著的文件時是歡迎畫面：直接按快速鍵開指令面板。 */
async function command(page, query) {
  await page.keyboard.press("Control+Shift+P");
  await page.locator("dialog[open] input").first().fill(query);
  await page.keyboard.press("Enter");
}

const externals = async (page) => (await calls(page)).filter((c) => c.cmd === "open_external").map((c) => c.args.url);
const issueBody = (url) => decodeURIComponent(url.slice(url.indexOf("body=") + 5));

test("關於：焦點在「關於」、新的標語、複製版本資訊、回報時帶著版本資訊", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  // 測試用的網址不是安全來源，沒有剪貼簿：換成記下內容的假剪貼簿（桌面版有真的剪貼簿）。
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => void (window.__copied = text) } });
  });
  await command(page, "關於 oMarker");
  const selected = page.locator("dialog[open] [role=tab][aria-selected=true]");
  await selected.filter({ hasText: "關於" }).waitFor();
  // 焦點跟著到「關於」，不會留在第一個分類「一般」上（看起來像選了兩個）。
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "關於");

  const section = page.locator("dialog[open] section:not([hidden])");
  assert.equal(await section.locator(".settings-about p").textContent(), "給中文寫作與團隊協作的 Markdown 編輯器：專案、Git、Azure DevOps 與 AI");

  // 「複製版本資訊」在「檢查更新」旁邊。
  const buttons = await section.locator("#setting-version button").allTextContents();
  assert.deepEqual(buttons, ["複製版本資訊", "檢查更新"]);
  await page.click("#setting-copy-version");
  await page.locator(".toast", { hasText: "已複製版本資訊" }).waitFor();
  const info = await page.evaluate(() => window.__copied);
  // 自行編譯的版本（假原生端）：沒有更新管道，第二行寫「自行編譯」，第三行是系統與顯示核心。
  const lines = info.split("\n");
  assert.equal(lines[0], "oMarker 0.0.0");
  assert.equal(lines[1], "自行編譯");
  assert.match(lines[2], /^\S.*・\S/);

  // 「回報」：開 GitHub 的新問題，內文最後是同樣的版本資訊。
  await section.locator("#setting-report").click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "open_external"));
  const [url] = await externals(page);
  assert.ok(url.startsWith("https://github.com/omni624562/markdown/issues/new?body="), url);
  assert.ok(issueBody(url).endsWith(`---\n${info}`), issueBody(url));
  assert.match(issueBody(url), /請不要貼上公司的文件內容/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("「☰」→「說明」→「回報問題或建議」也帶著版本資訊", async () => {
  const { page, context, errors } = await open({ desktop: {} });
  await command(page, "回報問題或建議");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "open_external"));
  const [url] = await externals(page);
  assert.match(issueBody(url), /---\noMarker 0\.0\.0\n/);
  assert.deepEqual(errors, []);
  await context.close();
});
