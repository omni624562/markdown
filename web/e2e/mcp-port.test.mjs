/**
 * 編輯器的 MCP 伺服器：固定的連接埠被別的程式占用、改用別的連接埠時，提示之前註冊過的 AI 工具要重新註冊
 * （它們會連到占用連接埠的那個程式）。連接埠沒換時不提示。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const desktop = (info) => ({
  load_settings: JSON.stringify({ aiEnabled: true, mcpServer: true }),
  mcp_start: info,
});
const toasts = (page) => page.locator(".toast").allTextContents();

test("固定的連接埠被占用、改用別的：提示之前註冊的 Claude Code／Codex 要重新註冊", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ url: "http://127.0.0.1:51234/mcp", portMoved: true }) });
  await page.locator(".toast", { hasText: "重新複製並執行" }).waitFor();
  assert.ok((await calls(page)).some((c) => c.cmd === "mcp_start"));
  assert.match((await toasts(page)).join("\n"), /設定 → AI 協作 → 註冊指令/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("用固定的連接埠：不提示", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ url: "http://127.0.0.1:47321/mcp", portMoved: false }) });
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "mcp_start"));
  await page.waitForTimeout(300);
  assert.equal((await toasts(page)).filter((t) => /註冊指令/.test(t)).length, 0);
  assert.deepEqual(errors, []);
  await context.close();
});
