/**
 * 新增 Wiki 頁面時選範本：空白頁面、這個 Wiki 最上層「範本」頁面底下的子頁面（大家共用）、自訂與內建範本；
 * 範本裡的 {{標題}} 換成新頁面的標題。記住這個 Wiki 上次選的範本。
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
  { path: "/產品", id: 1, children: [{ path: "/產品/安裝", id: 2, children: [] }] },
  {
    path: "/範本",
    id: 3,
    children: [
      { path: "/範本/會議記錄", id: 4, children: [] },
      { path: "/範本/規格", id: 5, children: [] },
    ],
  },
];
const page = (content) => ({ content, webUrl: null, etag: '"1"' });
const desktop = {
  ado_account: { url: "https://ado.test/c", name: "王小明" },
  ado_wikis: [[WIKI]],
  ado_wiki_pages: [PAGES],
  ado_wiki_page: {
    $by: "path",
    values: {
      "/範本/會議記錄": page("# {{標題}}\n\n- 日期：{{日期}}\n- 與會："),
      "/週會": page("# 週會"),
      "/產品/安裝": page("# 安裝"),
      "/產品/重複": page("# 重複"),
      "/重複": page("# 重複"),
      "/新的": page("# 新的"),
    },
  },
  ado_wiki_create: '"1"',
  load_settings: JSON.stringify({ templates: [{ name: "我的範本", body: "# {{title}}\n\n自訂內容" }] }),
};

async function newPageDialog(p) {
  await p.click("#side-tab-wiki");
  await p.locator('#wiki-host .wiki-page[data-path="/產品"]').waitFor();
  await p.click("#wiki-host .wiki-new");
  const dialog = p.locator("dialog.wiki-new-page[open]");
  await dialog.waitFor();
  return dialog;
}

test("新增 Wiki 頁面：列出這個 Wiki 的範本、自訂與內建範本；用 Wiki 裡的範本建立，{{標題}} 換掉", async () => {
  const { page: p, context, errors } = await open({ desktop });
  const dialog = await newPageDialog(p);
  const groups = await dialog.locator("optgroup").evaluateAll((gs) => gs.map((g) => [g.label, [...g.children].map((o) => o.textContent)]));
  assert.equal(groups[0][0], "這個 Wiki 的範本（範本）");
  assert.deepEqual([...groups[0][1]].sort(), ["會議記錄", "規格"].sort(), "「範本」底下的子頁面");
  assert.deepEqual(groups[1], ["自訂範本", ["我的範本"]]);
  assert.equal(groups[2][0], "內建範本");
  assert.ok(groups[2][1].includes("週報") && !groups[2][1].includes("空白文件"), "內建的空白文件和空白頁面重複，不列");
  assert.equal(await dialog.locator("select").inputValue(), "", "預設是空白頁面");
  // 同名的頁面不行。
  await dialog.locator("input").fill("產品");
  await dialog.locator("button", { hasText: "建立" }).click();
  assert.match(await dialog.locator(".wi-create-error").textContent(), /已經有同名的頁面/);
  await dialog.locator("input").fill("週會");
  await dialog.locator("select").selectOption({ label: "會議記錄" });
  await dialog.locator("button", { hasText: "建立" }).click();
  await p.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_wiki_create"));
  const sent = (await calls(p)).find((c) => c.cmd === "ado_wiki_create").args;
  assert.equal(sent.path, "/週會");
  assert.match(sent.content, /^# 週會\n\n- 日期：\d{4}-\d{2}-\d{2}\n- 與會：$/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("新增頁面：記住這個 Wiki 上次選的範本；自訂範本的 {{title}} 也換掉；空白頁面只有標題", async () => {
  const { page: p, context, errors } = await open({ desktop });
  let dialog = await newPageDialog(p);
  await dialog.locator("input").fill("重複");
  await dialog.locator("select").selectOption({ label: "我的範本" });
  await dialog.locator("button", { hasText: "建立" }).click();
  await p.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_wiki_create"));
  assert.equal((await calls(p)).find((c) => c.cmd === "ado_wiki_create").args.content, "# 重複\n\n自訂內容");
  // 再開一次：選的是上次的範本。
  await p.keyboard.press("Escape");
  await p.click("#wiki-host .wiki-new");
  dialog = p.locator("dialog.wiki-new-page[open]");
  await dialog.waitFor();
  assert.equal(await dialog.locator("select").inputValue(), "custom:我的範本");
  await dialog.locator("select").selectOption("");
  await dialog.locator("input").fill("新的");
  await dialog.locator("button", { hasText: "建立" }).click();
  await p.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "ado_wiki_create").length === 2);
  assert.equal((await calls(p)).filter((c) => c.cmd === "ado_wiki_create")[1].args.content, "# 新的\n\n");
  assert.deepEqual(errors, []);
  await context.close();
});
