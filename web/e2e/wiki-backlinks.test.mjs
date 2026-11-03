/**
 * 哪些 Wiki 頁面連到這一頁：從 Wiki 樹的右鍵選單、Wiki 頁面分頁的右鍵選單開啟，
 * 列出連到這一頁的頁面與那一行（相對、絕對路徑、同一個 Wiki 的完整網址都算），點一下開啟那一頁。
 * 刪除頁面前也會先提醒哪些頁面連到這裡。用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
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
      { path: "/產品/安裝 說明", id: 21, children: [] },
      { path: "/產品/規格", id: 22, children: [] },
    ],
  },
  { path: "/會議", id: 3, children: [] },
];
const SOURCES = {
  pages: [
    // 刻意不照頁面樹的順序：清單要依頁面樹排。
    { path: "/會議", text: "# 會議\n\n見 https://ado.test/c/Mgt/_wiki/wikis/Mgt.wiki/21/安裝-說明 的步驟" },
    { path: "/首頁", text: "# 首頁\n\n- [安裝](/產品/安裝-說明)\n- [規格](/產品/規格)" },
    { path: "/產品/規格", text: "前置作業見 [安裝](./安裝-說明.md)。\n\n```\n[不算](/產品/安裝-說明)\n```" },
    { path: "/產品/安裝 說明", text: "# 安裝\n\n[本頁](/產品/安裝-說明)" },
    { path: "/產品", text: "# 產品" },
  ],
  skipped: 0,
};
const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_wikis: [[WIKI]],
  ado_wiki_pages: [PAGES],
  ado_wiki_sources: SOURCES,
  ado_wiki_page: { content: "# 內容", webUrl: null, etag: '"1"' },
};

async function wikiPanel(extra = {}) {
  const opened = await open({ desktop: { ...desktop, ...extra } });
  await opened.page.click("#side-tab-wiki");
  await opened.page.locator('#wiki-host .wiki-page[data-path="/首頁"]').waitFor();
  return opened;
}
async function treeMenu(p, path) {
  const toggle = p.locator('#wiki-host .wiki-row:has(> .wiki-page[data-path="/產品"]) .wiki-toggle');
  if (path.startsWith("/產品/") && !(await p.locator(`#wiki-host .wiki-page[data-path="${path}"]`).count())) await toggle.click();
  await p.locator(`#wiki-host .wiki-page[data-path="${path}"]`).click({ button: "right" });
  const menu = p.locator('[id^="wiki-menu-"][id$="-popover"]');
  await menu.waitFor();
  return menu;
}
const rows = (p) =>
  p.locator("dialog.palette[open] [role=option]").evaluateAll((lis) =>
    lis.map((li) => [li.querySelector(".palette-title").textContent, li.querySelector(".palette-group")?.textContent ?? ""]),
  );

test("Wiki 樹的右鍵選單：列出連到這一頁的頁面與那一行，依頁面樹排；點一下開啟", async () => {
  const { page: p, context, errors } = await wikiPanel();
  const menu = await treeMenu(p, "/產品/安裝 說明");
  await menu.getByRole("menuitem", { name: "哪些頁面連到這一頁…" }).click();
  await p.locator("dialog.palette[open] [role=option]").first().waitFor();
  const list = await rows(p);
  assert.deepEqual(
    list.map(([title]) => title),
    ["首頁", "規格", "會議"],
    "依頁面樹的順序；自己連到自己、程式碼區塊裡的不算",
  );
  assert.match(list[0][1], /第 3 行・- \[安裝\]\(\/產品\/安裝-說明\)/);
  assert.match(list[1][1], /^產品・第 1 行/);
  assert.match(list[2][1], /第 3 行・見 https:\/\/ado\.test/, "同一個 Wiki 的完整網址（頁面編號）也算");
  // 搜尋框可以篩選。
  await p.keyboard.type("會議");
  await p.waitForFunction(() => document.querySelectorAll("dialog.palette[open] [role=option]").length === 1);
  await p.keyboard.press("Enter");
  await p.waitForFunction(() =>
    window.__fake.calls.some((c) => c.cmd === "ado_wiki_page" && c.args.path === "/會議"),
  );
  const sent = (await calls(p)).find((c) => c.cmd === "ado_wiki_sources").args;
  assert.deepEqual(sent, { projectId: "p1", wikiId: "w1", repositoryId: "r1", mappedPath: "/", version: "wikiMaster" });
  assert.deepEqual(errors, []);
  await context.close();
});

test("沒有頁面連到這一頁：只提示；讀不到的頁面數也提示", async () => {
  const { page: p, context } = await wikiPanel({ ado_wiki_sources: { ...SOURCES, skipped: 2 } });
  const menu = await treeMenu(p, "/會議");
  await menu.getByRole("menuitem", { name: "哪些頁面連到這一頁…" }).click();
  await p.locator(".toasts", { hasText: "沒有其他頁面連到「會議」。" }).waitFor();
  await p.locator(".toasts", { hasText: "有 2 頁讀不到" }).waitFor();
  assert.equal(await p.locator("dialog.palette[open]").count(), 0);
  await context.close();
});

test("刪除頁面前提醒哪些頁面連到這一頁或子頁面", async () => {
  const { page: p, context } = await wikiPanel();
  // 開啟「產品」，從分頁的右鍵選單刪除（底下的子頁面一起刪）。
  await p.locator('#wiki-host .wiki-page[data-path="/產品"]').click();
  await p.locator(".issue-pane .issue-body", { hasText: "內容" }).waitFor();
  await p.locator('#tab-bar .tab[aria-selected="true"]').click({ button: "right" });
  await p.getByRole("menuitem", { name: "刪除這一頁…" }).click();
  const dialog = p.locator("dialog[open]", { hasText: "刪除 Wiki 頁面？" });
  await dialog.waitFor();
  const text = await dialog.textContent();
  assert.match(text, /有 2 個頁面連到這裡（「首頁」、「會議」），刪除後這些連結會失效。/);
  await dialog.getByRole("button", { name: "取消" }).click();
  await context.close();
});
