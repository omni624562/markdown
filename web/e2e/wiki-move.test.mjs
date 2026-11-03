/**
 * Wiki 頁面改名、搬移：右鍵選單「改名或搬移…」或把頁面拖到別的頁面中間（搬進去當子頁面），
 * 對話框確認名稱與位置，搬移後更新其他頁面裡連到它（和子頁面）的連結。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const WIKI = {
  id: "w1",
  name: "Mgt.wiki",
  project: "Mgt",
  projectId: "p1",
  code: false,
  repositoryId: "r1",
  mappedPath: "/",
  version: "wikiMaster",
  webUrl: "https://ado.test/c/Mgt/_wiki/wikis/Mgt.wiki",
};
const PAGES = [
  { path: "/首頁", id: 1, children: [] },
  {
    path: "/產品",
    id: 2,
    children: [
      { path: "/產品/安裝 說明", id: 21, children: [{ path: "/產品/安裝 說明/附錄", id: 211, children: [] }] },
      { path: "/產品/規格", id: 22, children: [] },
    ],
  },
  { path: "/文件", id: 3, children: [] },
];
const HOME = "# 首頁\n\n- [安裝](/產品/安裝-說明)\n- [附錄](/產品/安裝-說明/附錄#第一節)\n- [規格](/產品/規格)";
const SPEC = "前置作業見 [安裝](安裝-說明)。";
const page = (content) => ({ content, webUrl: null, etag: '"1"' });
const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_wikis: [[WIKI]],
  ado_wiki_pages: [PAGES],
  ado_wiki_sources: {
    pages: [
      { path: "/首頁", text: HOME },
      { path: "/產品", text: "# 產品" },
      { path: "/產品/安裝 說明", text: "# 安裝" },
      { path: "/產品/安裝 說明/附錄", text: "# 附錄" },
      { path: "/產品/規格", text: SPEC },
      { path: "/文件", text: "# 文件" },
    ],
    skipped: 0,
  },
  ado_wiki_page: { $by: "path", values: { "/首頁": page(HOME), "/產品/規格": page(SPEC) } },
  ado_wiki_move: null,
  ado_wiki_save: { status: "saved", etag: '"2"' },
};

async function wikiPanel() {
  const opened = await open({ desktop });
  await opened.page.click("#side-tab-wiki");
  await opened.page.locator('#wiki-host .wiki-page[data-path="/首頁"]').waitFor();
  return opened;
}

test("改名：對話框寫出要改幾頁的連結；搬移後把其他頁面裡的連結改到新名稱", async () => {
  const { page: p, context, errors } = await wikiPanel();
  await p.locator('#wiki-host .wiki-row:has(> .wiki-page[data-path="/產品"]) .wiki-toggle').click();
  await p.locator('#wiki-host .wiki-page[data-path="/產品/安裝 說明"]').click({ button: "right" });
  await p.locator('[id^="wiki-menu-"][id$="-popover"]').getByRole("menuitem", { name: "改名或搬移…" }).click();
  const dialog = p.locator("dialog.wiki-move[open]");
  await dialog.waitFor();
  assert.equal(await dialog.locator('input[type="text"]').inputValue(), "安裝 說明");
  assert.equal(await dialog.locator("select").inputValue(), "/產品");
  assert.match(await dialog.textContent(), /底下的 1 個子頁面會一起搬過去/);
  await dialog.locator('input[type="text"]').fill("安裝指南");
  await dialog.locator(".wiki-move-relink", { hasText: "2 頁要改" }).waitFor();
  await dialog.getByRole("button", { name: "搬移" }).click();
  await p.locator(".toasts", { hasText: "已改名為「安裝指南」，更新了 2 頁的連結" }).waitFor();
  const all = await calls(p);
  assert.deepEqual(all.find((c) => c.cmd === "ado_wiki_move").args, {
    projectId: "p1",
    wikiId: "w1",
    path: "/產品/安裝 說明",
    newPath: "/產品/安裝指南",
    newOrder: 0,
  });
  const saved = Object.fromEntries(all.filter((c) => c.cmd === "ado_wiki_save").map((c) => [c.args.path, c.args.content]));
  assert.deepEqual(saved, {
    "/首頁": "# 首頁\n\n- [安裝](/產品/安裝指南)\n- [附錄](/產品/安裝指南/附錄#第一節)\n- [規格](/產品/規格)",
    "/產品/規格": "前置作業見 [安裝](/產品/安裝指南)。",
  });
  assert.ok(all.filter((c) => c.cmd === "ado_wiki_save").every((c) => c.args.etag === '"1"'), "用讀到的版本存回（別人剛改過時不會蓋掉）");
  assert.deepEqual(errors, []);
  await context.close();
});

test("把頁面拖到別的頁面中間：搬進去當子頁面（放最後）；不用改連結時只搬移", async () => {
  const { page: p, context, errors } = await wikiPanel();
  const row = (path) => p.locator(`#wiki-host .wiki-row:has(> .wiki-page[data-path="${path}"])`);
  const box = await row("/產品").boundingBox();
  await p.locator('#wiki-host .wiki-page[data-path="/文件"]').dragTo(row("/產品"), { targetPosition: { x: 40, y: box.height / 2 } });
  const dialog = p.locator("dialog.wiki-move[open]");
  await dialog.waitFor();
  assert.equal(await dialog.locator("select").inputValue(), "/產品", "放在拖到的那一頁底下");
  await dialog.locator(".wiki-move-relink", { hasText: "沒有頁面連到這裡" }).waitFor();
  await dialog.getByRole("button", { name: "搬移" }).click();
  await p.locator(".toasts", { hasText: "已把「文件」搬到「產品」" }).waitFor();
  const all = await calls(p);
  assert.deepEqual(all.find((c) => c.cmd === "ado_wiki_move").args.newPath, "/產品/文件");
  assert.equal(all.find((c) => c.cmd === "ado_wiki_move").args.newOrder, 2, "放在原本兩個子頁面後面");
  assert.equal(all.filter((c) => c.cmd === "ado_wiki_save").length, 0);
  // 不能搬到自己底下：/產品 拖到 /產品/規格 不會出現對話框。
  // 搬移後清單選到新位置（展開了「產品」）；還收著時才展開。
  if (!(await row("/產品/規格").count())) await p.locator('#wiki-host .wiki-row:has(> .wiki-page[data-path="/產品"]) .wiki-toggle').click();
  await p.locator('#wiki-host .wiki-page[data-path="/產品"]').dragTo(row("/產品/規格"), { targetPosition: { x: 40, y: 10 } });
  await p.waitForTimeout(200);
  assert.equal(await p.locator("dialog.wiki-move[open]").count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("同名的頁面不行；程式碼 Wiki 沒有改名或搬移", async () => {
  const { page: p, context } = await wikiPanel();
  await p.locator('#wiki-host .wiki-page[data-path="/文件"]').click({ button: "right" });
  await p.locator('[id^="wiki-menu-"][id$="-popover"]').getByRole("menuitem", { name: "改名或搬移…" }).click();
  const dialog = p.locator("dialog.wiki-move[open]");
  await dialog.waitFor();
  await dialog.locator('input[type="text"]').fill("首頁");
  await dialog.getByRole("button", { name: "搬移" }).click();
  assert.match(await dialog.locator(".wi-create-error").textContent(), /已經有同名的頁面/);
  await dialog.getByRole("button", { name: "取消" }).click();
  assert.equal((await calls(p)).filter((c) => c.cmd === "ado_wiki_move").length, 0);
  await context.close();

  const code = await open({ desktop: { ...desktop, ado_wikis: [[{ ...WIKI, code: true, mappedPath: "/docs" }]] } });
  await code.page.click("#side-tab-wiki");
  await code.page.locator('#wiki-host .wiki-page[data-path="/文件"]').click({ button: "right" });
  const menu = code.page.locator('[id^="wiki-menu-"][id$="-popover"]');
  await menu.waitFor();
  assert.equal(await menu.getByRole("menuitem", { name: "改名或搬移…" }).count(), 0);
  await code.context.close();
});
