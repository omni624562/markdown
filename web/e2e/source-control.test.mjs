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

test("變更清單：「捨棄修改」換回上次提交的內容並存檔；通知上的「復原」拿回來", async () => {
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
  const discard = row.locator(".git-file-discard");
  assert.equal(await discard.getAttribute("aria-label"), "a.md：捨棄修改");
  assert.equal(await page.locator("#git-host .git-files li", { hasText: "new.md" }).locator(".git-file-discard").count(), 0, "新檔案沒有上一版");
  await discard.click();
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
