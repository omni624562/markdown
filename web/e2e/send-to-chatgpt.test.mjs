/**
 * 傳給 ChatGPT：設定關閉（預設）時看不到；打開後編輯器與預覽選取文字的右鍵選單有「傳給 ChatGPT」，
 * 第一次先確認（之後不再問），交給原生端的是目標與文字；內容太長時先複製到剪貼簿、只開 ChatGPT。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const desktop = (chatgptSend) => ({
  load_settings: chatgptSend ? JSON.stringify({ chatgptSend }) : null,
  ai_apps_installed: { codex: true, claude: false },
});

/** 在編輯區寫入 `text`、全選，按右鍵，回傳編輯器的右鍵選單。 */
async function editorMenu(page, text) {
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText(text);
  await page.keyboard.press("Control+A");
  await page.locator(".cm-line").first().click({ button: "right" });
  const menu = page.locator("#context-anchor-popover");
  await menu.waitFor();
  return menu;
}

/** 測試用的網址不是安全來源，沒有 navigator.clipboard：換成記在 window.__clip 的假剪貼簿。 */
const fakeClipboard = (page) =>
  page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => void (window.__clip = text), readText: async () => window.__clip ?? "" },
    }),
  );

const sends = async (page) => (await calls(page)).filter((c) => c.cmd === "chatgpt_send").map((c) => c.args);

test("設定關閉（預設）時，右鍵選單沒有「傳給 ChatGPT」", async () => {
  const { page, context, errors } = await open({ desktop: desktop(null) });
  const menu = await editorMenu(page, "週報：本週完成登入頁。");
  const items = await menu.locator(":scope > button").allTextContents();
  assert.ok(items.some((s) => s.startsWith("複製")), items.join());
  assert.ok(!items.some((s) => s.includes("ChatGPT")), items.join());
  assert.deepEqual(errors, []);
  await context.close();
});

test("打開後：第一次先確認，交給原生端目標與選取的文字；第二次不再問", async () => {
  const { page, context, errors } = await open({ desktop: desktop("desktop") });
  let menu = await editorMenu(page, "週報：本週完成登入頁。");
  await menu.getByRole("menuitem", { name: "傳給 ChatGPT" }).click();
  const confirm = page.locator("dialog.choice[open]");
  await confirm.waitFor();
  assert.match(await confirm.textContent(), /OpenAI/);
  await confirm.getByRole("button", { name: "傳給 ChatGPT" }).click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "chatgpt_send"));
  assert.deepEqual(await sends(page), [{ target: "desktop", text: "週報：本週完成登入頁。" }]);

  // 已經確認過：直接送出，不再跳對話框。
  await page.locator(".cm-line").first().click({ button: "right" });
  menu = page.locator("#context-anchor-popover");
  await menu.getByRole("menuitem", { name: "傳給 ChatGPT" }).click();
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "chatgpt_send").length === 2);
  assert.equal(await page.locator("dialog.choice[open]").count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("取消確認就不送出", async () => {
  const { page, context, errors } = await open({ desktop: desktop("web") });
  const menu = await editorMenu(page, "週報");
  await menu.getByRole("menuitem", { name: "傳給 ChatGPT" }).click();
  await page.locator("dialog.choice[open]").getByRole("button", { name: "取消" }).click();
  await page.waitForTimeout(200);
  assert.deepEqual(await sends(page), []);
  assert.deepEqual(errors, []);
  await context.close();
});

test("內容太長：先複製到剪貼簿，再開 ChatGPT（網頁版不帶內容、桌面版只帶一句開頭）", async () => {
  for (const [target, lead] of [
    ["web", ""],
    ["desktop", "以下是內容："],
  ]) {
    const { page, context, errors } = await open({ desktop: desktop(target) });
    await fakeClipboard(page);
    const long = "甲".repeat(400);
    const menu = await editorMenu(page, long);
    await menu.getByRole("menuitem", { name: "傳給 ChatGPT" }).click();
    await page.locator("dialog.choice[open]").getByRole("button", { name: "傳給 ChatGPT" }).click();
    await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "chatgpt_send"));
    assert.deepEqual(await sends(page), [{ target, text: lead }], target);
    assert.equal(await page.evaluate(() => window.__clip), long);
    await page.locator(".toast", { hasText: "已複製" }).waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test("預覽裡選取的文字：右鍵選單有「複製」與「傳給 ChatGPT」", async () => {
  const { page, context, errors } = await open({ desktop: desktop("web") });
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText("# 週報\n\n本週完成登入頁。");
  await page.locator(".view-switch [data-view='preview']").click();
  const para = page.locator("#preview p", { hasText: "本週完成登入頁" });
  await para.waitFor();
  await para.selectText();
  await para.click({ button: "right" });
  const menu = page.locator("#text-menu-anchor-popover");
  await menu.waitFor();
  assert.deepEqual(await menu.locator(":scope > button").allTextContents(), ["複製", "傳給 ChatGPT"]);
  await menu.locator(":scope > button", { hasText: "傳給 ChatGPT" }).click();
  await page.locator("dialog.choice[open]").getByRole("button", { name: "傳給 ChatGPT" }).click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "chatgpt_send"));
  assert.deepEqual(await sends(page), [{ target: "web", text: "本週完成登入頁。" }]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("設定：AI 協作頁有「傳給 ChatGPT」，預設關閉；沒偵測到桌面版時桌面版選項不能選", async () => {
  for (const [codex, disabled] of [
    [true, false],
    [false, true],
  ]) {
    const { page, context, errors } = await open({ desktop: { ai_apps_installed: { codex, claude: false } } });
    await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ai_apps_installed"));
    await page.locator(".cm-content").focus();
    await page.keyboard.press("Control+Shift+P");
    await page.locator("dialog[open] input").first().fill("AI 協作設定");
    await page.keyboard.press("Enter");
    const select = page.locator("dialog.settings[open] select[data-key=chatgptSend]");
    await select.waitFor();
    assert.equal(await select.inputValue(), "off");
    assert.deepEqual(await select.locator("option").evaluateAll((os) => os.map((o) => o.value)), ["off", "desktop", "web"]);
    await page.waitForFunction(
      (d) => document.querySelector("dialog.settings select[data-key=chatgptSend] option[value=desktop]")?.disabled === d,
      disabled,
    );
    await select.selectOption("web");
    await page.waitForFunction(() =>
      window.__fake.calls.some((c) => c.cmd === "save_settings" && JSON.parse(c.args.json).chatgptSend === "web"),
    );
    assert.deepEqual(errors, []);
    await context.close();
  }
});
