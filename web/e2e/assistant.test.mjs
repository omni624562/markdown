/**
 * Claude API 助理側欄：設定關閉（預設）時叫不出來；開啟、有金鑰、專案允許時，第一次送出先確認，
 * 改寫選取的文字變成建議卡片（按「套用」才改文件），一般問題的回答可以插入到游標處；
 * 專案還沒允許時只顯示提示與「允許這個專案使用 AI」。
 * 用假的原生端（見 helpers.mjs），回覆用 `assistant-run` 事件模擬。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open, setText } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\個人筆記";
const project = { path: ROOT, label: "個人筆記", name: null, color: "green", group: null, pinned: false, lastOpened: 0 };
const desktop = (settings) => ({
  load_settings: settings ? JSON.stringify(settings) : null,
  projects_list: [[project]],
  reopen_folder: { path: ROOT, name: "個人筆記" },
  list_dir: [[]],
  assistant_key_status: true,
  assistant_usage: { month: "2026-11", usd: 0.42, limit: 10 },
});
const ON = { claudeApiEnabled: true, assistantProjects: [ROOT] };

async function openProject(page) {
  await page.locator(".empty-state .start-recent-item", { hasText: "個人筆記" }).click();
  await page.waitForFunction(() => document.querySelector("#folder-name").textContent === "個人筆記");
}

const sends = async (page) => (await calls(page)).filter((c) => c.cmd === "assistant_send").map((c) => c.args);

/** 模擬原生端回覆最近一次送出的要求。 */
async function reply(page, text) {
  const [{ id }] = (await sends(page)).slice(-1);
  await page.evaluate(
    ([id, text]) => {
      window.__fake.emit("assistant-run", { kind: "delta", id, text });
      window.__fake.emit("assistant-run", { kind: "done", id, usd: 0.01, monthUsd: 0.43, stop: null });
    },
    [id, text],
  );
}

test("設定關閉（預設）時叫不出助理", async () => {
  const { page, context, errors } = await open({ desktop: desktop(null) });
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+Shift+L");
  await page.waitForTimeout(200);
  assert.equal(await page.locator("#assistant-panel:not([hidden])").count(), 0);
  assert.ok(!(await calls(page)).some((c) => c.cmd.startsWith("assistant_send")));
  assert.deepEqual(errors, []);
  await context.close();
});

test("改寫選取的文字：第一次先確認，回答變成建議卡片，按「套用」才取代", async () => {
  const { page, context, errors } = await open({ desktop: desktop(ON) });
  await openProject(page);
  await page.keyboard.press("Control+N");
  await page.locator(".cm-content").waitFor({ state: "visible" });
  await setText(page, "我們下週要討論 NAS 備份的事情。");
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Control+Shift+L");
  const panel = page.locator("#assistant-panel");
  await panel.waitFor();
  assert.match(await panel.locator(".assistant-usage").textContent(), /US\$0\.42 \/ US\$10$/);
  const chips = await panel.locator(".assistant-chip").allTextContents();
  assert.ok(chips.some((c) => c.includes("選取的文字")), chips.join("|"));

  await panel.locator(".assistant-quick button", { hasText: "改寫" }).click();
  const confirm = page.locator("dialog.choice[open]");
  await confirm.waitFor();
  assert.match(await confirm.textContent(), /Anthropic/);
  await confirm.getByRole("button", { name: "送出" }).click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "assistant_send"));
  const [{ request }] = await sends(page);
  assert.equal(request.model, "claude-sonnet-5-5");
  assert.equal(request.messages.length, 1);
  assert.match(request.messages[0].content, /<selection>\n我們下週要討論 NAS 備份的事情。\n<\/selection>/);
  assert.match(request.system, /只輸出取代選取文字/);
  // 記住這個專案已經確認過。
  const saved = (await calls(page)).filter((c) => c.cmd === "save_settings").map((c) => JSON.parse(c.args.json));
  assert.deepEqual(saved.at(-1).assistantConfirmed, [ROOT]);

  await reply(page, "下週我們要討論 NAS 的備份方式。");
  const card = panel.locator(".assistant-card");
  await card.waitFor();
  assert.deepEqual(await card.locator(".assistant-diff > div").allTextContents(), ["- 我們下週要討論 NAS 備份的事情。", "+ 下週我們要討論 NAS 的備份方式。"]);
  // 還沒套用：文件沒變。
  assert.equal(await page.locator(".cm-content").textContent(), "我們下週要討論 NAS 備份的事情。");
  await card.getByRole("button", { name: "套用" }).click();
  assert.equal(await page.locator(".cm-content").textContent(), "下週我們要討論 NAS 的備份方式。");
  assert.match(await panel.locator(".assistant-usage").textContent(), /US\$0\.43/);

  // 一般問題：Enter 送出（已經確認過，不再問），回答可以插入到游標處。
  await panel.locator(".assistant-input textarea").fill("這份文件在講什麼？");
  await panel.locator(".assistant-input textarea").press("Enter");
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "assistant_send").length === 2);
  assert.equal(await page.locator("dialog.choice[open]").count(), 0);
  const second = (await sends(page))[1].request;
  assert.match(second.messages[0].content, /<document name="[^"]+">\n下週我們要討論 NAS 的備份方式。\n<\/document>/);
  assert.match(second.messages[0].content, /這份文件在講什麼？$/);
  await reply(page, "在講 **NAS 備份**。");
  const answer = panel.locator(".assistant-assistant").last();
  await answer.locator("strong", { hasText: "NAS 備份" }).waitFor();
  assert.equal(await answer.getByRole("button", { name: "插入到游標處" }).count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test("專案還沒允許：只顯示提示，按下去才允許", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ claudeApiEnabled: true }) });
  await openProject(page);
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+Shift+L");
  const panel = page.locator("#assistant-panel");
  await panel.waitFor();
  const notice = panel.locator(".assistant-notice");
  await notice.waitFor();
  assert.match(await notice.textContent(), /「個人筆記」還沒允許使用 AI/);
  assert.equal(await panel.locator(".assistant-input textarea").isDisabled(), true);
  await notice.getByRole("button", { name: "允許這個專案使用 AI" }).click();
  await page.waitForFunction(() => document.querySelector(".assistant-notice")?.hidden);
  assert.equal(await panel.locator(".assistant-input textarea").isDisabled(), false);
  const saved = (await calls(page)).filter((c) => c.cmd === "save_settings").map((c) => JSON.parse(c.args.json));
  assert.deepEqual(saved.at(-1).assistantProjects, [ROOT]);
  assert.deepEqual(errors, []);
  await context.close();
});
