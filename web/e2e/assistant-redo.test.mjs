/**
 * 助理的「重新產生」與「編輯問題」（app/assistant.ts）：最新的回答下面有「重新產生」，按了把那一組問答拿掉、
 * 再送一次同樣的問題（對話紀錄裡不留舊的回答）；最新的問題旁邊有「編輯」，按了把問題放回輸入框、拿掉那一組問答。
 * 只有最新的一組有這兩個按鈕。用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
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
      window.__fake.emit("assistant-run", { kind: "done", id, usd: 0.01, monthUsd: 0.01 * n, stop: null });
    },
    [n, text],
  );
const texts = (page, role) => page.locator(`#assistant-panel .assistant-${role} `).evaluateAll((els) => els.map((el) => (el.querySelector(".assistant-answer") ?? el).textContent.trim()));

test("重新產生：拿掉舊的回答再送一次同樣的問題；編輯：問題回到輸入框；只有最新的一組有按鈕", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText("# 行程\n\n第一天搭地鐵。\n");
  await page.keyboard.press("Control+Shift+L");
  const input = page.locator("#assistant-panel textarea");
  await input.waitFor();
  await input.fill("第一天怎麼去？");
  await input.press("Enter");
  await sent(page, 1);
  await reply(page, 1, "搭地鐵。");
  const redo = page.locator("#assistant-panel .assistant-redo");
  const edit = page.locator("#assistant-panel .assistant-edit");
  await redo.waitFor();
  assert.match(await redo.getAttribute("title"), /再計費一次/);

  // 第二題之後，按鈕只在最新的那一組。
  await input.fill("要多久？");
  await input.press("Enter");
  await sent(page, 2);
  await reply(page, 2, "大約半小時。");
  await page.locator("#assistant-panel .assistant-assistant", { hasText: "大約半小時。" }).locator(".assistant-redo").waitFor();
  assert.equal(await redo.count(), 1);
  assert.equal(await edit.count(), 1);

  // 重新產生：送出的對話裡沒有舊的回答，問題一樣。
  await redo.click();
  await sent(page, 3);
  const third = (await sends(page))[2].messages;
  assert.deepEqual(
    third.map((m) => m.content),
    ["第一天怎麼去？", "搭地鐵。", "要多久？"],
  );
  assert.equal(await page.locator("#assistant-panel .assistant-assistant", { hasText: "大約半小時。" }).count(), 0);
  await reply(page, 3, "約四十分鐘。");
  await page.locator("#assistant-panel .assistant-assistant", { hasText: "約四十分鐘。" }).locator(".assistant-redo").waitFor();
  assert.deepEqual(await texts(page, "user"), ["第一天怎麼去？", "要多久？"]);

  // 編輯：問題回到輸入框，那一組問答拿掉；改了再送，對話接在第一組後面。
  await edit.click();
  assert.equal(await input.inputValue(), "要多久？");
  assert.equal(await input.evaluate((el) => el === document.activeElement), true);
  assert.deepEqual(await texts(page, "user"), ["第一天怎麼去？"]);
  assert.equal(await redo.count(), 0, "剩下的那一組不是「最近一次」，沒有按鈕");
  await input.fill("搭計程車要多久？");
  await input.press("Enter");
  await sent(page, 4);
  assert.deepEqual(
    (await sends(page))[3].messages.map((m) => m.content),
    ["第一天怎麼去？", "搭地鐵。", "搭計程車要多久？"],
  );
  assert.deepEqual(errors, []);
  await context.close();
});

test("動作（摘要）的回答可以重新產生，但沒有「編輯」", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText("# 行程\n\n第一天搭地鐵。\n");
  await page.keyboard.press("Control+Shift+L");
  await page.locator("#assistant-panel .assistant-quick button", { hasText: "摘要" }).click();
  await sent(page, 1);
  await reply(page, 1, "- 搭地鐵");
  await page.locator("#assistant-panel .assistant-redo").waitFor();
  assert.equal(await page.locator("#assistant-panel .assistant-edit").count(), 0);
  await page.locator("#assistant-panel .assistant-redo").click();
  await sent(page, 2);
  const [a, b] = await sends(page);
  assert.equal(b.messages.at(-1).content, a.messages.at(-1).content);
  assert.equal(await page.locator("#assistant-panel .assistant-user").count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
});
