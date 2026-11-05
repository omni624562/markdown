/**
 * 左側圖示列的檔案捷徑：本機的文字檔（例如 MENO.txt、週報.md）用分頁或檔案樹的右鍵選單「放到左側圖示列」，
 * 或從檔案樹拖到圖示列。捷徑是檔名第一個字的方塊、右下角是副檔名，滑鼠提示是完整路徑；
 * 按一下開啟（已經開著就切過去），開在中間時右下角有小圓點。檔案搬走或刪除時說明，通知上可以直接移除。
 * 遠端資料夾（SSH、WebDAV）的檔案不行。用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ROOT = { kind: "folder", path: "D:\\筆記", name: "筆記" };
const WEEKLY = "D:\\筆記\\週報.md";
const README = "D:\\筆記\\README-v6.5.0.md";
const MENO = "D:\\Tools\\Notepad++\\MENO.txt";
const GONE = "D:\\Tools\\舊的\\搬走了.txt";
const name = (path) => path.slice(path.lastIndexOf("\\") + 1);
const file = (path, text) => ({ path, name: name(path), text, encoding: "utf-8" });
const entry = (path) => ({ name: name(path), path, isDir: false });
const desktop = {
  startup_target: ROOT,
  list_dir: { $by: "path", values: { [ROOT.path]: [entry(README), entry(WEEKLY)] } },
  list_files: [
    [
      { path: README, rel: name(README) },
      { path: WEEKLY, rel: name(WEEKLY) },
    ],
  ],
  scan_docs: [[]],
  reopen_file: {
    $by: "path",
    values: {
      [WEEKLY]: file(WEEKLY, "# 週報\n"),
      [README]: file(README, "# README\n"),
      [MENO]: file(MENO, "MENO\n"),
      [GONE]: { $error: "無法讀取「搬走了.txt」：系統找不到指定的檔案。" },
    },
  },
  // 搬走的檔案已經不在了。
  paths_exist: [[false]],
};

const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("md-editor:wiki-shortcuts") ?? "[]"));
const trusted = async (page) => (await calls(page)).filter((c) => c.cmd === "set_file_shortcuts").map((c) => c.args.paths);
const activeTab = (page) => page.textContent("#tab-bar .tab[aria-selected=true] .tab-name");
const tile = (page, path) => page.locator(`.activity-file[title="${path.replaceAll("\\", "\\\\")}"]`);

/** 在分頁上按右鍵，回傳選單裡的項目名稱。 */
async function tabMenu(page, tabName) {
  await page.locator("#tab-bar .tab", { hasText: tabName }).click({ button: "right" });
  const menu = page.locator("#tab-menu-anchor-popover");
  await menu.waitFor();
  return menu;
}

test("分頁的右鍵選單「放到左側圖示列」：方塊上是檔名的字與副檔名，提示完整路徑；按一下切回這個分頁，開著時有小圓點", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.locator("#file-tree .tree-row", { hasText: "週報.md" }).click();
  await page.waitForFunction(() => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent === "週報.md");
  let menu = await tabMenu(page, "週報.md");
  assert.equal(await menu.locator("button", { hasText: "從左側圖示列移除" }).count(), 0);
  await menu.locator("button", { hasText: "放到左側圖示列" }).click();
  await page.locator(".toast", { hasText: "已把「週報.md」放到左側圖示列" }).waitFor();
  const sc = tile(page, WEEKLY);
  await sc.waitFor();
  assert.deepEqual(await saved(page), [{ file: WEEKLY }]);
  // 告訴原生端：之後不在「最近開啟」裡也開得了。
  assert.deepEqual((await trusted(page)).at(-1), [WEEKLY]);
  const look = await sc.evaluate((b) => ({
    initial: b.querySelector(".wiki-badge").textContent,
    ext: b.querySelector(".file-ext").textContent,
    label: b.getAttribute("aria-label"),
    current: b.getAttribute("aria-current"),
    dot: getComputedStyle(b, "::after").content,
  }));
  assert.deepEqual(look, { initial: "週", ext: "md", label: "週報.md", current: "page", dot: '""' });
  // 已經放了：選單改成「從左側圖示列移除」。
  menu = await tabMenu(page, "週報.md");
  assert.equal(await menu.locator("button", { hasText: "放到左側圖示列" }).count(), 0);
  assert.equal(await menu.locator("button", { hasText: "從左側圖示列移除" }).count(), 1);
  await page.keyboard.press("Escape");
  // 換到別的檔案：小圓點不見；按捷徑切回已經開著的分頁（不重新讀檔）。
  await page.locator("#file-tree .tree-row", { hasText: "README-v6.5.0.md" }).click();
  await page.waitForFunction(() => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent === "README-v6.5.0.md");
  assert.equal(await sc.getAttribute("aria-current"), null);
  const reads = (await calls(page)).filter((c) => c.cmd === "reopen_file").length;
  await sc.click();
  await page.waitForFunction(() => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent === "週報.md");
  assert.equal(await sc.getAttribute("aria-current"), "page");
  assert.equal((await calls(page)).filter((c) => c.cmd === "reopen_file").length, reads, "已經開著就切過去");
  assert.equal(await page.locator("#tab-bar .tab", { hasText: "週報.md" }).count(), 1);
  // 從選單移除。
  menu = await tabMenu(page, "週報.md");
  await menu.locator("button", { hasText: "從左側圖示列移除" }).click();
  await sc.waitFor({ state: "detached" });
  assert.deepEqual(await saved(page), []);
  // 把分頁拖到圖示列也可以。
  await page.locator("#tab-bar .tab", { hasText: "README-v6.5.0.md" }).dragTo(page.locator(".activity-bar"), { targetPosition: { x: 24, y: 600 } });
  await tile(page, README).waitFor();
  assert.deepEqual(await saved(page), [{ file: README }]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("按檔案捷徑開啟還沒開的檔案（不在目前的資料夾裡也可以）；從檔案樹拖到圖示列也會變成捷徑", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.evaluate((path) => localStorage.setItem("md-editor:wiki-shortcuts", JSON.stringify([{ file: path }])), MENO);
  await page.reload();
  const sc = tile(page, MENO);
  await sc.waitFor();
  assert.equal(await sc.locator(".file-ext").textContent(), "txt");
  assert.equal(await sc.getAttribute("aria-current"), null);
  await sc.click();
  await page.waitForFunction(() => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent === "MENO.txt");
  assert.ok((await calls(page)).some((c) => c.cmd === "reopen_file" && c.args.path === MENO));
  await page.waitForFunction(() => document.querySelector(".activity-file")?.getAttribute("aria-current") === "page");
  // 從檔案樹拖到圖示列：放在 MENO.txt 下面。
  await page.locator("#file-tree .tree-row", { hasText: "README-v6.5.0.md" }).dragTo(page.locator(".activity-bar"), { targetPosition: { x: 24, y: 700 } });
  await tile(page, README).waitFor();
  assert.deepEqual(await saved(page), [{ file: MENO }, { file: README }]);
  assert.equal(await activeTab(page), "MENO.txt", "拖曳不會開啟檔案");
  // 檔案樹的右鍵選單：已經放了的是「從左側圖示列移除」。
  await page.locator("#file-tree .tree-row", { hasText: "README-v6.5.0.md" }).click({ button: "right" });
  const treeMenu = page.locator(".menu:popover-open");
  await treeMenu.locator("button", { hasText: "從左側圖示列移除" }).click();
  await tile(page, README).waitFor({ state: "detached" });
  await page.locator("#file-tree .tree-row", { hasText: "週報.md" }).click({ button: "right" });
  await treeMenu.locator("button", { hasText: "放到左側圖示列" }).click();
  await tile(page, WEEKLY).waitFor();
  assert.deepEqual(await saved(page), [{ file: MENO }, { file: WEEKLY }]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("檔案搬走或刪除：提示「找不到這個檔案」，通知上可以從左側圖示列移除", async () => {
  const { page, context, errors } = await open({ desktop });
  await page.evaluate((list) => localStorage.setItem("md-editor:wiki-shortcuts", JSON.stringify(list)), [{ file: MENO }, { file: GONE }]);
  await page.reload();
  await tile(page, GONE).click();
  const note = page.locator(".toast", { hasText: "找不到這個檔案" });
  await note.waitFor();
  assert.match(await note.textContent(), /「搬走了\.txt」可能已經搬走或刪除/);
  assert.ok((await calls(page)).some((c) => c.cmd === "paths_exist" && c.args.paths[0] === GONE));
  await note.locator("button", { hasText: "從左側圖示列移除" }).click();
  await tile(page, GONE).waitFor({ state: "detached" });
  assert.deepEqual(await saved(page), [{ file: MENO }]);
  assert.deepEqual((await trusted(page)).at(-1), [MENO]);
  assert.equal(await page.locator("#tab-bar .tab", { hasText: "搬走了.txt" }).count(), 0, "沒有開出空白的分頁");
  assert.deepEqual(errors, []);
  await context.close();
});

test("遠端資料夾（SSH）的檔案不能放到圖示列：選單沒有這一項、拖的資料裡沒有捷徑；網頁版也沒有", async () => {
  const REMOTE = "ssh://cd34/筆記/週報.md";
  const remote = {
    startup_target: { kind: "folder", path: "ssh://cd34/筆記", name: "筆記" },
    dav_list: { $by: "path", values: { "ssh://cd34/筆記": [{ name: "週報.md", path: REMOTE, isDir: false }] } },
    dav_list_files: [[]],
    scan_docs: [[]],
    dav_read: { path: REMOTE, name: "週報.md", text: "# 週報\n", encoding: "utf-8" },
  };
  const { page, context, errors } = await open({ desktop: remote });
  const row = page.locator("#file-tree .tree-row", { hasText: "週報.md" });
  await row.click();
  await page.waitForFunction(() => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent === "週報.md");
  assert.equal(await row.getAttribute("draggable"), "false");
  // 分頁拖得起來（可以拖到編輯區並排），但拖的資料裡沒有捷徑，放到圖示列不會變成捷徑。
  const dragTypes = await page.locator("#tab-bar .tab[aria-selected=true]").evaluate((tab) => {
    const dt = new DataTransfer();
    tab.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
    return [...dt.types];
  });
  assert.ok(!dragTypes.includes("application/x-omarker-shortcut"), dragTypes.join());
  assert.ok(dragTypes.includes("application/x-omarker-tab"), dragTypes.join());
  const menu = await tabMenu(page, "週報.md");
  assert.equal(await menu.locator("button", { hasText: "左側圖示列" }).count(), 0);
  await page.keyboard.press("Escape");
  await row.click({ button: "right" });
  const treeMenu = page.locator(".menu:popover-open");
  await treeMenu.locator("button").first().waitFor();
  assert.equal(await treeMenu.locator("button", { hasText: "左側圖示列" }).count(), 0);
  // 就算拖曳的資料帶著遠端路徑，放到圖示列也不收。
  await page.evaluate((path) => {
    const dt = new DataTransfer();
    dt.setData("application/x-omarker-shortcut", JSON.stringify({ file: path }));
    const bar = document.querySelector(".activity-bar");
    bar.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    bar.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, REMOTE);
  assert.equal(await page.locator(".activity-file").count(), 0);
  assert.deepEqual(await saved(page), []);
  assert.deepEqual(errors, []);
  await context.close();

  // 網頁版：沒有原生端，檔案捷徑不顯示；分頁拖得起來（拖到編輯區並排），但拖的資料裡沒有捷徑。
  const web = await open();
  await web.page.evaluate((path) => localStorage.setItem("md-editor:wiki-shortcuts", JSON.stringify([{ file: path }])), MENO);
  await web.page.reload();
  await web.page.waitForSelector(".cm-editor .cm-content");
  assert.equal(await web.page.locator(".activity-wiki").isHidden(), true);
  const webTypes = await web.page.locator("#tab-bar .tab").first().evaluate((tab) => {
    const dt = new DataTransfer();
    tab.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
    return [...dt.types];
  });
  assert.ok(!webTypes.includes("application/x-omarker-shortcut"), webTypes.join());
  assert.deepEqual(web.errors, []);
  await web.context.close();
});
