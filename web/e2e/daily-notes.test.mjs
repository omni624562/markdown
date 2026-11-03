/**
 * 每日筆記：「今天的筆記」在開啟的資料夾裡建立 每日筆記/今天.md（用範本、存檔、游標在第一個待辦），
 * 已經有就直接打開；「前一天／後一天的筆記」跳過沒寫的日子。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

/** 從指令面板執行（開資料夾後的空白文件顯示起始頁，不先點編輯區）。 */
async function runCommand(page, query) {
  await page.keyboard.press("Control+Shift+P");
  const input = page.locator("dialog[open] input").first();
  await input.waitFor();
  await input.fill(query);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector("dialog[open].palette, dialog[open] .palette"));
}

const ROOT = { kind: "folder", path: "/notes", name: "notes" };
const DIR = "/notes/每日筆記";
const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const WEEKDAY = "日一二三四五六"[now.getDay()];
const file = (name, text = "") => ({ path: `${DIR}/${name}`, name, text, encoding: "utf-8" });
const dirEntry = { name: "每日筆記", path: DIR, isDir: true };
const noteEntry = (name) => ({ name, path: `${DIR}/${name}`, isDir: false });

test("今天的筆記：資料夾和檔案都還沒有時建立，填好範本並存檔，直接打字就是第一個待辦", async () => {
  const { page, context, errors } = await open({
    desktop: {
      startup_target: ROOT,
      list_dir: { $by: "path", values: { "/notes": [], [DIR]: [] } },
      create_entry: { $by: "name", values: { 每日筆記: DIR, [`${TODAY}.md`]: `${DIR}/${TODAY}.md` } },
      reopen_file: file(`${TODAY}.md`),
      save_file: { status: "saved", path: `${DIR}/${TODAY}.md`, name: `${TODAY}.md` },
    },
  });
  await page.waitForSelector(".cm-content");
  await runCommand(page, "今天的筆記");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "save_file"));
  const all = await calls(page);
  const created = all.filter((c) => c.cmd === "create_entry").map((c) => c.args);
  assert.deepEqual(created, [
    { parent: "/notes", name: "每日筆記", isDir: true },
    { parent: DIR, name: `${TODAY}.md`, isDir: false },
  ]);
  const saved = all.find((c) => c.cmd === "save_file").args;
  assert.equal(saved.path, `${DIR}/${TODAY}.md`);
  assert.match(saved.text, new RegExp(`^# ${TODAY}（星期${WEEKDAY}）\\n`));
  assert.match(saved.text, /## 今天要做\n\n- \[ \] \n/);
  assert.match(await page.textContent(".tab[aria-selected=true] .tab-name"), new RegExp(TODAY));
  // 游標停在第一個待辦後面：直接打字就是待辦事項。
  await page.keyboard.insertText("寫週報");
  await page.keyboard.press("Control+S");
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "save_file").length === 2);
  const again = (await calls(page)).filter((c) => c.cmd === "save_file")[1].args;
  assert.match(again.text, /## 今天要做\n\n- \[ \] 寫週報\n/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("今天的筆記已經有了就直接打開；前一天、後一天跳過沒寫的日子", async () => {
  const notes = [`${TODAY}.md`, "2020-01-05.md", "會議.md", "2020-01-01.md"];
  const { page, context, errors } = await open({
    desktop: {
      startup_target: ROOT,
      list_dir: { $by: "path", values: { "/notes": [dirEntry], [DIR]: notes.map(noteEntry) } },
      reopen_file: {
        $by: "path",
        values: Object.fromEntries(notes.map((n) => [`${DIR}/${n}`, file(n, `# ${n}\n`)])),
      },
    },
  });
  await page.waitForSelector(".cm-content");
  const opened = () => page.evaluate(() => window.__fake.calls.filter((c) => c.cmd === "reopen_file").map((c) => c.args.path));
  const waitOpened = (n) => page.waitForFunction((n) => window.__fake.calls.filter((c) => c.cmd === "reopen_file").length === n, n);
  await runCommand(page, "今天的筆記");
  await waitOpened(1);
  assert.deepEqual(await opened(), [`${DIR}/${TODAY}.md`]);
  assert.equal((await calls(page)).filter((c) => c.cmd === "create_entry").length, 0, "已經有了不再建立");
  await runCommand(page, "前一天的筆記");
  await waitOpened(2);
  await runCommand(page, "前一天的筆記");
  await waitOpened(3);
  assert.deepEqual((await opened()).slice(1), [`${DIR}/2020-01-05.md`, `${DIR}/2020-01-01.md`]);
  // 最早的一份再往前：提示沒有了。
  await runCommand(page, "前一天的筆記");
  await page.waitForSelector(".toast", { hasText: "沒有更早的每日筆記" });
  // 往後：回到 1/5（已經開著的分頁直接切過去，不重讀檔案）。
  await runCommand(page, "後一天的筆記");
  await page.waitForFunction(() => document.querySelector(".cm-content").textContent.includes("2020-01-05"));
  assert.deepEqual(errors, []);
  await context.close();
});

test("設定：資料夾可以有好幾層，選自訂範本；寫錯的資料夾不接受", async () => {
  const nested = "/notes/筆記/每日";
  const { page, context, errors } = await open({
    desktop: {
      startup_target: ROOT,
      load_settings: JSON.stringify({ templates: [{ name: "工作日誌", body: "# {{日期}} 工作日誌\n\n## 完成\n\n" }] }),
      list_dir: { $by: "path", values: { "/notes": [{ name: "筆記", path: "/notes/筆記", isDir: true }], "/notes/筆記": [], [nested]: [] } },
      create_entry: { $by: "name", values: { 每日: nested, [`${TODAY}.md`]: `${nested}/${TODAY}.md` } },
      reopen_file: { path: `${nested}/${TODAY}.md`, name: `${TODAY}.md`, text: "", encoding: "utf-8" },
      save_file: { status: "saved", path: `${nested}/${TODAY}.md`, name: `${TODAY}.md` },
      save_settings: true,
    },
  });
  await page.waitForSelector(".cm-content");
  await runCommand(page, "設定");
  await page.click("dialog[open] [role=tab]:has-text('編輯')");
  const folder = page.locator("#setting-dailyFolder");
  assert.equal(await folder.inputValue(), "每日筆記");
  // 跳出開啟的資料夾：不接受，顯示回原本的設定。
  await folder.fill("../外面");
  await folder.press("Enter");
  assert.equal(await folder.inputValue(), "每日筆記");
  // \ 也可以，存成一致的寫法。
  await folder.fill(" 筆記\\每日 ");
  await folder.press("Enter");
  assert.equal(await folder.inputValue(), "筆記/每日");
  const options = await page.locator("#setting-dailyTemplate option").allTextContents();
  assert.deepEqual(options, ["內建（今天要做、會議與討論、筆記）", "工作日誌"]);
  await page.selectOption("#setting-dailyTemplate", "工作日誌");
  await page.keyboard.press("Escape");
  await runCommand(page, "今天的筆記");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "save_file"));
  const all = await calls(page);
  // 已經有的「筆記」沿用，只建立「每日」。
  assert.deepEqual(
    all.filter((c) => c.cmd === "create_entry").map((c) => c.args.name),
    ["每日", `${TODAY}.md`],
  );
  assert.equal(all.find((c) => c.cmd === "save_file").args.text, `# ${TODAY} 工作日誌\n\n## 完成\n\n`);
  assert.deepEqual(errors, []);
  await context.close();
});

test("今天的筆記：連上 Azure DevOps 時多一段指派給我、還沒結束的工作項目（待辦清單）；也可以插入到目前的文件", async () => {
  const wi = (id, title, priority) => ({
    id,
    title,
    priority,
    state: "Active",
    kind: "Task",
    project: "產品",
    assignedTo: "王小明",
    changed: "2026-11-01T00:00:00Z",
    webUrl: `https://ado.test/c/產品/_workitems/edit/${id}`,
  });
  const { page, context, errors } = await open({
    desktop: {
      startup_target: ROOT,
      ado_account: { url: "https://ado.test/c", name: "王小明" },
      ado_work_items: [[wi(11, "寫測試", 2), wi(12, "修正登入", 1)]],
      list_dir: { $by: "path", values: { "/notes": [dirEntry], [DIR]: [] } },
      create_entry: { $by: "name", values: { [`${TODAY}.md`]: `${DIR}/${TODAY}.md` } },
      reopen_file: file(`${TODAY}.md`),
      save_file: { status: "saved", path: `${DIR}/${TODAY}.md`, name: `${TODAY}.md` },
    },
  });
  await page.waitForSelector(".cm-content");
  await runCommand(page, "今天的筆記");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "save_file"));
  const all = await calls(page);
  const filter = all.find((c) => c.cmd === "ado_work_items").args.filter;
  assert.equal(filter.person, "@me");
  assert.equal(filter.state, "open");
  const saved = all.find((c) => c.cmd === "save_file").args.text;
  assert.match(
    saved,
    /## 今天要做\n\n- \[ \] \n\n## 工作項目\n\n- \[ \] \[#12 修正登入\]\(https:\/\/ado\.test\/c\/產品\/_workitems\/edit\/12\)\n- \[ \] \[#11 寫測試\]\(https:\/\/ado\.test\/c\/產品\/_workitems\/edit\/11\)\n\n## 會議與討論/,
  );
  // 游標還是在「今天要做」：直接打字就是第一個待辦。
  await page.keyboard.insertText("開會");
  assert.match(await page.textContent(".cm-content"), /- \[ \] 開會/);
  // 指令：插入到目前的文件（游標的位置）。
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await runCommand(page, "插入指派給我的工作項目");
  await page.locator(".toast", { hasText: "已插入 2 個工作項目" }).waitFor();
  const text = await page.evaluate(() => document.querySelector(".cm-content").textContent);
  assert.equal((text.match(/#12 修正登入/g) ?? []).length, 2);
  assert.deepEqual(errors, []);
  await context.close();
});
