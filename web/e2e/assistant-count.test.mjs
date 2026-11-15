/**
 * 助理送出前估算（app/assistant.ts）：輸入區的計算機按鈕問 Claude API 這一題準確的輸入 token 數，
 * 在輸入框上方顯示 token 數與輸入費用；不產生回答、問題留在輸入框；問題改了就收起來；沒輸入時提示；
 * 估算失敗時顯示原因。用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\旅遊";
const desktop = (extra) => ({
  startup_target: { kind: "folder", path: ROOT, name: "旅遊" },
  list_dir: { $by: "path", values: { [ROOT]: [] } },
  load_settings: JSON.stringify({ claudeApiEnabled: true, assistantProjects: [ROOT], assistantConfirmed: [ROOT] }),
  assistant_key_status: true,
  assistant_usage: { month: "2026-11", usd: 0, limit: 10 },
  ...extra,
});
async function setup(extra) {
  const opened = await open({ desktop: desktop(extra) });
  const { page } = opened;
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText("# 行程\n\n第一天搭地鐵。\n");
  await page.keyboard.press("Control+Shift+L");
  await page.locator("#assistant-panel textarea").waitFor();
  return opened;
}
const count = (page) => page.locator("#assistant-panel .assistant-count:not([hidden])");

test("按計算機估算：顯示準確的 token 數與輸入費用，不送出問題；問題改了就收起來；沒輸入時提示", async () => {
  const { page, context, errors } = await setup({ assistant_count: { tokens: 12345, usd: 0.0247 } });
  const input = page.locator("#assistant-panel textarea");
  const button = page.locator("#assistant-panel .assistant-count-btn");
  assert.match(await button.getAttribute("title"), /內容會送到 Anthropic 計算.*不收費/);
  // 沒輸入：提示，不問原生端。
  await button.click();
  await page.locator(".toast", { hasText: "先輸入問題" }).waitFor();
  assert.equal((await calls(page)).filter((c) => c.cmd === "assistant_count").length, 0);

  await input.fill("這個行程順嗎？");
  await button.click();
  await count(page).waitFor();
  await page.waitForFunction(() => /12,345/.test(document.querySelector("#assistant-panel .assistant-count").textContent));
  assert.match(await count(page).textContent(), /12,345 個 token，約 US\$0\.02（回答的費用另計）/);
  // 送去估算的內容和要送出的一樣（文件、問題、模型）；沒有真的送出，問題還在輸入框。
  const sent = (await calls(page)).filter((c) => c.cmd === "assistant_count").map((c) => c.args.request);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].model, "claude-sonnet-5-5");
  assert.match(sent[0].messages.at(-1).content, /第一天搭地鐵。[\s\S]*這個行程順嗎？$/);
  assert.equal((await calls(page)).filter((c) => c.cmd === "assistant_send").length, 0);
  assert.equal(await input.inputValue(), "這個行程順嗎？");
  assert.equal(await page.locator("#assistant-panel .assistant-user").count(), 0);

  // 問題改了：數字不準了，收起來。
  await input.pressSequentially("再");
  assert.equal(await count(page).count(), 0);
  // 估算完再送出：照常送出。
  await button.click();
  await count(page).waitFor();
  await input.press("Enter");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "assistant_send"));
  assert.equal(await count(page).count(), 0, "送出後收起來");
  assert.deepEqual(errors, []);
  await context.close();
});

test("估算失敗：在同一個位置顯示原因，按鈕可以再按", async () => {
  const { page, context } = await setup({ assistant_count: { $error: "這個月已經用了 US$10.00，到達上限 US$10.00；可以在設定調高上限" } });
  await page.locator("#assistant-panel textarea").fill("這個行程順嗎？");
  const button = page.locator("#assistant-panel .assistant-count-btn");
  await button.click();
  await page.waitForFunction(() => /到達上限/.test(document.querySelector("#assistant-panel .assistant-count").textContent));
  assert.equal(await count(page).evaluate((el) => el.classList.contains("error")), true);
  assert.equal(await button.isDisabled(), false);
  await context.close();
});
