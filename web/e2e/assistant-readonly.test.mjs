/**
 * 助理的回答寫回文件：目前的文件是預設唯讀的 COMET 檔案時不寫，說明原因並附「仍要編輯」，
 * 不會顯示「已插入」卻什麼都沒改。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\產品交付";
const at = (name) => `${ROOT}\\${name}`;
const AGENTS = "# 給 AI 的說明\n";

test("COMET 的 AGENTS.md 鎖著時：插入不會改文件，提示原因；按「仍要編輯」後才插得進去", async () => {
  const { page, context, errors } = await open({
    desktop: {
      load_settings: JSON.stringify({ claudeApiEnabled: true, assistantProjects: [ROOT], assistantConfirmed: [ROOT] }),
      startup_target: { kind: "folder", path: ROOT, name: "產品交付" },
      projects_list: [[{ path: ROOT, label: "產品交付", name: null, color: null, group: null, pinned: false, lastOpened: 0, comet: true }]],
      list_dir: { $by: "path", values: { [ROOT]: [{ name: ".comet.json", path: at(".comet.json"), isDir: false }, { name: "AGENTS.md", path: at("AGENTS.md"), isDir: false }] } },
      reopen_file: { $by: "path", values: { [at("AGENTS.md")]: { path: at("AGENTS.md"), name: "AGENTS.md", text: AGENTS, encoding: "utf-8" } } },
      assistant_key_status: true,
      assistant_usage: { month: "2026-11", usd: 0, limit: 10 },
    },
  });
  const row = page.locator(`#file-tree .tree-row[data-path="${at("AGENTS.md").replace(/\\/g, "\\\\")}"]`);
  await row.locator(".tree-mark").waitFor();
  await row.click();
  await page.locator(".cm-editor .comet-note[data-locked='1']").waitFor();
  const docText = () => page.evaluate(() => [...document.querySelectorAll(".cm-content .cm-line")].map((l) => l.textContent).join("\n"));

  await page.keyboard.press("Control+Shift+L");
  const panel = page.locator("#assistant-panel");
  await panel.locator(".assistant-input textarea").fill("補一條規則");
  await panel.locator(".assistant-input textarea").press("Enter");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "assistant_send"));
  const [{ id }] = (await calls(page)).filter((c) => c.cmd === "assistant_send").map((c) => c.args);
  await page.evaluate((id) => {
    window.__fake.emit("assistant-run", { kind: "delta", id, text: "- 新的規則" });
    window.__fake.emit("assistant-run", { kind: "done", id, usd: 0.01, monthUsd: 0.01, stop: null });
  }, id);
  const insert = panel.locator(".assistant-assistant").last().getByRole("button", { name: "插入到游標處" });
  await insert.click();

  const toast = page.locator(".toast-error", { hasText: "預設唯讀" });
  await toast.waitFor();
  assert.equal(await page.locator(".toast", { hasText: "已插入" }).count(), 0);
  assert.doesNotMatch(await docText(), /新的規則/);
  await toast.getByRole("button", { name: "仍要編輯" }).click();
  await page.locator(".cm-editor .comet-note[data-locked='']").waitFor();
  await insert.click();
  await page.locator(".toast", { hasText: "已插入" }).waitFor();
  assert.match(await docText(), /新的規則/);
  assert.deepEqual(errors, []);
  await context.close();
});
