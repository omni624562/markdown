/**
 * 助理讀指定網頁（app/assistant.ts）：問題裡打了網址，而且設定開了「允許上網查資料」，就出現「讀網頁：網域」的標籤，
 * 送出時帶著那幾個網域（原生端只允許讀這些網域）；按 × 這一題就不讀；設定沒開時標籤是去設定開啟的入口；
 * 文件內容裡的網址不算。用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\旅遊";
const desktop = (settings = {}) => ({
  startup_target: { kind: "folder", path: ROOT, name: "旅遊" },
  list_dir: { $by: "path", values: { [ROOT]: [] } },
  load_settings: JSON.stringify({ claudeApiEnabled: true, assistantProjects: [ROOT], assistantConfirmed: [ROOT], ...settings }),
  assistant_key_status: true,
  assistant_usage: { month: "2026-11", usd: 0, limit: 10 },
});
const sends = async (page) => (await calls(page)).filter((c) => c.cmd === "assistant_send").map((c) => c.args.request);
async function setup(settings) {
  const opened = await open({ desktop: desktop(settings) });
  const { page } = opened;
  await page.locator(".cm-content").focus();
  // 文件裡也有網址：不會因此去讀。
  await page.keyboard.insertText("# 行程\n\n參考 https://other.test/guide 的說明。\n");
  await page.keyboard.press("Control+Shift+L");
  await page.locator("#assistant-panel textarea").waitFor();
  return opened;
}
const chipTexts = (page) => page.locator("#assistant-panel .assistant-chips .assistant-chip").allTextContents();
const done = (page, n) =>
  page.evaluate((n) => {
    const id = window.__fake.calls.filter((c) => c.cmd === "assistant_send")[n - 1].args.id;
    window.__fake.emit("assistant-run", { kind: "delta", id, text: "好的。" });
    window.__fake.emit("assistant-run", { kind: "done", id, usd: 0.01, monthUsd: 0.01, stop: null });
  }, n);

test("問題裡有網址：出現「讀網頁」的標籤，送出時只帶問題裡的網域；按 × 這一題不讀，下一題恢復", async () => {
  const { page, context, errors } = await setup({ claudeWebSearch: true });
  const input = page.locator("#assistant-panel textarea");
  assert.ok(!(await chipTexts(page)).some((c) => c.includes("讀網頁")), "還沒打網址：沒有標籤（文件裡的網址不算）");
  await input.fill("整理 https://Example.test/news?id=3 的重點");
  await page.locator(".assistant-chip", { hasText: "讀網頁：example.test" }).waitFor();
  await input.press("Enter");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "assistant_send"));
  const first = (await sends(page))[0];
  assert.deepEqual(first.webFetch, ["example.test"]);
  assert.equal(first.webSearch, false);
  await done(page, 1);

  // 按 ×：這一題不讀；標籤變成「讀問題裡的網頁」可以加回來。
  await input.fill("https://example.test/a 和 https://docs.example.test/b 差在哪？");
  const chip = page.locator(".assistant-chip", { hasText: "讀 2 個網站的網頁" });
  await chip.waitFor();
  await chip.locator(".assistant-chip-x").click();
  await page.locator(".assistant-chip-add", { hasText: "讀問題裡的網頁" }).waitFor();
  await input.press("Enter");
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "assistant_send").length === 2);
  assert.deepEqual((await sends(page))[1].webFetch, []);
  await done(page, 2);

  // 下一題恢復會讀。
  await input.fill("再看一次 https://example.test/a");
  await page.locator(".assistant-chip", { hasText: "讀網頁：example.test" }).waitFor();
  await input.press("Enter");
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "assistant_send").length === 3);
  assert.deepEqual((await sends(page))[2].webFetch, ["example.test"]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("設定沒開「允許上網查資料」：標籤是去設定開啟的入口，送出時不帶網域", async () => {
  const { page, context, errors } = await setup({ claudeWebSearch: false });
  const input = page.locator("#assistant-panel textarea");
  await input.fill("整理 https://example.test/news 的重點");
  const hint = page.locator(".assistant-chip-add", { hasText: "讀網頁要先在設定開啟" });
  await hint.waitFor();
  await input.press("Enter");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "assistant_send"));
  assert.deepEqual((await sends(page))[0].webFetch, []);
  await done(page, 1);
  await input.fill("https://example.test/news");
  await hint.click();
  await page.locator("dialog[open]", { hasText: "允許上網查資料" }).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});
