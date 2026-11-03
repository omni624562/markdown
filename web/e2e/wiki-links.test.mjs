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
  {
    path: "/ITA專區",
    id: 1,
    children: [
      {
        path: "/ITA專區/COMET",
        id: 2,
        children: [
          { path: "/ITA專區/COMET/START-HERE-illustrated", id: 3, children: [] },
          { path: "/ITA專區/COMET/Skill自然語言使用範例", id: 4, children: [] },
        ],
      },
    ],
  },
];
const COMET = [
  "# COMET",
  "",
  "- [開始](START-HERE-illustrated)",
  // 連線設定是 https://ado.test/c，連結只寫電腦名稱、用 http。
  "- [Skill 範例](http://ado/c/Mgt/_wiki/wikis/Mgt.wiki/4/Skill自然語言使用範例)",
  "- [工作項目](http://ado/c/Mgt/_workitems/edit/42)",
  "- [設定檔](release-zip-manifest.json)",
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
  project: "Mgt",
  assignedTo: "王小明",
  changed: "2026-10-30T00:00:00Z",
  priority: 2,
  webUrl: "https://ado.test/c/Mgt/_workitems/edit/42",
  createdBy: "王小明",
  area: "Mgt",
  iteration: "Mgt",
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
      "/ITA專區": page("# ITA專區"),
      "/ITA專區/COMET": page(COMET),
      "/ITA專區/COMET/START-HERE-illustrated": page("# 從這裡開始\n\n[回到 COMET](../COMET)"),
      "/ITA專區/COMET/Skill自然語言使用範例": page("# Skill 範例"),
    },
  },
  ado_work_item: ITEM,
  ado_repo_text: '{ "version": "6.3.0" }',
};

const heading = (p) => p.textContent(".issue-body h1");
const externals = async (p) => (await calls(p)).filter((c) => c.cmd === "open_external").map((c) => c.args.url);

async function openComet(p) {
  await p.click("#side-tab-wiki");
  // 頁面樹一開始收著：展開「ITA專區」再點「COMET」。
  await p.locator("#wiki-host li", { has: p.locator('.wiki-page[data-path="/ITA專區"]') }).locator(".wiki-toggle").first().click();
  await p.click('#wiki-host .wiki-page[data-path="/ITA專區/COMET"]');
  await p.waitForFunction(() => document.querySelector(".issue-body h1")?.textContent === "COMET");
}

async function clickLink(p, text) {
  await p.locator(".issue-body a", { hasText: text }).click();
}

test("Wiki 頁面裡的子頁面、完整網址、工作項目都在 oMarker 裡開，不開瀏覽器", async () => {
  const { page: p, context, errors } = await open({ desktop });
  await openComet(p);

  // 相對路徑寫成「子頁面」（不是「COMET/子頁面」）：當成目前頁面底下的子頁面。
  await clickLink(p, "開始");
  await p.waitForFunction(() => document.querySelector(".issue-body h1")?.textContent === "從這裡開始");
  // 子頁面裡的 ../COMET 回到上一層。
  await clickLink(p, "回到 COMET");
  await p.waitForFunction(() => document.querySelector(".issue-body h1")?.textContent === "COMET");

  // 完整網址：只寫電腦名稱、http，也認得是連線中的伺服器。
  await clickLink(p, "Skill 範例");
  await p.waitForFunction(() => document.querySelector(".issue-body h1")?.textContent === "Skill 範例");
  await p.keyboard.press("Alt+ArrowLeft");
  await p.waitForFunction(() => document.querySelector(".issue-body h1")?.textContent === "COMET");

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
  assert.equal(read.args.path, "/ITA專區/release-zip-manifest.json");
  assert.equal(read.args.repo, "Mgt.wiki");
  await p.keyboard.press("Alt+ArrowLeft");
  await p.waitForFunction(() => document.querySelector(".issue-body h1")?.textContent === "COMET");

  await clickLink(p, "沒有這頁");
  await p.waitForSelector(".toast", { hasText: "找不到連結的頁面：沒有這頁" });
  assert.equal(await heading(p), "COMET");
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
  const START = "# 從這裡開始\n\n[返回 COMET](https://ado.test/c/Mgt/_wiki/wikis/Mgt.wiki/53059)";
  const { page: p, context, errors } = await open({
    desktop: {
      ...desktop,
      ado_wiki_pages: [strip(PAGES)],
      ado_wiki_page: {
        $by: "path",
        values: { ...desktop.ado_wiki_page.values, "/ITA專區/COMET/START-HERE-illustrated": page(START) },
      },
      ado_wiki_page_path: "/ITA專區/COMET",
    },
  });
  await openComet(p);
  await clickLink(p, "開始");
  await p.waitForFunction(() => document.querySelector(".issue-body h1")?.textContent === "從這裡開始");
  await clickLink(p, "返回 COMET");
  await p.waitForFunction(() => document.querySelector(".issue-body h1")?.textContent === "COMET");
  const asked = (await calls(p)).find((c) => c.cmd === "ado_wiki_page_path").args;
  assert.deepEqual(asked, { projectId: "p1", wikiId: "w1", pageId: 53059 });
  assert.deepEqual(await externals(p), []);
  assert.deepEqual(errors, []);
  await context.close();
});
