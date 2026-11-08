/**
 * COMET 專案裡由 COMET 管理的檔案：檔案面板標「C」；`.comet.json`、`.comet/` 裡的設定檔在編輯器預設唯讀
 * （上方說明，按「仍要編輯」才能改，「鎖上」再鎖回去）；COMET 產生的 AGENTS.md 也預設唯讀，說明不建議手動修改；
 * 刪除、改名 COMET 的檔案時說明會動到哪些，預設是取消。一般專案不受影響。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ROOT = "C:\\Users\\me\\Documents\\產品筆記";
const at = (rel) => `${ROOT}\\${rel.replace(/\//g, "\\")}`;
const entry = (rel, isDir = false) => ({ name: rel.slice(rel.lastIndexOf("/") + 1), path: at(rel), isDir });
const file = (rel, text) => ({ path: at(rel), name: rel.slice(rel.lastIndexOf("/") + 1), text, encoding: "utf-8" });
const project = (comet) => ({ path: ROOT, label: "產品筆記", name: null, color: null, group: null, pinned: false, lastOpened: 0, comet });
const SETTINGS = '{\n  "project": "產品"\n}\n';

const desktop = (comet) => ({
  startup_target: { kind: "folder", path: ROOT, name: "產品筆記" },
  projects_list: [[project(comet)]],
  list_dir: {
    $by: "path",
    values: {
      [ROOT]: [entry(".comet", true), entry("docs", true), entry(".comet.json"), entry("AGENTS.md"), entry("README.md")],
      [at("docs")]: [entry("docs/spec", true), entry("docs/週報.md")],
      [at("docs/spec")]: [entry("docs/spec/templates", true), entry("docs/spec/需求.md")],
      [at("docs/spec/templates")]: [entry("docs/spec/templates/功能.md")],
    },
  },
  reopen_file: {
    $by: "path",
    values: {
      [at(".comet.json")]: file(".comet.json", SETTINGS),
      [at("AGENTS.md")]: file("AGENTS.md", "# 給 AI 的說明\n"),
      [at("README.md")]: file("README.md", "# 產品筆記\n"),
      [at("docs/spec/templates/功能.md")]: file("docs/spec/templates/功能.md", "# 功能規格範本\n"),
      [at("docs/spec/需求.md")]: file("docs/spec/需求.md", "# 需求\n"),
    },
  },
});

const row = (page, rel) => page.locator(`#file-tree .tree-row[data-path="${at(rel).replace(/\\/g, "\\\\")}"]`);
const text = (page) => page.evaluate(() => [...document.querySelectorAll(".cm-content .cm-line")].map((l) => l.textContent).join("\n"));
const note = (page) => page.locator(".cm-editor .comet-note");

async function openFile(page, rel) {
  await row(page, rel).click();
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  await page.waitForFunction((n) => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent === n, name);
}

test("COMET 專案：檔案面板標「C」；設定檔與 AGENTS.md 預設唯讀，按「仍要編輯」才能改", async () => {
  const { page, context, errors } = await open({ desktop: desktop(true) });
  await row(page, ".comet.json").locator(".tree-mark").waitFor();
  const marked = await page.$$eval("#file-tree .tree-row", (rows) => rows.filter((r) => r.querySelector(".tree-mark")).map((r) => r.querySelector("span").textContent));
  assert.deepEqual(marked, [".comet", ".comet.json", "AGENTS.md"]);
  assert.equal(await row(page, "AGENTS.md").locator(".tree-mark").getAttribute("title"), "COMET 產生的檔案：不建議手動修改，在 oMarker 開啟時預設唯讀");
  // 規格的資料夾標「C」，裡面的規格文件不標。
  await row(page, "docs").click();
  await row(page, "docs/spec").locator(".tree-mark").waitFor();
  assert.equal(await row(page, "docs/週報.md").locator(".tree-mark").count(), 0);

  // 設定檔：唯讀，上方說明；打字、貼上、刪除都改不了，說明閃一下。
  await openFile(page, ".comet.json");
  await note(page).locator("text=預設唯讀").waitFor();
  assert.equal(await note(page).getAttribute("data-locked"), "1");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("abc");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.locator(".cm-content").evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "貼上的文字");
    el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
  });
  await page.keyboard.press("Control+Z");
  assert.equal(await text(page), SETTINGS);
  assert.equal(await page.locator("#tab-bar .tab[aria-selected=true]").evaluate((el) => el.classList.contains("dirty")), false);

  // 「仍要編輯」：這個分頁可以改了；「鎖上」再鎖回去。
  await note(page).getByRole("button", { name: "仍要編輯" }).click();
  assert.equal(await note(page).getAttribute("data-locked"), "");
  await note(page).locator("text=可以編輯這個 COMET 設定檔了").waitFor();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("x");
  assert.match(await text(page), /x$/);
  await note(page).getByRole("button", { name: "鎖上" }).click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("y");
  assert.match(await text(page), /x$/);

  // AGENTS.md：也預設唯讀，說明不建議手動修改；想改時說明閃一下，按「仍要編輯」才能改。
  await openFile(page, "AGENTS.md");
  await note(page).locator("text=不建議手動修改").waitFor();
  assert.equal(await note(page).getAttribute("data-locked"), "1");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("新增");
  await page.keyboard.press("Backspace");
  assert.doesNotMatch(await text(page), /新增|新/);
  assert.equal(await note(page).evaluate((el) => el.classList.contains("comet-note-nudge")), true);
  await note(page).getByRole("button", { name: "仍要編輯" }).click();
  await note(page).locator("text=修改前請先提交到 Git").waitFor();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("新增");
  assert.match(await text(page), /新增$/);

  // 一般的檔案：沒有說明。
  await openFile(page, "README.md");
  await page.waitForTimeout(100);
  assert.equal(await note(page).count(), 0);
  // 切回設定檔：還是鎖著。
  await page.locator("#tab-bar .tab", { hasText: ".comet.json" }).click();
  await note(page).locator("text=預設唯讀").waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test("只顯示預覽時：預覽上方也有 COMET 的說明，按「仍要編輯」切到可以編輯的檢視", async () => {
  const { page, context, errors } = await open({ desktop: desktop(true) });
  await row(page, "AGENTS.md").locator(".tree-mark").waitFor();
  await openFile(page, "AGENTS.md");
  await note(page).locator("text=不建議手動修改").waitFor();
  const pnote = page.locator("#preview-scroller > .preview-comet-note");
  // 分割、即時預覽：編輯器上方已經有了，預覽上方不重複。
  assert.equal(await pnote.isVisible(), false);

  await page.locator(".segmented [data-view=preview]").click();
  await pnote.locator("text=不建議手動修改").waitFor();
  assert.equal(await pnote.getAttribute("data-locked"), "1");
  await pnote.getByRole("button", { name: "仍要編輯" }).click();
  await page.waitForFunction(() => document.querySelector(".segmented [data-view=live]")?.getAttribute("aria-checked") === "true");
  await note(page).locator("text=修改前請先提交到 Git").waitFor();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("新增");
  assert.match(await text(page), /新增$/);

  // 回到預覽：說明跟著顯示已解除唯讀，「鎖上」再鎖回去。
  await page.locator(".segmented [data-view=preview]").click();
  await pnote.locator("text=修改前請先提交到 Git").waitFor();
  await pnote.getByRole("button", { name: "鎖上" }).click();
  await pnote.locator("text=不建議手動修改").waitFor();
  assert.equal(await note(page).getAttribute("data-locked"), "1");

  // 一般的檔案：預覽上方沒有說明。
  await openFile(page, "README.md");
  await page.waitForFunction(() => document.querySelector("#preview-scroller > .preview-comet-note")?.hidden === true);
  assert.equal(await pnote.isVisible(), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test("規格範本（docs/spec/templates）：資料夾標「C」，裡面的檔案預設唯讀；其他規格照常編輯；刪除前說明", async () => {
  const { page, context, errors } = await open({ desktop: desktop(true) });
  await row(page, "AGENTS.md").locator(".tree-mark").waitFor();
  await row(page, "docs").click();
  await row(page, "docs/spec").click();
  await row(page, "docs/spec/templates").locator(".tree-mark").waitFor();
  assert.equal(await row(page, "docs/spec/templates").locator(".tree-mark").getAttribute("title"), "COMET 的規格範本：AI 照著它寫規格，在 oMarker 開啟時預設唯讀");
  assert.equal(await row(page, "docs/spec/需求.md").locator(".tree-mark").count(), 0);

  await row(page, "docs/spec/templates").click();
  await openFile(page, "docs/spec/templates/功能.md");
  await note(page).locator("text=這是 COMET 的規格範本").waitFor();
  assert.equal(await note(page).getAttribute("data-locked"), "1");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("改");
  assert.doesNotMatch(await text(page), /改/);
  await note(page).getByRole("button", { name: "仍要編輯" }).click();
  await note(page).locator("text=可以編輯這個 COMET 規格範本了").waitFor();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("改");
  assert.match(await text(page), /改$/);

  // 其他規格文件：照常編輯，沒有說明。
  await openFile(page, "docs/spec/需求.md");
  await page.waitForTimeout(100);
  assert.equal(await note(page).count(), 0);

  // 刪除範本資料夾：說明會動到 COMET 的檔案，預設是取消。
  const dialog = page.locator("dialog[open].choice");
  await row(page, "docs/spec/templates").focus();
  await page.keyboard.press("Delete");
  await dialog.waitFor();
  assert.match(await dialog.locator("p").first().textContent(), /^「docs\/spec\/templates」是 COMET 用到的檔案，刪除後 COMET 可能無法正常運作。/);
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "detached" });
  const cmds = (await calls(page)).map((c) => c.cmd);
  assert.ok(!cmds.includes("trash_entry"), cmds.join("|"));
  assert.deepEqual(errors, []);
  await context.close();
});

test("刪除、改名 COMET 的檔案：說明會動到哪些，預設是取消", async () => {
  const { page, context, errors } = await open({ desktop: desktop(true) });
  await row(page, "AGENTS.md").locator(".tree-mark").waitFor();
  const dialog = page.locator("dialog[open].choice");
  const buttons = () =>
    dialog.locator(".choice-actions button").evaluateAll((list) => list.map((b) => ({ label: b.textContent, danger: b.classList.contains("btn-danger"), focused: document.activeElement === b })));

  await row(page, "AGENTS.md").focus();
  await page.keyboard.press("Delete");
  await dialog.waitFor();
  assert.equal(await dialog.locator("h2").textContent(), "要刪除 COMET 的檔案嗎？");
  assert.match(await dialog.locator("p").first().textContent(), /^「AGENTS\.md」是 COMET 用到的檔案，刪除後 COMET 可能無法正常運作。要把「AGENTS\.md」移到資源回收筒嗎？/);
  assert.deepEqual(await buttons(), [
    { label: "仍要移到資源回收筒", danger: true, focused: false },
    { label: "取消", danger: false, focused: true },
  ]);
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "detached" });

  // 裝著規格的資料夾：說明會動到 docs/spec。
  await row(page, "docs").focus();
  await page.keyboard.press("Delete");
  await dialog.waitFor();
  assert.match(await dialog.locator("p").first().textContent(), /^「docs\/spec」是 COMET 用到的檔案/);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });

  // 一般的檔案：照舊。
  await row(page, "README.md").focus();
  await page.keyboard.press("Delete");
  await dialog.waitFor();
  assert.equal(await dialog.locator("h2").textContent(), "移到資源回收筒？");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });

  // 改名：輸入新名稱後多問一次，取消就不改。
  await row(page, "AGENTS.md").focus();
  await page.keyboard.press("F2");
  await page.locator("#file-tree input.tree-input").fill("說明.md");
  await page.keyboard.press("Enter");
  await dialog.waitFor();
  assert.equal(await dialog.locator("h2").textContent(), "要改名 COMET 的檔案嗎？");
  assert.match(await dialog.locator("p").first().textContent(), /改名後 COMET 可能找不到它/);
  await dialog.getByRole("button", { name: "取消" }).click();
  await dialog.waitFor({ state: "detached" });
  const cmds = (await calls(page)).map((c) => c.cmd);
  assert.ok(!cmds.includes("trash_entry") && !cmds.includes("rename_entry"), cmds.join("|"));
  assert.deepEqual(errors, []);
  await context.close();
});

test("一般專案：同樣的檔案不標「C」、不鎖", async () => {
  const { page, context, errors } = await open({ desktop: desktop(false) });
  await row(page, ".comet.json").waitFor();
  assert.equal(await page.locator("#file-tree .tree-mark").count(), 0);
  await openFile(page, ".comet.json");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("x");
  assert.match(await text(page), /x$/);
  assert.equal(await note(page).count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("設定檔鎖著時被 comet 改了：照常重新載入新的內容", async () => {
  const changed = '{\n  "project": "產品",\n  "sprint": 13\n}\n';
  const { page, context, errors } = await open({
    desktop: { ...desktop(true), reopen_file: [file(".comet.json", SETTINGS), file(".comet.json", changed)] },
  });
  await row(page, ".comet.json").locator(".tree-mark").waitFor();
  await openFile(page, ".comet.json");
  await note(page).locator("text=預設唯讀").waitFor();
  await page.evaluate((path) => window.__fake.emit("file-changed", { path }), at(".comet.json"));
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("sprint"));
  assert.equal(await text(page), changed);
  // 還是鎖著。
  assert.equal(await note(page).getAttribute("data-locked"), "1");
  assert.deepEqual(errors, []);
  await context.close();
});
