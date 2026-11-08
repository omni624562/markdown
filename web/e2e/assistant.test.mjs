/**
 * Claude API 助理側欄：設定關閉（預設）時叫不出來；開啟、有金鑰、專案允許時，第一次送出先確認，
 * 改寫選取的文字變成建議卡片（按「套用」才改文件），一般問題的回答可以插入到游標處；
 * 專案還沒允許時只顯示提示與「允許這個專案使用 AI」。
 * 用假的原生端（見 helpers.mjs），回覆用 `assistant-run` 事件模擬。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open, runCommand, setText } from "./helpers.mjs";

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
  assert.ok(chips.some((c) => /選取 \d+ 字/.test(c)), chips.join("|"));

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

test("寫作選單：轉成流程圖，套用後插在選取的文字後面", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ ...ON, assistantConfirmed: [ROOT] }) });
  await openProject(page);
  await page.keyboard.press("Control+N");
  await page.locator(".cm-content").waitFor({ state: "visible" });
  await setText(page, "先備份照片，再同步到雲端。\n\n下一段");
  // 選取第一行。
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.press("Control+Shift+L");
  const panel = page.locator("#assistant-panel");
  await panel.waitFor();
  await panel.locator("#assistant-write").click();
  const menu = page.locator("#assistant-write-popover");
  const items = await menu.locator(":scope > button").allTextContents();
  assert.ok(items.some((s) => s.includes("轉成流程圖")), items.join("|"));
  assert.ok(items.some((s) => s.includes("整理成表格（選取的文字）")), items.join("|"));
  await menu.locator(":scope > button", { hasText: "轉成流程圖" }).click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "assistant_send"));
  const [{ request }] = await sends(page);
  assert.match(request.system, /只輸出要插入文件的新內容/);
  // 回答沒有包程式碼框：插入時補成 mermaid 區塊。
  await reply(page, "flowchart TD\n  A[備份照片] --> B[同步到雲端]");
  const card = panel.locator(".assistant-card");
  await card.waitFor();
  assert.equal(await card.locator("h4").textContent(), "插入到選取的文字後面（建議）");
  assert.equal(await card.locator(".assistant-diff .del").count(), 0);
  await card.getByRole("button", { name: "套用" }).click();
  // 即時預覽會把流程圖畫出來：直接讀編輯器的內容。
  const text = await page.evaluate(() => {
    const content = document.querySelector(".cm-content");
    const tile = content?.cmView ?? content?.cmTile;
    return (tile?.view ?? tile?.root?.view).state.doc.toString();
  });
  assert.match(text, /^先備份照片，再同步到雲端。\n\n```mermaid\nflowchart TD\n {2}A\[備份照片\] --> B\[同步到雲端\]\n```\n\n下一段/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("設定：Claude API 助理自成一頁，不在 AI 協作那一頁", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ claudeApiEnabled: true, assistantProjects: [ROOT] }) });
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+,");
  const dialog = page.locator("dialog.settings[open]");
  await dialog.locator("[role=tab]", { hasText: "AI 協作" }).click();
  assert.equal(await dialog.locator("section:not([hidden]) #assistant-settings").count(), 0);
  await dialog.locator("[role=tab]", { hasText: "Claude API 助理" }).click();
  const card = dialog.locator("#assistant-settings");
  await card.waitFor();
  assert.ok(await card.isVisible());
  assert.match(await card.textContent(), /已存在 Windows 認證管理員/);
  assert.equal(await card.locator('[data-key="claudeApiEnabled"]').isChecked(), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("版面：助理是右邊自己一欄（分頁列只到編輯區）；模型用 oMarker 的選單換；寬度可以拖曳並記住", async () => {
  const { page, context, errors } = await open({ desktop: desktop(ON) });
  await page.setViewportSize({ width: 1280, height: 760 });
  await openProject(page);
  await page.keyboard.press("Control+N");
  await page.locator(".cm-content").waitFor({ state: "visible" });
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+Shift+L");
  const panel = page.locator("#assistant-panel");
  await panel.waitFor();
  const box = await panel.boundingBox();
  const tabs = await page.locator("#tab-bar").boundingBox();
  // 從頂端列下面開始（頂端列橫跨整個視窗，視窗按鈕在右上角），分頁列在助理左邊結束。
  assert.ok(box.y >= tabs.y + tabs.height - 1 && box.y < 60, `top ${box.y}`);
  assert.ok(tabs.x + tabs.width <= box.x, `tabs end ${tabs.x + tabs.width} > ${box.x}`);
  const editor = await page.locator(".editor-pane").boundingBox();
  assert.ok(editor.x + editor.width <= box.x);

  // 模型：標題列的文字按鈕，選單裡標著目前的模型。
  await panel.locator("#assistant-model").click();
  const menu = page.locator("#assistant-model-popover");
  await menu.waitFor();
  await menu.getByRole("menuitemradio", { name: /Opus 5\.5/ }).click();
  await page.waitForFunction(() => document.querySelector("#assistant-model").textContent.includes("Opus 5.5"));
  const saved = (await calls(page)).filter((c) => c.cmd === "save_settings").map((c) => JSON.parse(c.args.json));
  assert.equal(saved.at(-1).claudeModel, "claude-opus-5-5");

  // 拖曳左緣調整寬度，重新打開還是一樣寬。
  const grip = panel.locator(".assistant-resizer");
  const g = await grip.boundingBox();
  await page.mouse.move(g.x + 3, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x - 97, g.y + g.height / 2, { steps: 5 });
  await page.mouse.up();
  const wide = (await panel.boundingBox()).width;
  assert.ok(Math.abs(wide - (box.width + 100)) <= 2, `width ${wide}`);
  assert.equal(await page.evaluate(() => localStorage.getItem("assistant-width") !== null || Object.keys(localStorage).some((k) => k.includes("assistant-width"))), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("窄視窗：助理變成蓋在文件上的抽屜，按 Esc 收起", async () => {
  const { page, context, errors } = await open({ desktop: desktop(ON) });
  await page.setViewportSize({ width: 760, height: 640 });
  await openProject(page);
  await page.keyboard.press("Control+N");
  await page.locator(".cm-content").waitFor({ state: "visible" });
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+Shift+L");
  const panel = page.locator("#assistant-panel");
  await panel.waitFor();
  assert.equal(await panel.evaluate((el) => getComputedStyle(el).position), "fixed");
  const box = await panel.boundingBox();
  assert.ok(box.x + box.width <= 760);
  await panel.locator("textarea").press("Escape");
  await panel.waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  await context.close();
});

test("自訂動作：設定頁新增，出現在「更多」選單的「自訂動作」，執行時送出自己的提示詞", async () => {
  const actions = [{ name: "整理成會議紀錄", prompt: "請整理成會議紀錄：日期、與會者、決議、待辦。", mode: "insert" }];
  const { page, context, errors } = await open({ desktop: desktop({ ...ON, assistantConfirmed: [ROOT], assistantActions: actions }) });
  await openProject(page);
  await page.keyboard.press("Control+N");
  await page.locator(".cm-content").waitFor({ state: "visible" });
  await setText(page, "週一和王小明討論備份，決定改成每晚自動備份。");
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+Shift+L");
  const panel = page.locator("#assistant-panel");
  await panel.waitFor();
  await panel.locator("#assistant-write").click();
  const menu = page.locator("#assistant-write-popover");
  await menu.waitFor();
  assert.match(await menu.textContent(), /自訂動作/);
  await menu.getByRole("menuitem", { name: "整理成會議紀錄" }).click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "assistant_send"));
  const [{ request }] = await sends(page);
  assert.match(request.messages[0].content, /請整理成會議紀錄：日期、與會者、決議、待辦。$/);
  assert.match(request.system, /只輸出要插入文件的新內容/);
  await reply(page, "## 會議紀錄\n\n- 決議：每晚自動備份");
  await panel.locator(".assistant-card").waitFor();

  // 設定頁：看得到這個動作，新增一個之後選單也跟著有。
  await panel.locator("#assistant-write").click();
  await menu.getByRole("menuitem", { name: "管理自訂動作…" }).click();
  const dialog = page.locator("dialog.settings[open]");
  const list = dialog.locator(".assistant-actions-list .quick-action");
  await list.first().waitFor();
  assert.equal(await list.count(), 1);
  assert.equal(await list.first().locator("input").inputValue(), "整理成會議紀錄");
  assert.equal(await list.first().locator("select").inputValue(), "insert");
  await dialog.locator("#assistant-settings .quick-action-add").click();
  assert.equal(await list.count(), 2);
  await list.nth(1).locator("input").fill("改成英文");
  await list.nth(1).locator("input").press("Tab");
  const saved = (await calls(page)).filter((c) => c.cmd === "save_settings").map((c) => JSON.parse(c.args.json));
  assert.deepEqual(saved.at(-1).assistantActions.map((a) => a.name), ["整理成會議紀錄", "改成英文"]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("存成筆記：對話之後按標題列的按鈕，在專案裡建立一份筆記並存檔", async () => {
  const d = desktop({ ...ON, assistantConfirmed: [ROOT] });
  Object.assign(d, {
    create_entry: { $by: "parent", values: { [ROOT]: `${ROOT}\\助理對話.md` } },
    reopen_file: { path: `${ROOT}\\助理對話.md`, name: "助理對話.md", text: "", encoding: "utf-8" },
    save_file: { status: "saved", path: `${ROOT}\\助理對話.md`, name: "助理對話.md" },
  });
  const { page, context, errors } = await open({ desktop: d });
  await openProject(page);
  await page.keyboard.press("Control+N");
  await page.locator(".cm-content").waitFor({ state: "visible" });
  await setText(page, "NAS 備份規劃");
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+Shift+L");
  const panel = page.locator("#assistant-panel");
  await panel.waitFor();
  const save = panel.getByRole("button", { name: "存成筆記" });
  assert.equal(await save.isDisabled(), true, "還沒有對話時不能按");
  await panel.locator("textarea").fill("這份文件在講什麼？");
  await panel.locator("textarea").press("Enter");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "assistant_send"));
  await reply(page, "在講 **NAS 備份**。");
  await panel.locator(".assistant-tools").waitFor();
  assert.equal(await save.isDisabled(), false);
  await save.click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "save_file"));
  const all = await calls(page);
  const created = all.find((c) => c.cmd === "create_entry").args;
  assert.equal(created.parent, ROOT);
  assert.match(created.name, /^助理對話 \d{4}-\d{2}-\d{2} \d{4}\.md$/);
  const saved = all.find((c) => c.cmd === "save_file").args;
  assert.match(saved.text, /^# 助理對話\n\n\d{4}-\d{2}-\d{2} \d{2}:\d{2} · /);
  assert.match(saved.text, /\n> 這份文件在講什麼？\n\n在講 \*\*NAS 備份\*\*。\n$/);
  // 新對話後清空，又不能按了。
  await panel.getByRole("button", { name: "新對話" }).click();
  assert.equal(await save.isDisabled(), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("建議連結和標籤：附上專案裡其他筆記的名稱和已有的標籤", async () => {
  const doc = (rel, tags) => ({ path: `${ROOT}\\${rel}`, rel, mtime: 1, info: { tasks: [], tags, links: [] } });
  const d = desktop({ ...ON, assistantConfirmed: [ROOT] });
  d.scan_docs = [[doc("家用網路.md", ["網路", "家裡"]), doc("電腦清單.md", ["網路"])]];
  const { page, context, errors } = await open({ desktop: d });
  await openProject(page);
  await page.keyboard.press("Control+N");
  await page.locator(".cm-content").waitFor({ state: "visible" });
  await setText(page, "NAS 要放在家用網路裡。");
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+Shift+L");
  const panel = page.locator("#assistant-panel");
  await panel.waitFor();
  await panel.locator("#assistant-write").click();
  await page.locator("#assistant-write-popover").getByRole("menuitem", { name: "建議連結和標籤" }).click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "assistant_send"));
  const [{ request }] = await sends(page);
  assert.match(request.messages[0].content, /<notes>\n家用網路\n電腦清單\n<\/notes>/);
  assert.match(request.messages[0].content, /<tags>\n#網路 #家裡\n<\/tags>/);
  assert.match(request.messages[0].content, /\[\[筆記名稱\]\]/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("附圖片：在輸入框貼上圖片變成小標籤，送出時圖片附在這一題；不支援的格式不收", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ ...ON, assistantConfirmed: [ROOT] }) });
  await openProject(page);
  await page.keyboard.press("Control+N");
  await page.locator(".cm-content").waitFor({ state: "visible" });
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+Shift+L");
  const panel = page.locator("#assistant-panel");
  await panel.waitFor();
  const paste = (name, type, bytes) =>
    panel.locator("textarea").evaluate(
      (el, [name, type, bytes]) => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(bytes)], name, { type }));
        el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      },
      [name, type, bytes],
    );
  // 1×1 的 PNG 開頭幾個位元組就夠了（只檢查格式與大小）。
  await paste("截圖.png", "image/png", [137, 80, 78, 71, 13, 10, 26, 10]);
  await panel.locator(".assistant-chip-image", { hasText: "截圖.png" }).waitFor();
  await paste("圖.svg", "image/svg+xml", [60, 115, 118, 103, 62]);
  await page.locator(".toast", { hasText: "不是 PNG、JPEG、GIF 或 WebP" }).waitFor();
  assert.equal(await panel.locator(".assistant-chip-image").count(), 1);

  await panel.locator("textarea").fill("這張圖在講什麼？");
  await panel.locator("textarea").press("Enter");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "assistant_send"));
  const [{ request }] = await sends(page);
  const last = request.messages.at(-1);
  assert.deepEqual(last.images, [{ mediaType: "image/png", data: "iVBORw0KGgo=" }]);
  assert.match(last.content, /這張圖在講什麼？$/);
  // 送出後清空，問題旁邊有縮圖。
  assert.equal(await panel.locator(".assistant-chip-image").count(), 0);
  assert.equal(await panel.locator(".assistant-user .assistant-thumb").count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test("問整個專案：送出和問題相關的筆記，回答裡的 [[出處]] 點了會打開那份筆記", async () => {
  const docs = [
    { path: `${ROOT}\\NAS 備份規劃.md`, rel: "NAS 備份規劃.md", mtime: 1, info: { tasks: [], tags: [], links: [] } },
    { path: `${ROOT}\\家用網路.md`, rel: "家用網路.md", mtime: 1, info: { tasks: [], tags: [], links: [] } },
  ];
  const d = desktop({ ...ON, assistantConfirmed: [ROOT] });
  d.scan_docs = [docs];
  const [nas, net] = docs.map((x) => x.path);
  d.read_docs = {
    $by: "paths",
    values: { [`${nas},${net}`]: ["每晚把照片備份到 NAS。", "路由器在客廳。"], [`${net},${nas}`]: ["路由器在客廳。", "每晚把照片備份到 NAS。"] },
  };
  const { page, context, errors } = await open({ desktop: d });
  await openProject(page);
  await page.keyboard.press("Control+N");
  await page.locator(".cm-content").waitFor({ state: "visible" });
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+Shift+L");
  const panel = page.locator("#assistant-panel");
  await panel.waitFor();
  await panel.getByRole("button", { name: "問整個專案" }).click();
  await panel.locator(".assistant-chip:not(.assistant-chip-add)", { hasText: "整個專案" }).waitFor();
  await panel.locator("textarea").fill("NAS 備份怎麼做？");
  await panel.locator("textarea").press("Enter");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "assistant_send"));
  const [{ request }] = await sends(page);
  assert.match(request.messages[0].content, /<note name="NAS 備份規劃">\n每晚把照片備份到 NAS。\n<\/note>/);
  assert.doesNotMatch(request.messages[0].content, /路由器/);
  assert.match(request.system, /\[\[筆記名稱\]\]/);
  assert.match(await panel.locator(".assistant-scope").textContent(), /根據專案裡 1 篇筆記/);
  await reply(page, "每晚自動備份 [[NAS 備份規劃]]。");
  const cite = panel.locator(".assistant-answer a[data-wikilink]");
  await cite.waitFor();
  assert.equal(await cite.textContent(), "NAS 備份規劃");
  assert.deepEqual(errors, []);
  await context.close();
});

test("上網查資料：設定沒開時沒有這個選項；開了才出現，送出時這一題才帶上網搜尋，回答最後列出來源", async () => {
  {
    const { page, context } = await open({ desktop: desktop({ ...ON, assistantConfirmed: [ROOT] }) });
    await openProject(page);
    await page.locator(".cm-content").focus();
    await page.keyboard.press("Control+Shift+L");
    const panel = page.locator("#assistant-panel");
    await panel.waitFor();
    assert.equal(await panel.getByRole("button", { name: "上網查" }).count(), 0);
    await context.close();
  }
  const { page, context, errors } = await open({ desktop: desktop({ ...ON, assistantConfirmed: [ROOT], claudeWebSearch: true }) });
  await openProject(page);
  await page.keyboard.press("Control+N");
  await page.locator(".cm-content").waitFor({ state: "visible" });
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+Shift+L");
  const panel = page.locator("#assistant-panel");
  await panel.waitFor();
  // 沒按「上網查」的那一題不帶搜尋。
  await panel.locator("textarea").fill("你好");
  await panel.locator("textarea").press("Enter");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "assistant_send"));
  assert.equal((await sends(page))[0].request.webSearch, false);
  await reply(page, "你好！");
  await panel.locator(".assistant-tools").waitFor();

  await panel.getByRole("button", { name: "上網查" }).click();
  await panel.locator(".assistant-chip:not(.assistant-chip-add)", { hasText: "上網查" }).waitFor();
  await panel.locator("textarea").fill("NAS 硬碟要選哪一種？");
  await panel.locator("textarea").press("Enter");
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "assistant_send").length === 2);
  const second = (await sends(page))[1];
  assert.equal(second.request.webSearch, true);
  await page.evaluate((id) => {
    window.__fake.emit("assistant-run", { kind: "delta", id, text: "選 NAS 專用硬碟。" });
    window.__fake.emit("assistant-run", { kind: "source", id, url: "https://example.com/nas-disk", title: "NAS 硬碟怎麼選" });
    window.__fake.emit("assistant-run", { kind: "source", id, url: "https://example.com/nas-disk", title: "NAS 硬碟怎麼選" });
    window.__fake.emit("assistant-run", { kind: "done", id, usd: 0.02, monthUsd: 0.45, stop: null });
  }, second.id);
  const link = panel.locator(".assistant-answer a", { hasText: "NAS 硬碟怎麼選" });
  await link.waitFor();
  assert.equal(await link.count(), 1, "同一個來源只列一次");
  assert.equal(await link.getAttribute("href"), "https://example.com/nas-disk");
  assert.deepEqual(errors, []);
  await context.close();
});

test("今日簡報：從「更多」選單或指令面板執行，送出今天的日期和專案裡還沒完成的待辦，不送目前的文件", async () => {
  const task = (text, due, done = false) => ({ line: 1, done, text, owners: [], due });
  const d = desktop({ ...ON, assistantConfirmed: [ROOT] });
  d.scan_docs = [
    [
      { path: `${ROOT}\\週報.md`, rel: "週報.md", mtime: 1, info: { tasks: [task("寫週報", "2026-11-09"), task("做完了", null, true)], tags: [], links: [] } },
      { path: `${ROOT}\\NAS 備份規劃.md`, rel: "NAS 備份規劃.md", mtime: 1, info: { tasks: [task("買硬碟", null)], tags: [], links: [] } },
    ],
  ];
  const { page, context, errors } = await open({ desktop: d });
  await openProject(page);
  await page.keyboard.press("Control+N");
  await page.locator(".cm-content").waitFor({ state: "visible" });
  await setText(page, "這份文件不該送出");
  await runCommand(page, "助理：今日簡報");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "assistant_send"));
  const [{ request }] = await sends(page);
  const content = request.messages[0].content;
  assert.match(content, /<today>\d{4}-\d{2}-\d{2} /);
  assert.match(content, /<tasks>\n- \[ \] 寫週報（週報，due 2026-11-09）\n- \[ \] 買硬碟（NAS 備份規劃）\n<\/tasks>/);
  assert.doesNotMatch(content, /做完了|這份文件不該送出|<document/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("字級：標題列的 A−／A＋ 調整助理的字並記住；焦點在助理裡時 Ctrl+= / Ctrl+- / Ctrl+0 只動助理，不動編輯區", async () => {
  const { page, context, errors } = await open({ desktop: desktop(ON) });
  await openProject(page);
  await page.keyboard.press("Control+N");
  await page.locator(".cm-content").waitFor({ state: "visible" });
  await page.keyboard.press("Control+Shift+L");
  const panel = page.locator("#assistant-panel");
  await panel.waitFor();
  const size = () => panel.locator(".assistant-input textarea").evaluate((el) => getComputedStyle(el).fontSize);
  const editorSize = () => page.locator(".cm-content").evaluate((el) => getComputedStyle(el).fontSize);
  const before = await editorSize();
  assert.equal(await size(), "13px");

  await panel.getByRole("button", { name: "放大助理的字（Ctrl+=）" }).click();
  await panel.getByRole("button", { name: "放大助理的字（Ctrl+=）" }).click();
  assert.equal(await size(), "15px");
  const saved = () => calls(page).then((list) => list.filter((c) => c.cmd === "save_settings").map((c) => JSON.parse(c.args.json)).at(-1));
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "save_settings" && JSON.parse(c.args.json).assistantFontSize === 15));

  await panel.locator(".assistant-input textarea").focus();
  await page.keyboard.press("Control+Equal");
  assert.equal(await size(), "16px");
  await page.keyboard.press("Control+Minus");
  await page.keyboard.press("Control+Minus");
  assert.equal(await size(), "14px");
  assert.equal(await editorSize(), before);
  await page.keyboard.press("Control+0");
  assert.equal(await size(), "13px");
  await panel.getByRole("button", { name: "縮小助理的字（Ctrl+-）" }).click();
  assert.equal(await size(), "12px");
  assert.equal((await saved()).assistantFontSize, 12);
  assert.equal(await editorSize(), before);
  assert.deepEqual(errors, []);
  await context.close();
});

test("回答寫回文件：按鈕有文字；插入到游標處、加到最後都自成段落；程式碼區塊、表格可以只插入那一塊", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ ...ON, assistantConfirmed: [ROOT] }) });
  await openProject(page);
  await page.keyboard.press("Control+N");
  await page.locator(".cm-content").waitFor({ state: "visible" });
  // 原始碼檢視：畫面上的每一行就是文件的原文。
  await page.locator(".segmented [data-view=editor]").click();
  await setText(page, "第一段\n\n第二段");
  const docText = () => page.evaluate(() => [...document.querySelectorAll(".cm-content .cm-line")].map((l) => l.textContent).join("\n"));
  await page.keyboard.press("Control+Shift+L");
  const panel = page.locator("#assistant-panel");
  await panel.locator(".assistant-input textarea").fill("給我一個範例");
  await panel.locator(".assistant-input textarea").press("Enter");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "assistant_send"));
  await reply(page, "範例如下：\n\n```js\nconsole.log(1);\n```\n\n| 欄 | 值 |\n| --- | --- |\n| 甲 | 1 |\n\n以上。");
  const answer = panel.locator(".assistant-assistant").last();
  await answer.locator(".assistant-tools").waitFor();
  assert.deepEqual(await answer.locator(".assistant-tools .assistant-tool").allTextContents(), ["複製", "插入", "加到最後"]);
  assert.equal(await answer.locator(".assistant-block").count(), 2);

  // 游標放在「第一段」的中間：插入的內容前後空一行，自成段落。
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await answer.locator(".assistant-block").first().getByRole("button", { name: "把這一塊插入到游標處" }).click();
  const after = await docText();
  assert.equal(after, "第一\n\n```js\nconsole.log(1);\n```\n\n段\n\n第二段");

  // 加到最後：接在文件結尾，前面空一行。
  await answer.locator(".assistant-block").nth(1).getByRole("button", { name: "把這一塊插入到游標處" }).waitFor();
  await answer.locator(".assistant-tools").getByRole("button", { name: "加到文件最後" }).click();
  const end = await docText();
  assert.ok(end.startsWith(after + "\n\n範例如下："), end);
  assert.ok(end.endsWith("以上。"), end);
  assert.deepEqual(errors, []);
  await context.close();
});
