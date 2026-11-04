/**
 * Wiki 子頁面排序：在樹狀目錄拖曳到同一層的別的位置、右鍵選單「往上移／往下移」、Alt+↑／↓，
 * 畫面上先排好，再請伺服器調整（pagemoves）；失敗時放回原位。程式碼 Wiki 不能排。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
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
  { path: "/A", id: 1, children: [] },
  {
    path: "/B",
    id: 2,
    children: [
      { path: "/B/1", id: 21, children: [] },
      { path: "/B/2", id: 22, children: [] },
      { path: "/B/3", id: 23, children: [] },
    ],
  },
  { path: "/C", id: 3, children: [] },
];
const base = { ado_account: { url: "https://ado.test/c", name: "王小明" }, ado_wiki_pages: [PAGES] };

async function wikiPanel(desktop) {
  const opened = await open({ desktop: { ...base, ...desktop } });
  await opened.page.click("#side-tab-wiki");
  await opened.page.locator('#wiki-host .wiki-page[data-path="/A"]').waitFor();
  return opened;
}
const order = (p) => p.locator("#wiki-host .wiki-tree .wiki-page").evaluateAll((bs) => bs.map((b) => b.dataset.path));
const moves = async (p) => (await calls(p)).filter((c) => c.cmd === "ado_wiki_move").map((c) => c.args);
/** 對某一頁按右鍵，回傳選單裡的項目。 */
async function menuFor(p, path) {
  await p.locator(`#wiki-host .wiki-page[data-path="${path}"]`).click({ button: "right" });
  const menu = p.locator('[id^="wiki-menu-"][id$="-popover"]');
  await menu.waitFor();
  return menu;
}

test("右鍵選單往上移／往下移、Alt+↑／↓：畫面先排好，再請伺服器調整（搬完之後的位置）", async () => {
  const { page: p, context, errors } = await wikiPanel({ ado_wikis: [[WIKI]], ado_wiki_move: null });
  let menu = await menuFor(p, "/A");
  assert.equal(await menu.getByRole("menuitem", { name: "往上移" }).count(), 0, "第一頁不能再往上");
  await menu.getByRole("menuitem", { name: "往下移" }).click();
  assert.deepEqual(await order(p), ["/B", "/A", "/C"]);
  await p.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_wiki_move"));
  assert.deepEqual(await moves(p), [{ projectId: "p1", wikiId: "w1", path: "/A", newPath: "/A", newOrder: 1 }]);
  menu = await menuFor(p, "/C");
  assert.equal(await menu.getByRole("menuitem", { name: "往下移" }).count(), 0, "最後一頁不能再往下");
  await p.keyboard.press("Escape");
  // 鍵盤：Alt+↑ 往上移，焦點留在同一頁。
  await p.locator('#wiki-host .wiki-page[data-path="/C"]').focus();
  await p.keyboard.press("Alt+ArrowUp");
  assert.deepEqual(await order(p), ["/B", "/C", "/A"]);
  await p.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "ado_wiki_move").length === 2);
  assert.equal((await moves(p))[1].newOrder, 1);
  assert.equal(await p.evaluate(() => document.activeElement?.dataset.path), "/C");
  assert.deepEqual(errors, []);
  await context.close();
});

test("拖曳到同一層的別的位置；拖到別層先開對話框確認", async () => {
  const { page: p, context, errors } = await wikiPanel({ ado_wikis: [[WIKI]], ado_wiki_move: null });
  // 展開 /B。
  await p.locator('#wiki-host .wiki-row:has(.wiki-page[data-path="/B"]) .wiki-toggle').click();
  await p.locator('#wiki-host .wiki-page[data-path="/B/3"]').waitFor();
  const row = (path) => p.locator(`#wiki-host .wiki-row:has(> .wiki-page[data-path="${path}"])`);
  // 拖到 /B/1 的上半部 → 排第一個。
  await p.locator('#wiki-host .wiki-page[data-path="/B/3"]').dragTo(row("/B/1"), { targetPosition: { x: 40, y: 3 } });
  assert.deepEqual(await order(p), ["/A", "/B", "/B/3", "/B/1", "/B/2", "/C"]);
  await p.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "ado_wiki_move"));
  assert.deepEqual((await moves(p)).map((m) => [m.path, m.newOrder]), [["/B/3", 0]]);
  // 拖到別層（/A 是最上層）：開「改名或搬移」的對話框確認（放在最上層）；取消就不動。
  await p.locator('#wiki-host .wiki-page[data-path="/B/1"]').dragTo(row("/A"), { targetPosition: { x: 40, y: 3 } });
  const dialog = p.locator("dialog.wiki-move[open]");
  await dialog.waitFor();
  assert.equal(await dialog.locator("select").inputValue(), "", "放在最上層");
  await dialog.getByRole("button", { name: "取消" }).click();
  assert.deepEqual(await order(p), ["/A", "/B", "/B/3", "/B/1", "/B/2", "/C"]);
  assert.equal((await moves(p)).length, 1);
  // 最上層：/A 拖到 /C 的下半部 → 排最後。
  await p.locator('#wiki-host .wiki-page[data-path="/A"]').dragTo(row("/C"), { targetPosition: { x: 40, y: 20 } });
  assert.deepEqual(await order(p), ["/B", "/B/3", "/B/1", "/B/2", "/C", "/A"]);
  await p.waitForFunction(() => window.__fake.calls.filter((c) => c.cmd === "ado_wiki_move").length === 2);
  assert.deepEqual((await moves(p))[1], { projectId: "p1", wikiId: "w1", path: "/A", newPath: "/A", newOrder: 2 });
  assert.equal(await p.locator("#wiki-host [data-drop]").count(), 0, "放下後清掉線");
  assert.deepEqual(errors, []);
  await context.close();
});

test("伺服器調整失敗：放回原位並顯示錯誤；程式碼 Wiki 不能排", async () => {
  // 伺服器慢一點才回失敗，才看得到「先排好」（太短的話，CI 比較慢的機器上還沒讀到就已經放回去了）。
  const { page: p, context } = await wikiPanel({ ado_wikis: [[WIKI]], ado_wiki_move: { $delay: 1500, $error: "權限不足" } });
  const menu = await menuFor(p, "/C");
  await menu.getByRole("menuitem", { name: "往上移" }).click();
  assert.deepEqual(await order(p), ["/A", "/C", "/B"], "先排好");
  await p.waitForFunction(() => [...document.querySelectorAll("#wiki-host .wiki-tree .wiki-page")].map((b) => b.dataset.path).join() === "/A,/B,/C");
  await p.locator(".toasts", { hasText: "權限不足" }).waitFor();
  await context.close();

  const code = await wikiPanel({ ado_wikis: [[{ ...WIKI, code: true, mappedPath: "/docs" }]], ado_wiki_move: null });
  const codeMenu = await menuFor(code.page, "/B");
  assert.equal(await codeMenu.getByRole("menuitem", { name: "往上移" }).count(), 0);
  await code.page.keyboard.press("Escape");
  await code.page.locator('#wiki-host .wiki-page[data-path="/C"]').focus();
  await code.page.keyboard.press("Alt+ArrowUp");
  assert.deepEqual(await order(code.page), ["/A", "/B", "/C"]);
  assert.equal((await moves(code.page)).length, 0);
  await code.context.close();
});
