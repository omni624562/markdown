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

test("手機：設定先列出分類，點進去是那一頁；「←」與返回鍵一層一層退回去，手機用不到的選項不顯示", async () => {
  const { page: p, context, errors } = await openPhone();
  await p.click(".phone-fab");
  await p.click('#phone-bar [aria-label="更多"]');
  await p.click("#phone-sheet [data-cmd=settings]");
  const dialog = p.locator("dialog[open].settings");
  await dialog.waitFor();
  const visibleTabs = () => dialog.locator("[role=tab]:visible .settings-tab-name").allTextContents();
  const tabs = await visibleTabs();
  assert.ok(tabs.includes("外觀") && tabs.includes("關於"), tabs.join("、"));
  assert.ok(!tabs.includes("AI 協作"), "Claude Code／Codex 要電腦版，手機不列");
  assert.equal(await dialog.locator(".settings-body").isVisible(), false, "第一層只有分類清單");
  assert.match(await dialog.locator("[role=tab]:has-text('外觀') .settings-tab-desc").textContent(), /明暗|配色/);

  await dialog.locator("[role=tab]:has-text('版面')").click();
  assert.equal(await dialog.locator("h2").textContent(), "版面");
  const labels = await dialog.locator("section:visible .settings-row:visible label").allTextContents();
  assert.ok(labels.includes("行距"), labels.join("、"));
  for (const hidden of ["分頁樣式", "大綱放在右邊", "固定顯示格式工具列"]) assert.ok(!labels.includes(hidden), hidden);

  // 返回鍵：頁面 → 分類清單 → 關閉設定（回到編輯畫面，不是首頁）。
  await p.goBack();
  assert.equal(await dialog.locator("h2").textContent(), "設定");
  assert.ok(await dialog.locator("[role=tab]:has-text('外觀')").isVisible());
  await dialog.locator("[role=tab]:has-text('外觀')").click();
  await dialog.locator(".settings-back").click();
  assert.ok(await dialog.locator("[role=tab]:has-text('外觀')").isVisible(), "「←」回到分類清單");
  await p.goBack();
  await p.waitForSelector("dialog.settings[open]", { state: "detached" });
  assert.ok(await p.locator("#phone-bar").isVisible(), "還在編輯畫面");
  assert.deepEqual(errors, []);
  await context.close();
});

test("手機：助理的輸入框只有標籤、「＋」與送出；常用動作在對話區，其他在「＋」選單", async () => {
  const { page: p, context, errors } = await open({
    android: { assistant_key_status: true, assistant_usage: { month: "2026-11", usd: 0.27, limit: 100 } },
    viewport: { width: 412, height: 915 },
    settings: { claudeApiEnabled: true, claudeWebSearch: true },
  });
  await p.click(".phone-fab");
  await p.click('#phone-bar [aria-label="助理"]');
  const panel = p.locator("#assistant-panel");
  await panel.locator("textarea").waitFor();
  const visible = (sel) => panel.locator(`${sel}:visible`).count();
  assert.equal(await visible(".assistant-chip-add"), 0, "沒打開的選項不佔位置");
  assert.equal(await visible(".assistant-quick button"), 2, "下緣只有「＋」與送出");
  assert.equal(await visible(".assistant-foot"), 0);
  assert.deepEqual(await panel.locator(".assistant-suggest button").allTextContents(), ["摘要", "改寫", "翻譯", "審稿", "更多…"]);
  const font = await panel.locator("textarea").evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  assert.ok(font >= 17, `輸入的字：${font}px`);

  // 「＋」：打開上網查，輸入框上方出現「上網查 ✕」。
  await p.click(".assistant-plus");
  const sheet = p.locator(".assistant-sheet[open]");
  await sheet.waitFor();
  assert.match(await sheet.locator(".assistant-sheet-usage").textContent(), /US\$0\.27/);
  await sheet.locator(".phone-row:has-text('上網查')").click();
  await p.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });
  assert.equal(await visible(".assistant-chip:has-text('上網查')"), 1);
  // 「更多…」：全部的寫作動作。
  await panel.locator(".assistant-suggest button:has-text('更多…')").click();
  assert.ok(await sheet.locator(".phone-row:has-text('轉成流程圖')").isVisible());
  assert.deepEqual(errors, []);
  await context.close();
});

test("電腦版的助理輸入框不變：沒有「＋」與對話區的大按鈕", async () => {
  const { page: p, context, errors } = await open({ desktop: { assistant_key_status: true }, settings: { claudeApiEnabled: true } });
  assert.equal(await p.locator(".assistant-plus, .assistant-suggest").count(), 0, "電腦版不建立手機的元件");
  assert.deepEqual(errors, []);
  await context.close();
});
