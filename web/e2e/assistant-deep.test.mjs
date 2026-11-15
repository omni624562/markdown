/**
 * 助理的「深入思考」開關（app/assistant.ts）：平常關著（快、便宜）；按輸入框上方的「＋ 深入思考」打開，
 * 之後送出的問題都帶著 deep，直到按標籤上的 × 關掉。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\旅遊";
const desktop = {
  startup_target: { kind: "folder", path: ROOT, name: "旅遊" },
  list_dir: { $by: "path", values: { [ROOT]: [] } },
  load_settings: JSON.stringify({ claudeApiEnabled: true, assistantProjects: [ROOT], assistantConfirmed: [ROOT] }),
  assistant_key_status: true,
  assistant_usage: { month: "2026-11", usd: 0, limit: 10 },
};
const sends = async (page) => (await calls(page)).filter((c) => c.cmd === "assistant_send").map((c) => c.args.request);
const ask = async (page, text, n) => {
  await page.locator("#assistant-panel textarea").fill(text);
  await page.locator("#assistant-panel textarea").press("Enter");
  await page.waitForFunction((n) => window.__fake.calls.filter((c) => c.cmd === "assistant_send").length === n, n);
  await page.evaluate((n) => {
    const id = window.__fake.calls.filter((c) => c.cmd === "assistant_send")[n - 1].args.id;
    window.__fake.emit("assistant-run", { kind: "delta", id, text: "好的。" });
    window.__fake.emit("assistant-run", { kind: "done", id, usd: 0.01, monthUsd: 0.01, stop: null });
  }, n);
  return (await sends(page))[n - 1];
};

test("深入思考：預設關著；打開後送出的問題帶著 deep，標籤說明比較慢、比較貴；按 × 關掉", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText("# 行程\n");
  await page.keyboard.press("Control+Shift+L");
  await page.locator("#assistant-panel textarea").waitFor();
  const add = page.locator("#assistant-panel .assistant-chip-add", { hasText: "深入思考" });
  await add.waitFor();
  assert.match(await add.getAttribute("title"), /比較慢.*費用也比較高/);
  assert.equal((await ask(page, "這個行程順嗎？", 1)).deep, false);

  await add.click();
  const on = page.locator("#assistant-panel .assistant-chip:not(.assistant-chip-add)", { hasText: "深入思考" });
  await on.waitFor();
  assert.equal(await add.count(), 0, "同一個選項不會出現兩次");
  assert.equal(await page.locator("#assistant-panel textarea").evaluate((el) => el === document.activeElement), true, "焦點回到輸入框");
  assert.equal((await ask(page, "有什麼風險？", 2)).deep, true);
  // 開著的時候下一題也是。
  assert.equal(await on.count(), 1);
  assert.equal((await ask(page, "還有嗎？", 3)).deep, true);

  await on.locator(".assistant-chip-x").click();
  await add.waitFor();
  assert.equal((await ask(page, "謝謝", 4)).deep, false);
  assert.deepEqual(errors, []);
  await context.close();
});
