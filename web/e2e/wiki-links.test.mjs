/**
 * Wiki 頁面裡的連結都在 oMarker 裡開：相對路徑的子頁面、完整網址（主機名稱寫法和連線設定不同）、
 * 工作項目、Wiki 儲存庫裡的檔案；找不到的頁面只提示，不會開瀏覽器。
 * 先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const WIKI = {
  id: "w1",
  name: "Contoso.wiki",
  project: "Contoso",
  projectId: "p1",
  code: false,
  repositoryId: "r1",
  mappedPath: "/",
  version: "wikiMaster",
  webUrl: "https://ado.test/c/Contoso/_wiki/wikis/Contoso.wiki",
};
const PAGES = [
  {
    path: "/IRIS專區",
    id: 1,
    children: [
      {
        path: "/IRIS專區/COBALT",
        id: 2,
        children: [
          { path: "/IRIS專區/COBALT/GET-STARTED-guide", id: 3, children: [] },
          { path: "/IRIS專區/COBALT/Skill自然語言使用範例", id: 4, children: [] },
        ],
      },
    ],
  },
];
const COBALT = [
  "# COBALT",
  "",
  "- [開始](GET-STARTED-guide)",
  // 連線設定是 https://ado.test/c，連結只寫電腦名稱、用 http。
  "- [Skill 範例](http://ado/c/Contoso/_wiki/wikis/Contoso.wiki/4/Skill自然語言使用範例)",
  "- [工作項目](http://ado/c/Contoso/_workitems/edit/42)",
  "- [設定檔](release-notes.json)",
  "- [沒有這頁](沒有這頁)",
  "- [外部網站](https://example.com/doc)",
  "",
].join("\n");
const page = (content) => ({ content, webUrl: null, etag: null });
const ITEM = {
  id: 42,
  title: "修正登入",
  state: "Active",
  kind: "Task",
  project: "Contoso",
  assignedTo: "王小明",
  changed: "2026-10-30T00:00:00Z",
  priority: 2,
  webUrl: "https://ado.test/c/Contoso/_workitems/edit/42",
  createdBy: "王小明",
  area: "Contoso",
  iteration: "Contoso",
  tags: [],
  description: "<p>說明</p>",
  details: null,
  rev: 3,
  relations: [],
  attachments: [],
  comments: [],
};
const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  // 陣列是依序的回應，回傳清單要再包一層。
  ado_wikis: [[WIKI]],
  ado_wiki_pages: [PAGES],
  ado_wiki_page: {
    $by: "path",
    values: {
      "/IRIS專區": page("# IRIS專區"),
      "/IRIS專區/COBALT": page(COBALT),
      "/IRIS專區/COBALT/GET-STARTED-guide": page("# 從這裡開始\n\n[回到 COBALT](../COBALT)"),
      "/IRIS專區/COBALT/Skill自然語言使用範例": page("# Skill 範例"),
    },
  },
  ado_work_item: ITEM,
  ado_repo_text: '{ "version": "6.3.0" }',
};

/** 頁面內容自己的大標題（不算頁名和內容標題不同時，最上面補上的頁名）。 */
const heading = (p) => p.textContent(".issue-body h1:not([data-added])");
const externals = async (p) => (await calls(p)).filter((c) => c.cmd === "open_external").map((c) => c.args.url);

async function openComet(p) {
  await p.click("#side-tab-wiki");
  // 頁面樹一開始收著：展開「IRIS專區」再點「COBALT」。
  await p.locator("#wiki-host li", { has: p.locator('.wiki-page[data-path="/IRIS專區"]') }).locator(".wiki-toggle").first().click();
  await p.click('#wiki-host .wiki-page[data-path="/IRIS專區/COBALT"]');
  await p.waitForFunction(() => document.querySelector(".issue-body h1:not([data-added])")?.textContent === "COBALT");
}

async function clickLink(p, text) {
  await p.locator(".issue-body a", { hasText: text }).click();
}

test("Wiki 頁面裡的子頁面、完整網址、工作項目都在 oMarker 裡開，不開瀏覽器", async () => {
  const { page: p, context, errors } = await open({ desktop });
  await openComet(p);

  // 相對路徑寫成「子頁面」（不是「COBALT/子頁面」）：當成目前頁面底下的子頁面。
  await clickLink(p, "開始");
  await p.waitForFunction(() => document.querySelector(".issue-body h1:not([data-added])")?.textContent === "從這裡開始");
  // 子頁面裡的 ../COBALT 回到上一層。
  await clickLink(p, "回到 COBALT");
  await p.waitForFunction(() => document.querySelector(".issue-body h1:not([data-added])")?.textContent === "COBALT");

  // 完整網址：只寫電腦名稱、http，也認得是連線中的伺服器。
  await clickLink(p, "Skill 範例");
  await p.waitForFunction(() => document.querySelector(".issue-body h1:not([data-added])")?.textContent === "Skill 範例");
  await p.keyboard.press("Alt+ArrowLeft");
  await p.waitForFunction(() => document.querySelector(".issue-body h1:not([data-added])")?.textContent === "COBALT");

  await clickLink(p, "工作項目");
  await p.waitForSelector(".ado-hero h1");
  assert.equal(await p.textContent(".ado-hero h1"), "修正登入");

  assert.deepEqual(await externals(p), []);
  assert.deepEqual(errors, []);
  await context.close();
});

test("Wiki 儲存庫裡的檔案開成唯讀分頁；找不到的頁面只提示；其他網站才用瀏覽器", async () => {
  const { page: p, context, errors } = await open({ desktop });
  await openComet(p);

  await clickLink(p, "設定檔");
  await p.waitForFunction(() => document.querySelector(".issue-body")?.textContent.includes('"version"'));
  const read = (await calls(p)).find((c) => c.cmd === "ado_repo_text");
  assert.equal(read.args.path, "/IRIS專區/release-notes.json");
  assert.equal(read.args.repo, "Contoso.wiki");
  await p.keyboard.press("Alt+ArrowLeft");
  await p.waitForFunction(() => document.querySelector(".issue-body h1:not([data-added])")?.textContent === "COBALT");

  await clickLink(p, "沒有這頁");
  await p.waitForSelector(".toast", { hasText: "找不到連結的頁面：沒有這頁" });
  assert.equal(await heading(p), "COBALT");
  assert.deepEqual(await externals(p), []);

  await clickLink(p, "外部網站");
  await p.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "open_external"));
  assert.deepEqual(await externals(p), ["https://example.com/doc"]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("網址只寫頁面編號、頁面樹裡又沒有編號（有些伺服器不回傳）：問伺服器那一頁在哪裡，在 oMarker 裡開", async () => {
  // 頁面樹沒有編號。
  const strip = (list) => list.map(({ id: _id, children, ...p }) => ({ ...p, children: strip(children) }));
  const START = "# 從這裡開始\n\n[返回 COBALT](https://ado.test/c/Contoso/_wiki/wikis/Contoso.wiki/53059)";
  const { page: p, context, errors } = await open({
    desktop: {
      ...desktop,
      ado_wiki_pages: [strip(PAGES)],
      ado_wiki_page: {
        $by: "path",
        values: { ...desktop.ado_wiki_page.values, "/IRIS專區/COBALT/GET-STARTED-guide": page(START) },
      },
      ado_wiki_page_path: "/IRIS專區/COBALT",
    },
  });
  await openComet(p);
  await clickLink(p, "開始");
  await p.waitForFunction(() => document.querySelector(".issue-body h1:not([data-added])")?.textContent === "從這裡開始");
  await clickLink(p, "返回 COBALT");
  await p.waitForFunction(() => document.querySelector(".issue-body h1:not([data-added])")?.textContent === "COBALT");
  const asked = (await calls(p)).find((c) => c.cmd === "ado_wiki_page_path").args;
  assert.deepEqual(asked, { projectId: "p1", wikiId: "w1", pageId: 53059 });
  assert.deepEqual(await externals(p), []);
  assert.deepEqual(errors, []);
  await context.close();
});
