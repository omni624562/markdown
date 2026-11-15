/**
 * 助理回答標出處（app/assistant-cites.ts）：一般問答時目前的文件送成可以標出處的區塊；回答裡每一段後面的編號
 * 按了會在編輯區選取那一段原文，滑鼠提示是原文；回答最後列出原文；文件改過找不到時提示；
 * 接著問時送回去的回答不帶標記。用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\旅遊";
const DOC = "# 行程\n\n第一天早上八點在車站集合。\n\n第二天搭地鐵到博物館。\n";
const desktop = {
  startup_target: { kind: "folder", path: ROOT, name: "旅遊" },
  list_dir: { $by: "path", values: { [ROOT]: [] } },
  load_settings: JSON.stringify({ claudeApiEnabled: true, assistantProjects: [ROOT], assistantConfirmed: [ROOT] }),
  assistant_key_status: true,
  assistant_usage: { month: "2026-11", usd: 0, limit: 10 },
};
const sends = async (page) => (await calls(page)).filter((c) => c.cmd === "assistant_send").map((c) => c.args.request);
const emit = (page, n, events) =>
  page.evaluate(
    ([n, events]) => {
      const id = window.__fake.calls.filter((c) => c.cmd === "assistant_send")[n - 1].args.id;
      for (const e of events) window.__fake.emit("assistant-run", { ...e, id });
    },
    [n, events],
  );
const selected = (page) => page.evaluate(() => window.getSelection().toString());

test("回答標出處：文件送成可以標出處的區塊；編號按了選取那一段原文；最後列出原文；接著問不帶標記", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText(DOC);
  await page.keyboard.press("Control+Shift+L");
  const input = page.locator("#assistant-panel textarea");
  await input.waitFor();
  await input.fill("什麼時候集合？怎麼去博物館？");
  await input.press("Enter");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "assistant_send"));
  const first = (await sends(page))[0].messages.at(-1);
  assert.equal(first.doc.text, DOC);
  assert.ok(first.doc.name);
  assert.equal(first.content, "什麼時候集合？怎麼去博物館？", "文件不再重複放在訊息裡");

  const cite1 = { text: "第一天早上八點在車站集合。\n", title: first.doc.name, start: 6, page: null };
  const cite2 = { text: "第二天搭地鐵到博物館。\n", title: first.doc.name, start: 21, page: null };
  await emit(page, 1, [
    { kind: "delta", text: "早上八點在車站集合。\n\n" },
    { kind: "cite", cites: [cite1] },
    { kind: "delta", text: "第二天搭地鐵去。" },
    { kind: "cite", cites: [cite2, cite1] },
    { kind: "done", usd: 0.01, monthUsd: 0.01, stop: null },
  ]);
  const answer = page.locator("#assistant-panel .assistant-assistant").last();
  const marks = answer.locator("p .assistant-cite");
  await answer.locator("li").first().waitFor();
  assert.deepEqual(await marks.allTextContents(), ["1", "2", "1"]);
  assert.match(await marks.first().getAttribute("title"), /「第一天早上八點在車站集合。」（按一下跳到這一段）/);
  // 最後列出每個編號的原文（清單裡的編號也可以按）。
  assert.match(await answer.textContent(), /出處/);
  assert.deepEqual(await answer.locator("li").allTextContents(), ["1 「第一天早上八點在車站集合。」", "2 「第二天搭地鐵到博物館。」"]);

  // 按編號：編輯區選取那一段。
  await marks.nth(1).click();
  await page.waitForFunction(() => window.getSelection().toString() === "第二天搭地鐵到博物館。");
  await answer.locator("li .assistant-cite").first().click();
  await page.waitForFunction(() => window.getSelection().toString() === "第一天早上八點在車站集合。");
  assert.equal(await selected(page), "第一天早上八點在車站集合。");

  // 接著問：送回去的上一則回答沒有標記和出處清單。
  await input.fill("那第三天呢？");
  await input.press("Enter");
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "assistant_send").length === 2);
  const second = (await sends(page))[1].messages;
  assert.equal(second[1].content, "早上八點在車站集合。\n\n第二天搭地鐵去。");
  assert.equal(second[0].doc, undefined, "文件只附在最新的問題");
  assert.equal(second.at(-1).doc.text, DOC);
  await emit(page, 2, [
    { kind: "delta", text: "文件裡沒有第三天。" },
    { kind: "done", usd: 0.01, monthUsd: 0.02, stop: null },
  ]);

  // 文件改過、原文不在了：提示找不到。
  await page.evaluate(() => {
    const content = document.querySelector(".cm-content");
    const tile = content.cmView ?? content.cmTile;
    const view = tile.view ?? tile.root.view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "# 新的行程\n" } });
  });
  await page.locator("#assistant-panel .assistant-cite").first().click();
  await page.locator(".toast", { hasText: "找不到這一段原文" }).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test("PDF 的出處顯示頁碼；會改文件的動作不標出處（文件照舊放在訊息裡）", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText(DOC);
  await page.keyboard.press("Control+Shift+L");
  const input = page.locator("#assistant-panel textarea");
  await input.waitFor();
  await input.fill("租期多久？");
  await input.press("Enter");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "assistant_send"));
  await emit(page, 1, [
    { kind: "delta", text: "租期一年。" },
    { kind: "cite", cites: [{ text: "本約租期為一年。", title: null, start: null, page: 3 }] },
    { kind: "done", usd: 0.01, monthUsd: 0.01, stop: null },
  ]);
  const answer = page.locator("#assistant-panel .assistant-assistant").last();
  await answer.locator("li").waitFor();
  assert.equal(await answer.locator("li").textContent(), "1 PDF 第 3 頁：「本約租期為一年。」");
  await answer.locator("p .assistant-cite").click();
  await page.locator(".toast", { hasText: "這一段在附上的 PDF 第 3 頁" }).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});
