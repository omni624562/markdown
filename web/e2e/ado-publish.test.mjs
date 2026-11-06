/**
 * 上傳到 Azure DevOps：原始碼控制面板在儲存庫還沒有遠端（或資料夾還不是儲存庫）時，除了「上傳到 GitHub」
 * 還有「上傳到 Azure DevOps…」。選專案，再選建立新的儲存庫（名稱預設是資料夾名稱）或那個專案裡已經存在的
 * 空儲存庫，交給原生端建立、設定 origin 並推送。用假的原生端（見 helpers.mjs）。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const ROOT = { kind: "folder", path: "C:\\Users\\me\\Documents\\週報筆記", name: "週報筆記" };
const status = (extra = {}) => ({
  available: true,
  repo: true,
  trusted: true,
  branch: { name: "main", upstream: null, ahead: 0, behind: 0 },
  changes: [],
  remote: null,
  merging: false,
  ...extra,
});
const repo = (project, name, extra = {}) => ({
  name,
  project,
  cloneUrl: `https://ado.test/tfs/DC/${project}/_git/${name}`,
  webUrl: null,
  wiki: false,
  empty: false,
  ...extra,
});
const desktop = (extra = {}) => ({
  startup_target: ROOT,
  list_dir: [[{ name: "README.md", path: `${ROOT.path}\\README.md`, isDir: false }]],
  git_status: status(),
  git_fetch: status(),
  github_account: null,
  ado_account: { url: "https://ado.test/tfs/DC", name: "王小明" },
  ado_work_item_filters: { projects: ["產品", "Contoso"], kinds: [] },
  // 陣列是依序回應的清單，所以儲存庫清單要再包一層。
  ado_repos: [
    [
      repo("產品", "web"),
      repo("產品", "空的", { empty: true }),
      repo("產品", "產品.wiki", { wiki: true }),
      repo("Contoso", "網站", { empty: true }),
    ],
  ],
  ado_publish: "https://ado.test/tfs/DC/%E7%94%A2%E5%93%81/_git/x",
  ...extra,
});

async function openGit(extra) {
  const opened = await open({ desktop: desktop(extra) });
  await opened.page.locator("#side-tab-git").click();
  return opened;
}

/** 在清單裡找 `query`，選第一個。 */
async function pick(page, query) {
  const input = page.locator("dialog[open] input").first();
  await input.waitFor();
  await input.fill(query);
  await page.locator("dialog[open] [role=option]").first().waitFor();
  await page.keyboard.press("Enter");
}

const published = (page) => calls(page).then((list) => list.filter((c) => c.cmd === "ado_publish").map((c) => c.args));

test("還沒有遠端：面板有「上傳到 Azure DevOps…」；選專案、建立新的儲存庫（名稱預設是資料夾名稱）後上傳", async () => {
  const { page, context, errors } = await openGit();
  const hint = page.locator("#git-host .git-hint");
  await hint.waitFor();
  assert.match(await hint.textContent(), /還沒有連到 GitHub 或 Azure DevOps/);
  await hint.locator("button", { hasText: "上傳到 Azure DevOps…" }).click();
  await pick(page, "產品");
  const choice = page.locator("dialog.choice[open]");
  await choice.waitFor();
  assert.match(await choice.textContent(), /「週報筆記」資料夾.*「產品」/);
  assert.deepEqual(await choice.locator("button").allTextContents(), ["取消", "用已經存在的空儲存庫…", "建立新的儲存庫"]);
  await choice.getByRole("button", { name: "建立新的儲存庫" }).click();
  const name = page.locator("dialog.choice[open] input.choice-input");
  await name.waitFor();
  assert.equal(await name.inputValue(), "週報筆記");
  await page.locator("dialog.choice[open] button[value=ok]").click();
  await page.locator(".toast", { hasText: "已上傳到 Azure DevOps：產品 / 週報筆記" }).waitFor();
  assert.deepEqual(await published(page), [{ project: "產品", name: "週報筆記", existing: false }]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("用已經存在的空儲存庫：只列出那個專案裡的空儲存庫（不含有內容的、專案 Wiki）", async () => {
  const { page, context, errors } = await openGit();
  await page.locator("#git-host .git-hint button", { hasText: "上傳到 Azure DevOps…" }).click();
  await pick(page, "產品");
  await page.locator("dialog.choice[open]").getByRole("button", { name: "用已經存在的空儲存庫…" }).click();
  const input = page.locator("dialog[open] input").first();
  await input.waitFor();
  await page.locator("dialog[open] [role=option]").first().waitFor();
  assert.deepEqual(await page.locator("dialog[open] [role=option] .palette-title").allTextContents(), ["空的"]);
  await page.keyboard.press("Enter");
  await page.locator(".toast", { hasText: "已上傳到 Azure DevOps：產品 / 空的" }).waitFor();
  assert.deepEqual(await published(page), [{ project: "產品", name: "空的", existing: true }]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("資料夾還不是儲存庫：說明區也有「上傳到 Azure DevOps…」；指令面板有對應的指令", async () => {
  const { page, context, errors } = await openGit({ git_status: status({ repo: false, branch: null }) });
  const setup = page.locator("#git-host .git-setup");
  await setup.waitFor();
  assert.ok(await setup.locator("button", { hasText: "上傳到 Azure DevOps…" }).isVisible());
  await page.keyboard.press("Control+Shift+P");
  await page.locator("dialog[open] input").first().fill("上傳到 Azure DevOps");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  assert.match(await page.locator("dialog[open] [role=option]").first().textContent(), /把這個資料夾上傳到 Azure DevOps/);
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  await context.close();
});
