/**
 * 助理的批次處理（app/assistant-batch.ts）：資料夾右鍵「助理：批次處理這個資料夾…」開對話框，先顯示讀取中，
 * 再顯示會處理幾份文件與估計費用；選動作後送出，每一份文件一則要求（之前的結果、資料夾外的文件不送）；
 * 助理面板下方的「批次」列出進度，處理完提示寫了幾個檔案；可以取消、移除。專案還沒允許 AI 時選單沒有這一項。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\個人筆記";
const DIR = `${ROOT}\\行程`;
const info = { tasks: [], tags: [], links: [] };
const docs = [
  { path: `${ROOT}\\總覽.md`, rel: "總覽.md", mtime: 1, info },
  { path: `${DIR}\\第一天.md`, rel: "行程\\第一天.md", mtime: 1, info },
  { path: `${DIR}\\第一天.摘要.md`, rel: "行程\\第一天.摘要.md", mtime: 1, info },
  { path: `${DIR}\\第二天.md`, rel: "行程\\第二天.md", mtime: 1, info },
];
const texts = ["整趟旅行的總覽。", "第一天早上八點在車站集合。", "之前的摘要。", "第二天搭地鐵到博物館。"];
const orders = (list) => (list.length < 2 ? [list] : list.flatMap((x, i) => orders([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [x, ...rest])));
const batch = (extra) => ({
  id: "msgbatch_1",
  created: "2026-11-15 21:30",
  folder: DIR,
  action: "摘要",
  total: 2,
  state: "processing",
  canceling: false,
  finished: 0,
  written: 0,
  failed: 0,
  usd: 0,
  needsFolder: null,
  justDone: false,
  ...extra,
});
const desktop = (settings, extra) => ({
  load_settings: JSON.stringify(settings),
  startup_target: { kind: "folder", path: ROOT, name: "個人筆記" },
  list_dir: { $by: "path", values: { [ROOT]: [{ name: "行程", path: DIR, isDir: true }], [DIR]: [] } },
  scan_docs: [docs],
  // 只會讀資料夾裡的那三份；順序由索引決定，每一種順序都給對應的內容。
  read_docs: { $by: "paths", values: Object.fromEntries(orders([1, 2, 3]).map((o) => [o.map((i) => docs[i].path).join(","), o.map((i) => texts[i])])) },
  assistant_key_status: true,
  assistant_usage: { month: "2026-11", usd: 0.42, limit: 10 },
  assistant_batch_list: [[]],
  ...extra,
});
const ON = { claudeApiEnabled: true, assistantProjects: [ROOT] };

const openProject = (page) => page.waitForFunction(() => document.querySelector("#folder-name").textContent === "個人筆記");
const folderRow = (page) => page.locator("#file-tree .tree-row", { hasText: "行程" });
const called = async (page, cmd) => (await calls(page)).filter((c) => c.cmd === cmd);

test("資料夾右鍵送出批次：顯示份數與費用，每份文件一則要求；批次清單顯示進度，處理完提示並可移除", async () => {
  const { page, context, errors } = await open({
    desktop: desktop(ON, {
      assistant_batch_create: batch(),
      assistant_batch_check: [batch({ finished: 1 }), batch({ state: "done", finished: 2, written: 2, usd: 0.0123, justDone: true })],
    }),
  });
  await openProject(page);
  await folderRow(page).click({ button: "right" });
  await page.getByRole("menuitem", { name: "助理：批次處理這個資料夾…" }).click();
  const dialog = page.locator("dialog.batch-dialog[open]");
  await dialog.waitFor();
  assert.equal(await dialog.locator("h2").textContent(), "批次處理「行程」");
  // 可以整批做的動作：摘要、審稿…；改寫、翻譯（取代選取文字）不在裡面。
  const options = await dialog.locator("select option").allTextContents();
  assert.ok(options.includes("摘要") && options.includes("審稿"), options.join());
  assert.ok(!options.includes("改寫") && !options.includes("翻譯"), options.join());
  // 讀到文件後：資料夾裡的 2 份（之前的結果、資料夾外的不算）。
  await dialog.locator(".batch-scope", { hasText: "2 份 Markdown 文件" }).waitFor();
  assert.match(await dialog.locator(".batch-cost").textContent(), /估計費用約 US\$[\d.]+（claude-/);
  assert.match(await dialog.textContent(), /例如「筆記\.摘要\.md」.*不會改到原檔/);
  assert.match(await dialog.textContent(), /會送到 Anthropic.*費用是平常的一半/);
  await dialog.getByRole("button", { name: "送出批次" }).click();
  await page.locator(".toast", { hasText: "已送出批次：2 份文件" }).waitFor();
  const [{ args }] = await called(page, "assistant_batch_create");
  assert.equal(args.request.folder, DIR);
  assert.equal(args.request.action, "摘要");
  assert.equal(args.request.suffix, "摘要");
  assert.deepEqual(
    args.request.items.map((i) => i.path),
    [`${DIR}\\第一天.md`, `${DIR}\\第二天.md`],
  );
  assert.match(args.request.items[0].content, /<document name="第一天\.md">\n第一天早上八點在車站集合。\n<\/document>\n\n請用條列重點摘要/);
  assert.equal(await page.locator("dialog.batch-dialog[open]").count(), 0);

  // 助理面板下方的「批次」：處理中的進度；再問一次就處理完了。
  await page.keyboard.press("Control+Shift+L");
  const button = page.locator("#assistant-panel .assistant-batches");
  await button.waitFor();
  assert.equal(await button.textContent(), "批次（1 個處理中）");
  await button.click();
  const pop = page.locator(".batch-pop");
  await pop.locator(".batch-status", { hasText: "處理中（已完成 1／2）" }).waitFor();
  assert.match(await pop.locator(".batch-row strong").textContent(), /摘要・行程/);
  await pop.getByRole("button", { name: "重新整理" }).click();
  await pop.locator(".batch-status", { hasText: "已完成：寫了 2 個檔案、US$0.01" }).waitFor();
  await page.locator(".toast", { hasText: "批次「摘要・行程」已完成：寫了 2 個檔案" }).waitFor();
  assert.equal(await button.textContent(), "批次");
  // 做完的可以移除；清單空了按鈕就收起來。
  await pop.getByRole("button", { name: "移除" }).click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "assistant_batch_remove"));
  assert.deepEqual((await called(page, "assistant_batch_remove"))[0].args, { id: "msgbatch_1" });
  await page.waitForFunction(() => document.querySelector("#assistant-panel .assistant-batches").hidden);
  assert.deepEqual(errors, []);
  await context.close();
});

test("上次送出的批次：啟動時就問狀態；可以取消；要先打開原本的資料夾時說清楚", async () => {
  const { page, context, errors } = await open({
    desktop: desktop(ON, {
      assistant_batch_list: [[batch(), batch({ id: "msgbatch_2", action: "審稿", folder: `C:\\Users\\me\\Documents\\旅遊\\景點` })]],
      assistant_batch_check: {
        $by: "id",
        values: { msgbatch_1: batch({ finished: 1 }), msgbatch_2: batch({ id: "msgbatch_2", action: "審稿", finished: 2, needsFolder: "C:\\Users\\me\\Documents\\旅遊" }) },
      },
      assistant_batch_cancel: batch({ finished: 1, canceling: true }),
    }),
  });
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "assistant_batch_check").length >= 2);
  await openProject(page);
  await page.keyboard.press("Control+Shift+L");
  const button = page.locator("#assistant-panel .assistant-batches");
  await button.waitFor();
  assert.equal(await button.textContent(), "批次（2 個處理中）");
  await button.click();
  const pop = page.locator(".batch-pop");
  await pop.locator(".batch-status", { hasText: "處理完了；打開「旅遊」資料夾後會領取結果" }).waitFor();
  const first = pop.locator(".batch-row", { hasText: "摘要・行程" });
  await first.getByRole("button", { name: "取消" }).click();
  await first.locator(".batch-status", { hasText: "取消中…" }).waitFor();
  assert.equal(await first.getByRole("button", { name: "取消" }).isDisabled(), true);
  assert.deepEqual((await called(page, "assistant_batch_cancel"))[0].args, { id: "msgbatch_1" });
  assert.deepEqual(errors, []);
  await context.close();
});

test("專案還沒允許 AI：資料夾的右鍵選單沒有批次處理", async () => {
  const { page, context, errors } = await open({ desktop: desktop({ claudeApiEnabled: true, assistantProjects: [] }) });
  await openProject(page);
  await folderRow(page).click({ button: "right" });
  await page.getByRole("menuitem", { name: "新增檔案" }).waitFor();
  assert.equal(await page.getByRole("menuitem", { name: /批次處理/ }).count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
