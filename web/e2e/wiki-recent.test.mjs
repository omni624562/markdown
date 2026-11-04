/**
 * Wiki 最近修改：Wiki 面板的「最近修改」列出最近誰改了哪一頁（新的在前），可以用頁面、人名、說明找；
 * 選一筆開那一頁，已經刪除的頁面只提示。用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
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
const PAGES = [{ path: "/產品", id: 1, children: [{ path: "/產品/安裝說明", id: 2, children: [] }] }];
const change = (path, kind, author, date, comment) => ({ path, change: kind, author, date, comment, commitId: `c-${path}` });
const RECENT = [
  change("/產品/安裝說明", "edit", "王小明", "2026-11-02T08:00:00Z", "補上 Windows 的步驟"),
  change("/舊的說明", "delete", "李大同", "2026-11-01T08:00:00Z", "整理"),
  change("/產品", "add", "李大同", "2026-10-30T08:00:00Z", ""),
];
const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_wikis: [[WIKI]],
  ado_wiki_pages: [PAGES],
  ado_wiki_page: { $by: "path", values: { "/產品/安裝說明": { content: "# 安裝說明", webUrl: null, etag: null } } },
  ado_wiki_recent: [RECENT],
};

test("Wiki 最近修改：列出誰改了哪一頁，可以找；選一筆開那一頁，刪除的只提示", async () => {
  const { page: p, context, errors } = await open({ desktop });
  await p.click("#side-tab-wiki");
  await p.locator('#wiki-host .wiki-page[data-path="/產品"]').waitFor();
  await p.click("#wiki-host .wiki-recent");
  const options = p.locator("dialog.palette[open] [role=option]");
  await options.first().waitFor();
  const texts = await options.allTextContents();
  assert.equal(texts.length, 3);
  assert.match(texts[0], /安裝說明.*修改・王小明.*產品・補上 Windows 的步驟/);
  assert.match(texts[1], /舊的說明.*刪除・李大同/);
  assert.match(texts[2], /產品.*新增・李大同/);
  const args = (await calls(p)).find((c) => c.cmd === "ado_wiki_recent").args;
  assert.deepEqual(args, { projectId: "p1", wikiId: "w1", repositoryId: "r1", mappedPath: "/", version: "wikiMaster" });
  // 用人名找。
  await p.locator("dialog.palette[open] input").fill("李大同");
  await p.waitForFunction(() => document.querySelectorAll("dialog.palette[open] [role=option]").length === 2);
  // 已經刪除的頁面：只提示。
  await p.keyboard.press("Enter");
  await p.locator(".toast", { hasText: "「舊的說明」已經刪除了" }).waitFor();
  // 再開一次，選第一筆：開那一頁。
  await p.click("#wiki-host .wiki-recent");
  await options.first().waitFor();
  await p.keyboard.press("Enter");
  await p.waitForFunction(() => document.querySelector(".issue-body h1")?.textContent === "安裝說明");
  assert.deepEqual(errors, []);
  await context.close();
});

test("Wiki 最近修改只列樹狀目錄目前範圍裡的頁面：篩選掉的最上層頁面底下改的不列", async () => {
  const pages = [
    { path: "/產品", id: 1, children: [{ path: "/產品/安裝說明", id: 2, children: [] }] },
    { path: "/上線列車", id: 3, children: [{ path: "/上線列車/1127上線", id: 4, children: [] }] },
  ];
  const recent = [
    change("/上線列車/1127上線", "edit", "陳大文", "2026-11-03T08:00:00Z", "上線清單"),
    change("/產品/安裝說明", "edit", "王小明", "2026-11-02T08:00:00Z", "補上 Windows 的步驟"),
  ];
  const { page: p, context, errors } = await open({ desktop: { ...desktop, ado_wiki_pages: [pages], ado_wiki_recent: [recent] } });
  // 篩選：只顯示「產品」。
  await p.evaluate(() => localStorage.setItem("md-editor:ado-wiki-pages:w1", JSON.stringify({ shown: ["/產品"] })));
  await p.reload();
  await p.click("#side-tab-wiki");
  await p.locator('#wiki-host .wiki-page[data-path="/產品"]').waitFor();
  assert.equal(await p.locator('#wiki-host .wiki-page[data-path="/上線列車"]').count(), 0, "樹狀目錄裡藏起來了");
  await p.click("#wiki-host .wiki-recent");
  const options = p.locator("dialog.palette[open] [role=option]");
  await options.first().waitFor();
  const texts = await options.allTextContents();
  assert.equal(texts.length, 1, "藏起來的「上線列車」底下改的不列");
  assert.match(texts[0], /安裝說明/);
  // 找藏起來的頁面：範圍外的找不到，說明是範圍的關係。
  await p.locator("dialog.palette[open] input").fill("上線");
  await p.locator("dialog.palette[open] li", { hasText: "樹狀目錄目前的範圍裡最近沒有修改" }).waitFor();
  await p.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  await context.close();
});
