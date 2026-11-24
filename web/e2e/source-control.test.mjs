/**
 * 原始碼控制面板：遠端在 GitHub 但還沒登入時，拉取、推送、「提交並推送」停用，「提交」是主要按鈕；
 * 分支名稱和拉取、推送排成一列；Git 歷史、建立 PR、立刻檢查遠端在面板的標題列；圖示列預設不再釘 Git 歷史。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ROOT = { kind: "folder", path: "/notes", name: "notes" };
const STATUS = {
  available: true,
  repo: true,
  trusted: true,
  branch: { name: "feature/a-very-long-branch-name-that-does-not-fit", upstream: "origin/main", ahead: 2, behind: 1 },
  changes: [{ path: "/notes/a.md", status: "modified" }],
  remote: "https://github.com/me/notes.git",
  merging: false,
};

async function openGit(extra = {}) {
  const opened = await open({
    desktop: {
      startup_target: ROOT,
      list_dir: { $by: "path", values: { "/notes": [{ name: "a.md", path: "/notes/a.md", isDir: false }] } },
      git_status: STATUS,
      git_fetch: STATUS,
      ...extra,
    },
  });
  const { page } = opened;
  await page.locator("#side-tab-git").click();
  await page.waitForSelector("#git-host .git-branch");
  return opened;
}

const button = (page, name) => page.locator("#git-host button", { hasText: name });

test("還沒登入 GitHub：拉取、推送、提交並推送停用並說明原因，「提交」與「用 GitHub 登入」是主要按鈕", async () => {
  const { page, context, errors } = await openGit({ github_account: null });
  const hint = page.locator("#git-host .git-hint");
  await hint.waitFor();
  assert.match(await hint.textContent(), /登入 GitHub 才能拉取與推送/);
  assert.match(await hint.locator("button").getAttribute("class"), /btn-primary/);
  for (const name of ["拉取", "推送"]) {
    const b = page.locator("#git-host .git-sync button", { hasText: name });
    assert.equal(await b.isDisabled(), true, name);
    assert.match(await b.getAttribute("title"), /登入 GitHub/, name);
  }
  const commitPush = button(page, "提交並推送");
  assert.equal(await commitPush.isDisabled(), true);
  assert.match(await commitPush.getAttribute("title"), /登入 GitHub/);
  assert.doesNotMatch(await commitPush.getAttribute("class"), /btn-primary/);
  const commit = page.locator("#git-host .git-actions button").first();
  assert.equal((await commit.textContent()).trim(), "提交");
  assert.equal(await commit.isDisabled(), false);
  assert.match(await commit.getAttribute("class"), /btn-primary/);
  assert.equal((await calls(page)).filter((c) => c.cmd === "git_pull" || c.cmd === "git_push").length, 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("已登入：拉取、推送可以按，「提交並推送」是主要按鈕；分支和拉取、推送排成一列，其他按鈕在標題列", async () => {
  const { page, context, errors } = await openGit({ github_account: { login: "me", id: 1, name: null } });
  assert.equal(await page.locator("#git-host .git-hint").count(), 0);
  for (const name of ["拉取", "推送"]) assert.equal(await page.locator("#git-host .git-sync button", { hasText: name }).isDisabled(), false, name);
  const commitPush = button(page, "提交並推送");
  assert.equal(await commitPush.isDisabled(), false);
  assert.match(await commitPush.getAttribute("class"), /btn-primary/);

  // 同步列只有分支名稱、拉取、推送，排成一列；分支名稱太長時截斷。
  const row = await page.evaluate(() => {
    const box = (el) => el.getBoundingClientRect();
    const items = [document.querySelector(".git-info"), ...document.querySelectorAll(".git-sync button")];
    const name = document.querySelector(".git-info strong");
    return {
      buttons: document.querySelectorAll(".git-sync button").length,
      centers: items.map((el) => Math.round(box(el).top + box(el).height / 2)),
      truncated: name.scrollWidth > name.clientWidth,
      right: Math.round(box(document.querySelector(".git-sync")).right),
      panelRight: Math.round(box(document.querySelector("#git-host")).right),
    };
  });
  assert.equal(row.buttons, 2);
  assert.ok(Math.max(...row.centers) - Math.min(...row.centers) <= 2, JSON.stringify(row.centers));
  assert.ok(row.truncated);
  assert.ok(row.right <= row.panelRight, JSON.stringify(row));

  // 只有圖示的按鈕在面板標題列（寬視窗時標題列和文件分頁同一列）。
  const head = page.locator("#panel-git .side-head .side-actions");
  assert.equal(await head.isVisible(), true);
  const labels = await head.locator("button:not([hidden])").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label")));
  assert.deepEqual(labels, ["Git 歷史（線圖）", "建立 Pull Request", "立刻檢查遠端"]);
  const top = await head.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  // 側邊欄的第一列（和文件分頁同高；起始頁沒有分頁列，所以用側邊欄的上緣和那一列的高度量）。
  const side = await page.locator(".sidebar").boundingBox();
  const rowH = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tabbar-h")));
  const tabs = { y: side.y, height: rowH + 1 };
  assert.ok(top >= tabs.y && top < tabs.y + tabs.height, `${top} / ${JSON.stringify(tabs)}`);
  const before = (await calls(page)).filter((c) => c.cmd === "git_fetch").length;
  await head.locator('button[aria-label="立刻檢查遠端"]').click();
  await page.waitForFunction((n) => window.__fake.calls.filter((c) => c.cmd === "git_fetch").length > n, before);
  assert.deepEqual(errors, []);
  await context.close();
});

test("圖示列預設不釘 Git 歷史；之前釘過的照舊", async () => {
  const fresh = await openGit({ github_account: null });
  assert.equal(await fresh.page.locator('.activity-cmds [data-command="git-history"]').count(), 0);
  assert.deepEqual(fresh.errors, []);
  await fresh.context.close();

  const saved = await openGit({ github_account: null, load_settings: JSON.stringify({ activityCommands: ["git-history"] }) });
  await saved.page.locator('.activity-cmds [data-command="git-history"]').waitFor();
  assert.deepEqual(saved.errors, []);
  await saved.context.close();
});

test("變更清單：修改過的檔案點一下（或按右邊的按鈕）就標出改了哪些地方：綠色是現在的、紅色是上次提交的；新檔案照常打開", async () => {
  const status = {
    ...STATUS,
    changes: [
      { path: "/notes/a.md", status: "modified" },
      { path: "/notes/new.md", status: "untracked" },
    ],
  };
  const files = {
    "/notes/a.md": { path: "/notes/a.md", name: "a.md", text: "# 標題\n\n新的一段\n", encoding: "utf-8" },
    "/notes/new.md": { path: "/notes/new.md", name: "new.md", text: "# 新檔案\n", encoding: "utf-8" },
  };
  const { page, context, errors } = await openGit({
    github_account: null,
    git_status: status,
    git_fetch: status,
    reopen_file: { $by: "path", values: files },
    git_file_at: "# 標題\n\n舊的一段\n",
  });
  const row = page.locator("#git-host .git-files li", { hasText: "a.md" });
  // 修改過的檔案右邊有看得到的「比較」按鈕；新檔案沒有（沒有上一版）。
  const cmp = row.locator(".git-file-diff");
  assert.equal(await cmp.isVisible(), true);
  assert.equal(await cmp.getAttribute("aria-label"), "a.md：看改了哪些地方");
  assert.equal(await page.locator("#git-host .git-files li", { hasText: "new.md" }).locator(".git-file-diff").count(), 0);

  await row.locator("button").first().click();
  const bar = page.locator("#review-bar");
  await bar.getByText("「a.md」改了哪些地方").waitFor();
  assert.deepEqual(
    (await calls(page)).filter((c) => c.cmd === "git_file_at").map((c) => c.args),
    [{ path: "/notes/a.md", id: "HEAD" }],
  );
  // 文件本身還是現在的內容（綠色），上次提交的那一段標成紅色刪除；打開比較不會讓文件變成「沒存檔」。
  const look = await page.evaluate(() => ({
    inserted: [...document.querySelectorAll(".cm-changedLine")].map((el) => el.textContent),
    deleted: [...document.querySelectorAll(".cm-deletedChunk")].map((el) => el.textContent),
  }));
  assert.ok(look.inserted.some((x) => x.includes("新的一段")), JSON.stringify(look));
  assert.ok(look.deleted.some((x) => x.includes("舊的一段")), JSON.stringify(look));
  assert.equal(await page.locator(".tab.active.dirty, .tab[aria-selected=true].dirty").count(), 0, "沒有變成沒存檔");
  // 「改回去」：那一段換回上次提交時的內容。
  await page.locator(".cm-deletedChunk").getByRole("button", { name: "改回去" }).click();
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("舊的一段") && !document.querySelector(".cm-content")?.textContent?.includes("新的一段"));

  // 新檔案：照常打開，不比較。
  await page.locator("#git-host .git-files li", { hasText: "new.md" }).locator("button").first().click();
  await page.locator(".tab", { hasText: "new.md" }).first().waitFor();
  assert.equal((await calls(page)).filter((c) => c.cmd === "git_file_at").length, 1);

  // 右邊的「比較」按鈕和點檔名一樣。
  await cmp.click();
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "git_file_at").length === 2);
  assert.deepEqual(errors, []);
  await context.close();
});

test("設定成左右並排：左邊上次提交、右邊現在；「改回去」之後放回文件", async () => {
  const status = { ...STATUS, changes: [{ path: "/notes/a.md", status: "modified" }] };
  const { page, context, errors } = await openGit({
    github_account: null,
    git_status: status,
    git_fetch: status,
    load_settings: JSON.stringify({ gitCompareLayout: "side" }),
    reopen_file: { path: "/notes/a.md", name: "a.md", text: "# 會議紀錄\n\n出席：王小明、李大同\n", encoding: "utf-8" },
    git_file_at: "# 會議紀錄\n\n出席：王小明\n",
  });
  await page.locator("#git-host .git-file-diff").click();
  const side = page.locator(".review-side");
  await side.waitFor();
  assert.deepEqual(await side.locator(".review-side-heads span").allTextContents(), ["上次提交時", "現在"]);
  assert.equal(await page.locator("#editor").isVisible(), false, "編輯器先藏起來");
  const [left, right] = await side.locator(".cm-editor").evaluateAll((els) => els.map((el) => el.querySelector(".cm-content").textContent));
  assert.match(left, /出席：王小明$/);
  assert.match(right, /李大同/);
  assert.equal(await page.locator("#review-bar").getByRole("button", { name: "看完了" }).isVisible(), true);
  // 「改回去」：右邊那一段換回上次提交的內容；全部處理完就收起並排，文件也換回去。
  await side.getByRole("button", { name: "改回去" }).click();
  await side.waitFor({ state: "detached" });
  assert.equal(await page.locator("#editor").isVisible(), true);
  await page.waitForFunction(() => {
    const text = document.querySelector("#editor .cm-content")?.textContent ?? "";
    return text.includes("出席：王小明") && !text.includes("李大同");
  });
  assert.deepEqual(errors, []);
  await context.close();
});

test("還沒推送：列出已提交、還沒推送的檔案；修改過的點一下和遠端上的版本比較", async () => {
  // STATUS 的分支領先遠端 2 個提交（origin/main）。
  const status = { ...STATUS, changes: [] };
  const { page, context, errors } = await openGit({
    github_account: { login: "me", id: 1, name: null },
    git_status: status,
    git_fetch: status,
    git_unpushed: [[
      { path: "/notes/a.md", status: "modified" },
      { path: "/notes/new.md", status: "added" },
    ]],
    reopen_file: { path: "/notes/a.md", name: "a.md", text: "# 會議紀錄\n\n下週三交報告。\n", encoding: "utf-8" },
    git_file_at: "# 會議紀錄\n\n下週一交報告。\n",
  });
  const head = page.locator("#git-host .git-unpushed-head");
  await head.waitFor();
  assert.equal(await head.textContent(), "還沒推送（2 個提交）");
  const rows = page.locator("#git-host .git-unpushed li");
  assert.equal(await rows.count(), 2);
  assert.equal(await rows.nth(1).locator(".git-file-diff").count(), 0, "新增的檔案沒有遠端的版本可比");
  await rows.first().locator(".git-file-diff").click();
  await page.locator("#review-bar").getByText("「a.md」和遠端比起來改了哪些地方").waitFor();
  const call = (await calls(page)).filter((c) => c.cmd === "git_file_at").at(-1);
  assert.deepEqual(call.args, { path: "/notes/a.md", id: "UPSTREAM" });
  const deleted = await page.evaluate(() => [...document.querySelectorAll(".cm-deletedChunk")].map((el) => el.textContent).join(""));
  assert.match(deleted, /下週一/, "紅色是遠端上的樣子");
  assert.deepEqual(errors, []);
  await context.close();
});

test("只提交勾選的檔案：取消勾選的不提交，按鈕寫出幾個檔案；全部勾選時照舊提交全部", async () => {
  const status = {
    ...STATUS,
    changes: [
      { path: "/notes/a.md", status: "modified" },
      { path: "/notes/b.md", status: "modified" },
      { path: "/notes/new.md", status: "untracked" },
    ],
  };
  const { page, context, errors } = await openGit({ github_account: null, git_status: status, git_fetch: status, git_commit: "abc1234 修改" });
  const checks = page.locator("#git-host .git-files .git-file-check");
  assert.equal(await checks.count(), 3);
  assert.deepEqual(await checks.evaluateAll((els) => els.map((el) => el.checked)), [true, true, true], "預設全部勾選");
  // 取消勾選 b.md：按鈕寫出提交 2 個檔案，提交說明的預設值也只算勾選的。
  await page.getByRole("checkbox", { name: "提交「b.md」" }).uncheck();
  const commit = page.locator("#git-host .git-actions button").first();
  assert.equal(await commit.getAttribute("aria-label"), "提交（只提交勾選的 2 個檔案）");
  assert.equal(await commit.locator(".git-count").textContent(), "2");
  assert.equal(await page.locator("#git-host .git-changes-head .git-file-check").evaluate((el) => el.indeterminate), true);
  assert.match(await page.locator("#git-host textarea").getAttribute("placeholder"), /更新 2 個檔案/);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "提交「b.md」", "焦點留在勾選框");
  await commit.click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "git_commit"));
  let call = (await calls(page)).filter((c) => c.cmd === "git_commit").at(-1);
  assert.deepEqual(call.args, { message: "更新 2 個檔案", paths: ["/notes/a.md", "/notes/new.md"] });
  // 部分勾選時按全選：全部勾選；再按一次全部取消，提交按鈕停用；再勾回全部時照舊提交全部（不帶路徑）。
  const all = page.locator("#git-host .git-changes-head .git-file-check");
  await all.check();
  assert.deepEqual(await checks.evaluateAll((els) => els.map((el) => el.checked)), [true, true, true]);
  await all.uncheck();
  assert.equal(await commit.isDisabled(), true);
  await all.check();
  assert.equal((await commit.textContent()).trim(), "提交");
  assert.equal(await commit.getAttribute("aria-label"), null);
  await commit.click();
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "git_commit").length === 2);
  call = (await calls(page)).filter((c) => c.cmd === "git_commit").at(-1);
  assert.deepEqual(call.args, { message: "更新 3 個檔案", paths: null });
  assert.deepEqual(errors, []);
  await context.close();
});

test("變更清單：「⋯」選單的「捨棄修改」換回上次提交的內容並存檔；通知上的「復原」拿回來", async () => {
  const status = { ...STATUS, changes: [{ path: "/notes/a.md", status: "modified" }, { path: "/notes/new.md", status: "untracked" }] };
  const { page, context, errors } = await openGit({
    github_account: null,
    git_status: status,
    git_fetch: status,
    reopen_file: { path: "/notes/a.md", name: "a.md", text: "# 會議紀錄\n\n下週三交報告。\n", encoding: "utf-8" },
    git_file_at: "# 會議紀錄\n\n下週一交報告。\n",
    save_file: { status: "saved" },
  });
  const row = page.locator("#git-host .git-files li", { hasText: "a.md" });
  // 「捨棄修改」在每一列的「⋯」選單裡（會改掉內容，不放在一點就中的位置）。
  await row.hover();
  await row.locator(".git-file-more").click();
  await page.getByRole("menuitem", { name: "捨棄修改…" }).click();
  const content = () => page.evaluate(() => document.querySelector("#editor .cm-content")?.textContent ?? "");
  await page.waitForFunction(() => document.querySelector("#editor .cm-content")?.textContent?.includes("下週一"));
  const saves = () => page.evaluate(() => window.__fake.calls.filter((c) => c.cmd === "save_file").map((c) => c.args.text ?? c.args.req?.text ?? JSON.stringify(c.args)));
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "save_file"));
  assert.match((await saves()).at(-1), /下週一/);
  const note = page.locator(".toast", { hasText: "已把「a.md」改回上次提交時的內容" });
  await note.getByRole("button", { name: "復原" }).click();
  await page.waitForFunction(() => document.querySelector("#editor .cm-content")?.textContent?.includes("下週三"));
  assert.doesNotMatch(await content(), /下週一/);
  await page.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "save_file").length >= 2);
  assert.match((await saves()).at(-1), /下週三/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("沒有領先遠端時不讀、不顯示「還沒推送」", async () => {
  const status = { ...STATUS, branch: { ...STATUS.branch, ahead: 0 } };
  const { page, context, errors } = await openGit({ github_account: null, git_status: status, git_fetch: status });
  assert.equal(await page.locator("#git-host .git-unpushed-head").count(), 0);
  assert.equal((await calls(page)).some((c) => c.cmd === "git_unpushed"), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test("版本紀錄的比較和原始碼控制一樣：綠色是現在、紅色是舊版；設成左右並排時也是並排", async () => {
  for (const layout of ["stacked", "side"]) {
    const { page, context, errors } = await openGit({
      github_account: null,
      load_settings: JSON.stringify({ gitCompareLayout: layout }),
      reopen_file: { path: "/notes/a.md", name: "a.md", text: "# 會議紀錄\n\n下週三交報告。\n", encoding: "utf-8" },
      history_list: [[{ id: Date.UTC(2026, 10, 20, 2, 0), kind: "save", size: 30 }]],
      history_read: "# 會議紀錄\n\n下週一交報告。\n",
    });
    // 打開檔案（拿不到上次提交的內容時只打開，不比較）。
    await page.locator("#git-host .git-files li", { hasText: "a.md" }).locator("button").first().click();
    await page.locator(".tab", { hasText: "a.md" }).first().waitFor();
    await page.keyboard.press("Control+Shift+P");
    await page.keyboard.type("版本紀錄");
    await page.keyboard.press("Enter");
    await page.locator("dialog.palette[open][aria-label=\"版本紀錄\"] [role=option]").first().click();
    const bar = page.locator("#review-bar");
    await bar.getByText("改了哪些地方").waitFor();
    if (layout === "side") {
      const side = page.locator(".review-side");
      await side.waitFor();
      const heads = await side.locator(".review-side-heads span").allTextContents();
      assert.match(heads[0], /的版本$/);
      assert.equal(heads[1], "現在");
    } else {
      const look = await page.evaluate(() => ({
        inserted: [...document.querySelectorAll(".cm-changedLine")].map((el) => el.textContent).join(""),
        deleted: [...document.querySelectorAll(".cm-deletedChunk")].map((el) => el.textContent).join(""),
      }));
      assert.match(look.inserted, /下週三/, "綠色是現在");
      assert.match(look.deleted, /下週一/, "紅色是舊版");
      assert.equal(await bar.getByRole("button", { name: "全部改回去" }).isVisible(), true);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test("變更清單每一列的「⋯」（右鍵同一份）：依檔案狀態列出能做的事；刪除的檔案可以拿回上次提交的版本", async () => {
  const status = {
    ...STATUS,
    changes: [
      { path: "/notes/a.md", status: "modified" },
      { path: "/notes/new.md", status: "untracked" },
      { path: "/notes/old.md", status: "deleted" },
    ],
  };
  const { page, context, errors } = await openGit({
    github_account: null,
    git_status: status,
    git_fetch: status,
    list_dir: { $by: "path", values: { "/notes": [{ name: "a.md", path: "/notes/a.md", isDir: false }, { name: "new.md", path: "/notes/new.md", isDir: false }] } },
  });
  const li = (name) => page.locator("#git-host .git-files li", { hasText: name });
  const menu = async (name, how) => {
    if (how === "right") await li(name).click({ button: "right" });
    else {
      await li(name).hover();
      assert.equal(await li(name).locator(".git-file-more").isVisible(), true, "滑鼠移上去出現「⋯」");
      await li(name).locator(".git-file-more").click();
    }
    const pop = page.locator("#file-menu-popover");
    await pop.locator("[role=menuitem]").first().waitFor();
    const items = await pop.locator("[role=menuitem]").allTextContents();
    await page.keyboard.press("Escape");
    return items.map((x) => x.trim());
  };
  // 和檔案面板共用同一份選單（看 → 找 → 改 → 刪）。
  const modified = ["開啟", "看改了哪些地方", "歷史（存檔版本、提交）…", "在檔案面板中顯示", "在檔案總管中顯示", "複製路徑", "插入連結到目前的文件", "捨棄修改…", "移到資源回收筒…"];
  assert.deepEqual(await menu("a.md"), modified);
  assert.deepEqual(await menu("a.md", "right"), modified, "右鍵和「⋯」同一份");
  assert.deepEqual(await menu("new.md"), ["開啟", "歷史（存檔版本、提交）…", "在檔案面板中顯示", "在檔案總管中顯示", "複製路徑", "插入連結到目前的文件", "移到資源回收筒…"]);
  assert.deepEqual(await menu("old.md"), ["複製路徑", "復原這個檔案（拿回上次提交的版本）"]);
  // 刪除的檔案：復原。
  await li("old.md").locator(".git-file-more").click({ force: true });
  await page.getByRole("menuitem", { name: "復原這個檔案（拿回上次提交的版本）" }).click();
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "git_restore"));
  assert.deepEqual((await calls(page)).filter((c) => c.cmd === "git_restore").map((c) => c.args), [{ path: "/notes/old.md" }]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("比較中改「比較的方式」：馬上換成新的方式（左右並排 ↔ 上下對照）", async () => {
  const status = { ...STATUS, changes: [{ path: "/notes/a.md", status: "modified" }] };
  const { page, context, errors } = await openGit({
    github_account: null,
    git_status: status,
    git_fetch: status,
    load_settings: JSON.stringify({ gitCompareLayout: "side" }),
    reopen_file: { path: "/notes/a.md", name: "a.md", text: "# 會議紀錄\n\n出席：王小明、李大同\n\n下週三交報告。\n", encoding: "utf-8" },
    git_file_at: "# 會議紀錄\n\n出席：王小明\n\n下週一交報告。\n",
  });
  await page.locator("#git-host .git-file-diff").click();
  await page.locator(".review-side").waitFor();
  // 打開設定改成上下對照：左右並排收起來，文件裡直接標出紅綠。
  await page.keyboard.press("Control+,");
  await page.locator("dialog[open].settings [role=tab]", { hasText: "Git 與 GitHub" }).click();
  await page.locator("#setting-gitCompareLayout").selectOption("stacked");
  await page.locator(".review-side").waitFor({ state: "detached" });
  await page.keyboard.press("Escape");
  await page.locator("#review-bar").getByText("改了哪些地方").waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".cm-deletedChunk").length > 0);
  // 再改回左右並排：又是兩欄。
  await page.keyboard.press("Control+,");
  await page.locator("dialog[open].settings [role=tab]", { hasText: "Git 與 GitHub" }).click();
  await page.locator("#setting-gitCompareLayout").selectOption("side");
  await page.locator(".review-side").waitFor();
  assert.equal(await page.locator("#editor").isVisible(), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test("檔案面板的選單和原始碼控制共用：修改過的檔案也有「看改了哪些地方」「捨棄修改」，順序一樣", async () => {
  const status = { ...STATUS, changes: [{ path: "/notes/a.md", status: "modified" }] };
  const { page, context, errors } = await openGit({ github_account: null, git_status: status, git_fetch: status });
  await page.locator("#side-tab-files").click();
  const row = page.locator('#file-tree .tree-row[data-path="/notes/a.md"]');
  await row.hover();
  await row.locator(".tree-more").click();
  const pop = page.locator("#file-menu-popover");
  await pop.locator("[role=menuitem]").first().waitFor();
  const items = (await pop.locator("[role=menuitem]").allTextContents()).map((x) => x.trim());
  assert.deepEqual(items.slice(0, 5), ["看改了哪些地方", "歷史（存檔版本、提交）…", "在檔案總管中顯示", "複製路徑", "插入連結到目前的文件"]);
  assert.equal(items[5], "重新命名");
  assert.deepEqual(items.slice(-2), ["捨棄修改…", "移到資源回收筒…"]);
  // 選單有圖示、刪除是紅色。
  assert.ok(await pop.locator("[role=menuitem] .icon").count() >= items.length - 1);
  assert.match(await pop.locator("[role=menuitem]", { hasText: "移到資源回收筒" }).getAttribute("class"), /danger/);
  assert.deepEqual(errors, []);
  await context.close();
});
