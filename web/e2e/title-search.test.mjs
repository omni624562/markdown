/**
 * 標題列中間的搜尋框（app/title-search.ts）：按一下和 Ctrl+P 一樣打開快速開啟（開在視窗最上面）；
 * 搜尋框下面「也可以：」列出開頭的符號（# 工作項目、> 指令、? 問助理），按一下就填入；
 * 有輸入時分區列出檔案、工作項目、Wiki 與最後的「問助理：…」；`>` 找指令、`?` 問助理。
 * 框裡的字依能找的東西而定；窄視窗時填滿 ◧ 與 ◨ 之間。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\旅遊";
const file = (name) => ({ name, path: `${ROOT}\\${name}`, isDir: false });
const workItem = { id: 1203, title: "釜山出差行程確認", state: "Active", kind: "Task", project: "產品", assignedTo: "王小明", changed: "2026-11-01T00:00:00Z", priority: null, webUrl: "https://ado.test/c/產品/_workitems/edit/1203" };
const desktop = (settings = {}, extra = {}) => ({
  startup_target: { kind: "folder", path: ROOT, name: "旅遊" },
  list_dir: { $by: "path", values: { [ROOT]: [file("韓國釜山.md"), file("釜山美食清單.md"), file("週報.md")] } },
  list_files: [[
    { path: `${ROOT}\\韓國釜山.md`, rel: "韓國釜山.md" },
    { path: `${ROOT}\\釜山美食清單.md`, rel: "釜山美食清單.md" },
    { path: `${ROOT}\\週報.md`, rel: "週報.md" },
  ]],
  load_settings: JSON.stringify({ claudeApiEnabled: true, assistantProjects: [ROOT], assistantConfirmed: [ROOT], ...settings }),
  assistant_key_status: true,
  assistant_usage: { month: "2026-11", usd: 0.42, limit: 10 },
  custom_title_bar: true,
  window_control: false,
  ...extra,
});
const ADO = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_work_items: [[workItem]],
  ado_wikis: [[{ id: "w1", name: "Contoso.wiki", project: "產品", projectId: "p1", code: false }]],
  ado_wiki_pages: [[{ path: "/", id: 1, children: [{ path: "/出差規定", id: 2, children: [{ path: "/出差規定/海外交通", id: 3, children: [] }] }] }]],
};

const box = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el || !el.getClientRects().length) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) };
  }, sel);

/** 清單裡看得到的分區標題與項目名稱（依順序）。 */
const rows = (page) =>
  page.$$eval("dialog[open] [role=listbox] > li", (lis) =>
    lis.map((li) => (li.classList.contains("palette-section") ? `【${li.textContent}】` : li.querySelector(".palette-title")?.textContent ?? li.textContent)),
  );
const input = (page) => page.locator("dialog[open] input").first();

test("寬視窗：搜尋框在標題列正中間，按一下打開快速開啟（在最上面），下面列出 # > ? 三個符號", async () => {
  const { page, context, errors } = await open({ desktop: desktop({}, ADO) });
  await page.setViewportSize({ width: 1440, height: 760 });
  await page.locator("#files-head").waitFor();
  const search = page.locator("#title-search");
  await page.waitForFunction(() => document.querySelector("#title-search .title-search-text").textContent === "搜尋檔案、工作項目，或問助理");
  assert.equal(await search.locator("kbd").textContent(), "Ctrl+P");
  const b = await box(page, "#title-search");
  const topbar = await box(page, ".topbar");
  assert.ok(Math.abs((b.left + b.right) / 2 - 720) <= 1, `在視窗正中間 ${JSON.stringify(b)}`);
  assert.ok(b.top > topbar.top && b.bottom < topbar.bottom, "在標題列裡");
  for (const sel of [".topbar > .nav-toggle", ".top-actions"]) {
    const o = await box(page, sel);
    assert.ok(o.right <= b.left || o.left >= b.right, `沒有蓋到 ${sel}`);
  }

  await search.click();
  const dialog = page.locator("dialog.palette[open]");
  await dialog.waitFor();
  const d = await box(page, "dialog.palette[open]");
  assert.ok(d.top <= 8, `開在最上面 ${JSON.stringify(d)}`);
  assert.deepEqual(await dialog.locator(".palette-tip").allTextContents(), ["#工作項目", ">指令", "?問助理"]);
  // 按「> 指令」：填入 >，列出指令（依分類分區）。
  await dialog.locator(".palette-tip", { hasText: "指令" }).click();
  assert.equal(await input(page).inputValue(), ">");
  await page.waitForFunction(() => document.querySelectorAll("dialog[open] .palette-section").length > 3);
  assert.equal(await input(page).evaluate((el) => el === document.activeElement), true, "焦點回到搜尋框");
  // 已經打的字留著：「>深色」再按「? 問助理」變成「?深色」。
  await input(page).fill(">深色");
  await dialog.locator(".palette-tip", { hasText: "問助理" }).click();
  assert.equal(await input(page).inputValue(), "?深色");
  await page.waitForFunction(() => document.querySelector("dialog[open] [role=option] .palette-title")?.textContent === "問助理：「深色」");
  assert.deepEqual(errors, []);
  await context.close();
});

test("有輸入時分區列出檔案、工作項目、Wiki，最後是「問助理」；工作項目查到後才補上，選取的項目不跳", async () => {
  const { page, context, errors } = await open({ desktop: desktop({}, ADO) });
  await page.locator("#files-head").waitFor();
  await page.keyboard.press("Control+P");
  await input(page).fill("釜山");
  // 檔案先列出來（不等伺服器）；先選第二項，工作項目補上後還是選著它。
  await page.waitForFunction(() => document.querySelectorAll("dialog[open] [role=option]").length >= 2);
  assert.equal(await page.locator("dialog[open] .palette-section", { hasText: "工作項目" }).count(), 0, "工作項目還沒查到");
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => [...document.querySelectorAll("dialog[open] .palette-section")].some((s) => s.textContent === "工作項目"));
  assert.equal(await page.locator('dialog[open] [aria-selected="true"] .palette-title').textContent(), "韓國釜山.md");
  assert.deepEqual(await rows(page), [
    "【檔案】", "釜山美食清單.md", "韓國釜山.md",
    "【工作項目】", "釜山出差行程確認",
    "【助理】", "問助理：「釜山」",
  ]);
  const searched = (await calls(page)).filter((c) => c.cmd === "ado_work_items");
  assert.equal(searched.at(-1).args.search, "釜山");
  // Wiki 頁面：名稱符合的列在 Wiki 那一區。
  await input(page).fill("海外");
  await page.waitForFunction(() => [...document.querySelectorAll("dialog[open] .palette-section")].some((s) => s.textContent === "Wiki"));
  const list = await rows(page);
  assert.ok(list.includes("海外交通") && list.indexOf("【Wiki】") < list.indexOf("海外交通"), list.join("|"));
  assert.equal(list.at(-1), "問助理：「海外」");
  assert.deepEqual(errors, []);
  await context.close();
});

test("「問助理：…」和 ? 開頭：打開右側欄的助理並送出問題", async () => {
  const { page, context, errors } = await open({ desktop: desktop() });
  await page.locator("#files-head").waitFor();
  await page.locator(".cm-content").focus();
  await page.keyboard.insertText("# 行程\n\n第一天去海雲台。");
  await page.keyboard.press("Control+P");
  await input(page).fill("？第一天去哪裡");
  await page.waitForFunction(() => document.querySelector("dialog[open] [role=option] .palette-title")?.textContent === "問助理：「第一天去哪裡」");
  await page.keyboard.press("Enter");
  await page.locator("#outline-right:not([hidden]) #assistant-panel:not([hidden])").waitFor();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "assistant_send"));
  const send = (await calls(page)).filter((c) => c.cmd === "assistant_send").at(-1).args.request;
  assert.match(send.messages.at(-1).content, /第一天去哪裡/);
  assert.match(send.messages.at(-1).content, /第一天去海雲台/, "帶著目前的文件");
  // 一般搜尋最後一項也是「問助理」；沒連上 Azure DevOps 時沒有工作項目那一區，也不列 # 符號。
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+P");
  assert.deepEqual(await page.locator("dialog[open] .palette-tip").allTextContents(), [">指令", "?問助理"]);
  await input(page).fill("週報");
  await page.waitForFunction(() => [...document.querySelectorAll("dialog[open] .palette-title")].some((t) => t.textContent === "問助理：「週報」"));
  assert.deepEqual(await rows(page), ["【檔案】", "週報.md", "【助理】", "問助理：「週報」"]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("> 開頭找指令：Enter 執行，記進「最近使用」（和指令面板共用）", async () => {
  const { page, context, errors } = await open({ desktop: desktop() });
  await page.locator("#files-head").waitFor();
  await page.click("#title-search");
  await input(page).fill(">側邊欄");
  await page.waitForFunction(() => document.querySelector("dialog[open] [role=option] .palette-title")?.textContent === "顯示／隱藏側邊欄");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".workspace").classList.contains("outline-hidden"));
  // 指令面板的「最近使用」也有它。
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+Shift+P");
  await page.waitForFunction(() => document.querySelector("dialog[open] .palette-section")?.textContent === "最近使用");
  assert.equal(await page.locator("dialog[open] [role=option] .palette-title").first().textContent(), "顯示／隱藏側邊欄");
  await page.keyboard.press("Escape");
  // 全形的 ＞（注音輸入法開著時）也算。
  await page.keyboard.press("Control+P");
  await input(page).fill("＞側邊欄");
  await page.waitForFunction(() => document.querySelector("dialog[open] [role=option] .palette-title")?.textContent === "顯示／隱藏側邊欄");
  assert.deepEqual(errors, []);
  await context.close();
});

test("框裡的字依能找的東西：助理沒開時不寫「問助理」，也沒有 ? 符號", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ claudeApiEnabled: false }) });
  await page.locator("#files-head").waitFor();
  assert.equal(await page.locator("#title-search .title-search-text").textContent(), "搜尋檔案或指令");
  await page.click("#title-search");
  assert.deepEqual(await page.locator("dialog[open] .palette-tip").allTextContents(), [">指令"]);
  await input(page).fill("週報");
  await page.waitForFunction(() => [...document.querySelectorAll("dialog[open] .palette-title")].some((t) => t.textContent === "週報.md"));
  assert.deepEqual(await rows(page), ["【檔案】", "週報.md"]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("網頁版：搜尋框寫「搜尋分頁或指令」；窄視窗時填滿 ◧ 與 ◨ 之間，不蓋到按鈕", async () => {
  const web = await open();
  assert.equal(await web.page.locator("#title-search .title-search-text").textContent(), "搜尋分頁或指令");
  await web.page.click("#title-search");
  await web.page.locator("dialog.palette[open]").waitFor();
  assert.deepEqual(await web.page.locator("dialog[open] .palette-tip").allTextContents(), [">指令"]);
  assert.deepEqual(web.errors, []);
  await web.context.close();

  const { page, context, errors } = await open({ desktop: desktop() });
  await page.setViewportSize({ width: 600, height: 700 });
  await page.waitForFunction(() => document.querySelector(".workspace").classList.contains("narrow"));
  const b = await box(page, "#title-search");
  const left = await box(page, ".topbar > .nav-toggle");
  const right = await box(page, ".top-actions");
  assert.ok(b.left >= left.right && b.right <= right.left, JSON.stringify({ b, left, right }));
  assert.ok(b.right - b.left > 150, `夠寬 ${JSON.stringify(b)}`);
  assert.equal(await page.locator("#title-search kbd").isVisible(), false, "窄視窗不顯示快速鍵");
  assert.deepEqual(errors, []);
  await context.close();
});

test("快速開啟的說明欄靠左對齊：每一行從同一個位置開始；還沒輸入時分成已開啟、資料夾、最近開啟三區，說明只寫所在的資料夾", async () => {
  const recent = ["C:\\Users\\me\\Downloads\\先看我.txt", "C:\\Users\\me\\Documents\\很長的資料夾名稱\\子資料夾\\再一層\\README.md", "C:\\Users\\me\\Desktop\\系統架構_流程_測試案例.md"];
  const { page, context, errors } = await open({ desktop: desktop({}, { recent: { files: recent, folders: [] } }) });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.locator("#files-head").waitFor();
  await page.keyboard.press("Control+P");
  await page.waitForFunction(() => [...document.querySelectorAll("dialog[open] .palette-section")].some((s) => s.textContent === "最近開啟"));
  const sections = await page.$$eval("dialog[open] .palette-section", (els) => els.map((e) => e.textContent));
  assert.deepEqual(sections, ["已開啟", "旅遊", "最近開啟"]);
  const rowsInfo = () =>
    page.$$eval("dialog[open] [role=option]", (lis) =>
      lis.flatMap((li) => {
        const d = li.querySelector(".palette-group");
        return d ? [{ title: li.querySelector(".palette-title").textContent, detail: d.textContent, left: Math.round(d.getBoundingClientRect().left) }] : [];
      }),
    );
  const empty = await rowsInfo();
  const recentRows = empty.filter((r) => recent.some((p) => p.endsWith(r.title)));
  assert.equal(recentRows.length, 3, JSON.stringify(empty));
  for (const r of recentRows) assert.doesNotMatch(r.detail, /最近開啟/, "區塊標題已經寫了，不用每一行都寫");
  assert.equal(new Set(empty.map((r) => r.left)).size, 1, `說明欄從同一個位置開始：${JSON.stringify(empty)}`);
  // 有輸入時也一樣對齊。
  await input(page).fill("md");
  await page.waitForFunction(() => document.querySelector("dialog[open] .palette-section")?.textContent === "檔案");
  const typed = await rowsInfo();
  assert.ok(typed.length > 2, JSON.stringify(typed));
  assert.equal(new Set(typed.map((r) => r.left)).size, 1, `說明欄從同一個位置開始：${JSON.stringify(typed)}`);
  assert.deepEqual(errors, []);
  await context.close();
});
