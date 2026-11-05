/**
 * 桌面版才有的畫面：用假的 Tauri 介面（helpers.mjs 的 `open({ desktop })`）模擬原生端的回應。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const FILE = { kind: "file", path: "/notes/週報.md", name: "週報.md", text: "# 週報\n\n第一版\n", encoding: "utf-8" };

test("整合功能關掉時，不會呼叫那些功能的原生指令", async () => {
  const on = await open({ desktop: {} });
  await on.page.waitForTimeout(500);
  const used = (await calls(on.page)).map((c) => c.cmd);
  assert.ok(used.includes("github_account"), used.join(" "));
  assert.ok(used.includes("ado_account"), used.join(" "));
  assert.deepEqual(on.errors, []);
  await on.context.close();

  const off = await open({
    desktop: { load_settings: JSON.stringify({ gitEnabled: false, adoEnabled: false, remoteEnabled: false }) },
  });
  await off.page.waitForTimeout(500);
  const offUsed = (await calls(off.page)).map((c) => c.cmd);
  for (const cmd of offUsed) assert.doesNotMatch(cmd, /^(git_|github_|ado_|dav_|ssh_)/);
  // 指令面板裡也找不到（Ctrl+Shift+P 在起始頁上也能用，不必先點編輯區）。
  await off.page.keyboard.press("Control+Shift+P");
  await off.page.locator("dialog[open] input").first().fill("WebDAV");
  assert.equal(await off.page.locator("dialog[open] [role=option]").count(), 0);
  assert.deepEqual(off.errors, []);
  await off.context.close();
});

test("存檔時檔案已被別人改過：選「用我的版本覆蓋」會強制存檔", async () => {
  const saved = { status: "saved", path: FILE.path, name: FILE.name };
  const conflict = { status: "conflict", path: FILE.path, name: FILE.name, diskText: "# 週報\n\n別人改的\n" };
  const { page, context, errors } = await open({ desktop: { startup_target: FILE, save_file: [conflict, saved] } });
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("第一版"));
  await page.click('button[data-view="editor"]');
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("我的修改\n");
  await page.keyboard.press("Control+S");
  const dialog = page.locator("dialog[open]");
  await dialog.locator("button", { hasText: "用我的版本覆蓋" }).click();
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "save_file").length === 2);
  const saves = (await calls(page)).filter((c) => c.cmd === "save_file");
  assert.equal(saves[1].args.force, true);
  assert.match(saves[1].args.text, /我的修改/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("檔案被外部程式修改：逐段標示差異，可以保留或還原", async () => {
  // 逐段標示外部修改是 AI 協作的選項（預設開啟），要先開 AI 協作；原生端通知後，前端會重新讀檔。
  const changed = { ...FILE, text: "# 週報\n\n外部程式改的\n" };
  const { page, context, errors } = await open({
    desktop: { startup_target: FILE, reopen_file: changed, load_settings: JSON.stringify({ aiEnabled: true }) },
  });
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("第一版"));
  await page.evaluate((path) => window.__fake.emit("file-changed", { path }), FILE.path);
  // 改成外部的內容，並標示出和原本不同的段落。
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("外部程式改的"));
  await page.waitForSelector("button:has-text('保留')");
  assert.deepEqual(errors, []);
  await context.close();
});
