/**
 * 助理的對話續接（app/assistant.ts、assistant-chat-store.ts）：每個專案留最近一次的對話。重開程式後打開助理，
 * 上次的問答還在，接著問時帶著之前的對話；按「新對話」清掉，下次打開就是空的。
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
const sent = (page, n) => page.waitForFunction((n) => window.__fake.calls.filter((c) => c.cmd === "assistant_send").length === n, n);
const reply = (page, n, text) =>
  page.evaluate(
    ([n, text]) => {
      const id = window.__fake.calls.filter((c) => c.cmd === "assistant_send")[n - 1].args.id;
      window.__fake.emit("assistant-run", { kind: "delta", id, text });
      window.__fake.emit("assistant-run", { kind: "done", id, usd: 0.01, monthUsd: 0.01, stop: null });
    },
    [n, text],
  );
async function openAssistant(page) {
  await page.waitForFunction(() => document.querySelector("#folder-name")?.textContent === "旅遊");
  await page.locator(".cm-content").waitFor();
  // 重開之後右側欄可能還記得開著助理：已經開著就不要再按（再按一次會關掉）。
  await page.waitForTimeout(300);
  if (!(await page.locator("#assistant-panel textarea").isVisible())) {
    await page.locator(".cm-content").focus();
    await page.keyboard.press("Control+Shift+L");
  }
  await page.locator("#assistant-panel textarea").waitFor();
}

test("重開程式後上次的對話還在，接著問時帶著之前的對話；按「新對話」就清掉", async () => {
  const { page, context, errors } = await open({ desktop });
  await openAssistant(page);
  const input = page.locator("#assistant-panel textarea");
  assert.equal(await page.locator("#assistant-panel .assistant-restored").count(), 0);
  await input.fill("第一天怎麼去？");
  await input.press("Enter");
  await sent(page, 1);
  await reply(page, 1, "搭**地鐵**。");
  await page.locator("#assistant-panel .assistant-redo").waitFor();

  // 重開：對話還在（問題、回答、回答下面的按鈕），最上面說明是上次的對話。
  await page.reload();
  await openAssistant(page);
  const panel = page.locator("#assistant-panel");
  await panel.locator(".assistant-restored").waitFor();
  assert.equal(await panel.locator(".assistant-user").textContent(), "第一天怎麼去？");
  assert.equal(await panel.locator(".assistant-assistant .assistant-answer strong").textContent(), "地鐵");
  assert.equal(await panel.locator(".assistant-assistant .assistant-tool", { hasText: "複製" }).count(), 1);
  // 接著問：送出的對話裡有上次的問答。
  await panel.locator("textarea").fill("要多久？");
  await panel.locator("textarea").press("Enter");
  await sent(page, 1);
  const messages = (await sends(page))[0].messages.map((m) => m.content);
  assert.deepEqual(messages.slice(0, 2), ["第一天怎麼去？", "搭**地鐵**。"]);
  assert.match(messages[2], /要多久？$/);
  assert.equal(messages.length, 3);
  await reply(page, 1, "半小時。");
  await panel.locator(".assistant-redo").waitFor();

  // 新對話：清掉；再重開也是空的。
  await panel.getByRole("button", { name: "新對話" }).click();
  assert.equal(await panel.locator(".assistant-msg").count(), 0);
  await page.reload();
  await openAssistant(page);
  await page.locator("#assistant-panel textarea").waitFor();
  assert.equal(await page.locator("#assistant-panel .assistant-msg").count(), 0);
  assert.equal(await page.locator("#assistant-panel .assistant-restored").count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
