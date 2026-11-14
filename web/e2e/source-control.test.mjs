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
