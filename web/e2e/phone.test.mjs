/**
 * 手機版面（Android 版、螢幕窄）：首頁是文件清單，「新增」進到編輯畫面，返回鍵回到首頁；
 * 上方只有「← 名稱 ✦ ⋮」與「編輯／預覽」，「⋮」從下面拉起選單；分頁列、狀態列不顯示。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

/** 在 Android 版裡開啟（假的原生端），手機的大小。 */
async function openPhone() {
  const { page, context, errors } = await open({ android: true, viewport: { width: 412, height: 915 } });
  return { page, context, errors };
}

test("手機：首頁是文件清單；新增進到編輯、返回鍵回到首頁，剛寫的文件列在最上面", async () => {
  const { page: p, context, errors } = await openPhone();
  await p.waitForSelector("#phone-home:not([hidden])");
  for (const sel of [".topbar", ".statusbar", "#tab-bar"]) assert.equal(await p.locator(sel).isVisible(), false, `${sel} 應該藏起來`);
  await p.click(".phone-fab");
  await p.waitForSelector("#phone-home", { state: "hidden" });
  assert.ok(await p.locator("#phone-bar").isVisible());
  await p.click("#editor .cm-content");
  await p.keyboard.type("會議紀錄");
  assert.ok(await p.locator("#phone-fmt").isVisible(), "打字時鍵盤上方有格式列");
  await p.click('#phone-fmt [aria-label="粗體"]');
  await p.goBack();
  await p.waitForSelector("#phone-home:not([hidden])");
  assert.equal(await p.textContent(".phone-card b"), "會議紀錄", "還沒存檔的文件用第一行當名稱");
  // 點卡片回到那份文件。
  await p.click(".phone-card");
  await p.waitForSelector("#phone-home", { state: "hidden" });
  assert.equal(await p.locator("#phone-fmt").isVisible(), false, "沒在打字時不顯示格式列");
  assert.deepEqual(errors, []);
  await context.close();
});

test("手機：「編輯／預覽」切換；「⋮」從下面拉起選單，點外面關閉", async () => {
  const { page: p, context, errors } = await openPhone();
  await p.click(".phone-fab");
  await p.click("#editor .cm-content");
  await p.keyboard.type("# 標題");
  await p.click(".phone-seg button:has-text('預覽')");
  await p.waitForSelector("#preview h1");
  assert.equal(await p.locator(".editor-pane").isVisible(), false);
  await p.click(".phone-seg button:has-text('編輯')");
  await p.waitForSelector(".editor-pane", { state: "visible" });
  await p.click('#phone-bar [aria-label="更多"]');
  const sheet = p.locator("#phone-sheet[open]");
  await sheet.waitFor();
  const box = await sheet.boundingBox();
  assert.ok(Math.abs(box.y + box.height - 915) <= 1, `選單貼在最下面：${JSON.stringify(box)}`);
  assert.ok(await sheet.locator(".phone-row:has-text('設定')").isVisible());
  await p.mouse.click(200, 100);
  await p.waitForSelector("#phone-sheet[open]", { state: "detached" });
  assert.deepEqual(errors, []);
  await context.close();
});

test("手機：助理蓋住整個畫面，「←」或返回鍵關閉；Enter 是換行，不提快速鍵", async () => {
  const { page: p, context, errors } = await open({
    android: { assistant_key_status: true, assistant_usage: { month: "2026-11", usd: 0, limit: 10 } },
    viewport: { width: 412, height: 915 },
    settings: { claudeApiEnabled: true },
  });
  await p.click(".phone-fab");
  await p.click('#phone-bar [aria-label="助理"]');
  const panel = p.locator("#assistant-panel");
  await panel.waitFor();
  const box = await p.locator("#outline-right").boundingBox();
  assert.ok(box.width >= 411 && box.height >= 914, `助理佔滿畫面：${JSON.stringify(box)}`);
  assert.equal(await p.locator("#outline-right > .right-head").isVisible(), false, "只有一頁，不顯示右側欄的分頁");
  const input = panel.locator("textarea");
  assert.equal(await input.getAttribute("placeholder"), "問助理…");
  await input.fill("第一行");
  await input.press("Enter");
  await input.type("第二行");
  assert.equal(await input.inputValue(), "第一行\n第二行");
  await p.click('.assistant-head [aria-label="關閉助理"]');
  await p.waitForSelector("#outline-right", { state: "hidden" });
  assert.ok(await p.locator("#phone-bar").isVisible(), "回到文件，不是首頁");
  assert.equal(await p.locator("#phone-home").isVisible(), false);
  // 再打開一次，用返回鍵關閉。
  await p.click('#phone-bar [aria-label="助理"]');
  await panel.waitFor();
  await p.goBack();
  await p.waitForSelector("#outline-right", { state: "hidden" });
  assert.equal(await p.locator("#phone-home").isVisible(), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test("手機：很寬的表格、很長的第一行不會把整個畫面撐寬", async () => {
  const { page: p, context, errors } = await open({ android: true, viewport: { width: 412, height: 915 } });
  await p.click(".phone-fab");
  await p.click("#editor .cm-content");
  const long = "很長的說明".repeat(12);
  await p.keyboard.insertText(`${long}\n\n| 面向 | 建議 |\n| --- | --- |\n| 持股水位 | ${long} |\n`);
  await p.click(".phone-seg button:has-text('預覽')");
  await p.waitForSelector("#preview table");
  for (const view of ["預覽", "編輯"]) {
    await p.click(`.phone-seg button:has-text('${view}')`);
    const widths = await p.evaluate(() => [document.documentElement.scrollWidth, document.body.scrollWidth, document.querySelector("#phone-bar").getBoundingClientRect().width]);
    assert.deepEqual(widths, [412, 412, 412], view);
  }
  assert.deepEqual(errors, []);
  await context.close();
});
