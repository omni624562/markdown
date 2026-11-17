/**
 * 助理的輸入框（app/assistant-composer.ts）：下緣只有「＋」與送出；沒打開的選項不佔位置；
 * 還沒開始對話時常用動作排在輸入框上方，開始對話後收起來。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\旅遊";
const desktop = {
  startup_target: { kind: "folder", path: ROOT, name: "旅遊" },
  list_dir: { $by: "path", values: { [ROOT]: [] } },
  load_settings: JSON.stringify({ claudeApiEnabled: true, assistantProjects: [ROOT], assistantConfirmed: [ROOT], claudeWebSearch: true }),
  assistant_key_status: true,
  assistant_usage: { month: "2026-11", usd: 0, limit: 10 },
};

test("助理輸入框：下緣只有「＋」與送出；常用動作在對話還是空的時候顯示；「＋」選單有附加、估算、開關與寫作動作", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText("# 行程\n");
  await page.keyboard.press("Control+Shift+L");
  const panel = page.locator("#assistant-panel");
  await panel.locator("textarea").waitFor();
  assert.deepEqual(await panel.locator(".assistant-quick button:visible").evaluateAll((bs) => bs.map((b) => b.className)), [
    "assistant-plus",
    "btn icon-only btn-primary assistant-send",
  ]);
  // 目前的文件是預設打開的；上網查、深入思考沒打開，不佔位置。
  assert.deepEqual(await panel.locator(".assistant-chip").allTextContents(), ["行程"]);
  const suggest = panel.locator(".assistant-suggest");
  assert.deepEqual(await suggest.locator("button").allTextContents(), ["摘要", "改寫", "翻譯", "審稿", "更多…"]);

  await panel.locator("#assistant-plus").click();
  const menu = page.locator("#assistant-plus-popover");
  const items = await menu.getByRole("menuitem").allTextContents();
  assert.ok(items.some((s) => s.includes("附加圖片或 PDF")), items.join("|"));
  assert.ok(items.some((s) => s.includes("估算這一題的費用")), items.join("|"));
  assert.ok(items.some((s) => s.includes("寫作動作")), items.join("|"));
  const toggles = menu.getByRole("menuitemradio");
  assert.deepEqual(await toggles.allTextContents(), ["目前的文件", "上網查", "問整個專案", "深入思考"]);
  assert.equal(await menu.getByRole("menuitemradio", { name: "目前的文件" }).getAttribute("aria-checked"), "true");
  // 關掉目前的文件：標籤跟著拿掉，再打開回來。
  await menu.getByRole("menuitemradio", { name: "目前的文件" }).click();
  assert.equal(await panel.locator(".assistant-chip").count(), 0);
  await panel.locator("#assistant-plus").click();
  await menu.getByRole("menuitemradio", { name: "目前的文件" }).click();
  await panel.locator(".assistant-chip", { hasText: "行程" }).waitFor();

  // 送出後對話開始：常用動作收起來。
  await panel.locator("textarea").fill("這個行程順嗎？");
  await panel.locator("textarea").press("Enter");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "assistant_send"));
  assert.equal(await suggest.isVisible(), false);
  // 新對話：又出現。
  await panel.getByRole("button", { name: "新對話" }).click();
  await suggest.waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});
