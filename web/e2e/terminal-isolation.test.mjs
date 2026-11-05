/**
 * 終端機的頁面（桌面版的終端機 webview，`terminal.html`）只從自己交給 `term_ready` 的 Channel 收資料，
 * 不收聽 Tauri 的全域事件：主畫面萬一被注入程式碼，既讀不到終端機的輸出，也不能假冒要求或要同意的指令。
 * 用假的原生端（見 helpers.mjs）：`window.__fake.channel` 模擬原生端從 Channel 送來的訊息，
 * `window.__fake.emit` 模擬全域事件（主畫面也能收聽、送出的那一種）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const CWD = "C:\\Users\\me\\筆記";

/** 開終端機的頁面，等它把 Channel 交給原生端。 */
async function openTerminal(desktop = {}) {
  const opened = await open({ desktop, page: "terminal.html", ready: "#terminal-panel .term-head" });
  // 實際的終端機 webview 只有面板那麼高。
  await opened.page.setViewportSize({ width: 900, height: 280 });
  await opened.page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "term_ready"));
  return opened;
}

const commands = async (page) => (await calls(page)).map((c) => c.cmd);

test("終端機不收聽全域事件，資料只從自己的 Channel 送來", async () => {
  const { page, context, errors } = await openTerminal();
  const ready = (await calls(page)).find((c) => c.cmd === "term_ready");
  assert.ok(ready.args.channel, "term_ready 要帶著 Channel");
  assert.deepEqual(await page.evaluate(() => window.__fake.listened()), []);

  // 全域事件（主畫面也送得出來）不理會。
  await page.evaluate((cwd) => window.__fake.emit("ai-command", { id: 1, command: "git status", reason: "", cwd }), CWD);
  await page.evaluate(() => window.__fake.emit("term-request", { kind: "start", program: "shell" }));
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".command-consent").count(), 0);
  assert.ok(!(await commands(page)).includes("term_open"));

  // 從 Channel 送來的才處理。
  await page.evaluate(() => window.__fake.channel("term-request", { kind: "available", claude: true, codex: false }));
  await page.getByRole("button", { name: "啟動 Claude Code" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "啟動 Codex" }).isVisible(), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test("貼到 AI 的文字不會送進殼層，也不會為它開殼層", async () => {
  const { page, context, errors } = await openTerminal({ term_open: 7 });
  await page.evaluate(() =>
    window.__fake.channel("term-request", { kind: "sendToAi", text: "\nRemove-Item -Recurse C:\\Users\\me\n", preferred: "shell" }),
  );
  await page.waitForTimeout(500);
  let cmds = await commands(page);
  assert.ok(!cmds.includes("term_open"), "不能為了它開殼層");
  assert.ok(!cmds.includes("term_write"), "不能寫入終端機");

  // Claude Code：沒有 AI 的分頁時先啟動，等它準備好再用括號貼上送出（不會自己按 Enter）。
  await page.evaluate(() => window.__fake.channel("term-request", { kind: "sendToAi", text: "請整理這一段", preferred: "claude" }));
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "term_open"));
  const opened = (await calls(page)).find((c) => c.cmd === "term_open");
  assert.equal(opened.args.program, "claude");
  await page.evaluate(() => window.__fake.channel("term-output", { id: 7, data: "Claude Code\r\n> " }));
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "term_write"), null, { timeout: 10000 });
  const writes = (await calls(page)).filter((c) => c.cmd === "term_write");
  assert.deepEqual(writes.map((c) => c.args), [{ id: 7, data: "\x1b[200~請整理這一段\x1b[201~" }]);

  // 已經有 AI 的分頁時，指定殼層的要求一樣不理會。
  await page.evaluate(() => window.__fake.channel("term-request", { kind: "sendToAi", text: "ls", preferred: "shell" }));
  await page.waitForTimeout(300);
  cmds = await commands(page);
  assert.equal(cmds.filter((c) => c === "term_write").length, 1);
  assert.equal(cmds.filter((c) => c === "term_open").length, 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test("AI 要執行的指令整個看得到，同意與否回報給原生端", async () => {
  const { page, context, errors } = await openTerminal({ mcp_respond: true });
  // 中間塞一長串空白，想把後面的指令擠到看不到的地方。
  const command = `git status${" ".repeat(3000)}; Remove-Item -Recurse ${CWD}`;
  await page.evaluate(([command, cwd]) => window.__fake.channel("ai-command", { id: 2, command, reason: "查看狀態", cwd }), [command, CWD]);
  const code = page.locator(".command-consent-code");
  await code.waitFor();
  assert.equal(await code.textContent(), command);
  const tailVisible = () =>
    page.evaluate(() => {
      const code = document.querySelector(".command-consent-code");
      const text = code.firstChild;
      const range = document.createRange();
      range.setStart(text, text.length - 6);
      range.setEnd(text, text.length);
      const r = range.getBoundingClientRect();
      const box = code.getBoundingClientRect();
      return r.width > 0 && r.left >= box.left && r.right <= box.right + 0.5 && r.top >= box.top && r.bottom <= box.bottom + 0.5;
    });
  assert.ok(await tailVisible(), "指令的結尾要直接看得到，不用捲動");
  assert.ok(await page.getByRole("button", { name: "拒絕" }).isVisible());

  await page.getByRole("button", { name: "這次開啟期間，這個指令都直接執行" }).click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "mcp_respond"));
  // 「都直接執行」由原生端記住（`always`），這裡不再自己判斷。
  assert.deepEqual((await calls(page)).find((c) => c.cmd === "mcp_respond").args, {
    id: 2,
    decision: { ok: true, message: "使用者已同意。", always: true },
  });

  // 一樣的指令再來一次：仍然顯示（原生端已經決定要問），只同意這一次。
  await page.evaluate(([command, cwd]) => window.__fake.channel("ai-command", { id: 3, command, reason: "", cwd }), [command, CWD]);
  await code.waitFor();
  await page.getByRole("button", { name: "執行", exact: true }).click();
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "mcp_respond").length === 2);
  assert.deepEqual((await calls(page)).filter((c) => c.cmd === "mcp_respond")[1].args.decision.always, false);

  // AI 等太久放棄了：拿掉提示。
  await page.evaluate((cwd) => window.__fake.channel("ai-command", { id: 4, command: "git log", reason: "", cwd }), CWD);
  await code.waitFor();
  await page.evaluate(() => window.__fake.channel("ai-command-expired", 4));
  await page.locator(".command-consent").waitFor({ state: "detached" });
  assert.equal((await calls(page)).filter((c) => c.cmd === "mcp_respond").length, 2);
  assert.deepEqual(errors, []);
  await context.close();
});

test("用 Tab 撐開的指令也整個看得到", async () => {
  const { page, context, errors } = await openTerminal({ mcp_respond: true });
  const command = `git status${"\t".repeat(800)}; Remove-Item -Recurse ${CWD}`;
  await page.evaluate(([command, cwd]) => window.__fake.channel("ai-command", { id: 5, command, reason: "", cwd }), [command, CWD]);
  await page.locator(".command-consent-code").waitFor();
  const visible = await page.evaluate(() => {
    const code = document.querySelector(".command-consent-code");
    const text = code.firstChild;
    const range = document.createRange();
    range.setStart(text, text.length - 6);
    range.setEnd(text, text.length);
    const r = range.getBoundingClientRect();
    const box = code.getBoundingClientRect();
    return r.width > 0 && r.top >= box.top && r.bottom <= box.bottom + 0.5 && r.right <= box.right + 0.5;
  });
  assert.ok(visible, "指令的結尾要直接看得到，不用捲動");
  assert.deepEqual(errors, []);
  await context.close();
});
