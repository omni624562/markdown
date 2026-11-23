/**
 * Wiki 的樹狀目錄展開到比面板高時要出現捲軸、捲得到最後一頁；上面的 Wiki 選單與搜尋框留在原地。
 * （以前面板本身不捲、清單也不捲，超出的部分直接被切掉，看不到捲軸。）左邊和放在右側欄都一樣。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

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
const kids = (p) => Array.from({ length: 8 }, (_, i) => ({ path: `${p}/頁面 ${i + 1}`, id: i, children: [] }));
const pages = Array.from({ length: 10 }, (_, i) => ({ path: `/區域 ${i + 1}`, id: 100 + i, children: kids(`/區域 ${i + 1}`) }));

for (const right of [false, true]) {
  test(`Wiki ${right ? "在右側欄" : "在左邊"}：展開到比面板高時出現捲軸，捲得到最後一頁`, async () => {
    const { page, context, errors } = await open({
      desktop: { ado_account: { url: "https://ado.test/c", name: "王小明" }, ado_wikis: [[WIKI]], ado_wiki_pages: [pages] },
    });
    await page.setViewportSize({ width: 1280, height: 600 });
    if (right) {
      await page.evaluate(() => {
        localStorage.setItem("md-editor:wiki-right", "1");
        localStorage.setItem("md-editor:outline-right", "hidden");
      });
      await page.reload();
    }
    await page.locator("#side-tab-wiki").click();
    const panel = page.locator("#panel-wiki");
    const scroll = panel.locator(".wiki-scroll");
    await panel.locator('.wiki-page[data-path="/區域 1"]').waitFor();
    // 一層 10 頁放得下：還不用捲。
    assert.equal(await scroll.evaluate((el) => el.scrollHeight > el.clientHeight), false);
    for (const n of [1, 2, 3, 4, 5]) await panel.locator(`.wiki-row:has(> .wiki-page[data-path="/區域 ${n}"]) .wiki-toggle`).click();
    await panel.locator('.wiki-page[data-path="/區域 5/頁面 8"]').waitFor({ state: "attached" });
    const box = await scroll.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, ov: getComputedStyle(el).overflowY }));
    assert.ok(box.sh > box.ch, "展開後比面板高");
    assert.equal(box.ov, "auto", "清單自己會捲（有捲軸）");
    // 捲到最下面：最後一頁看得到；搜尋框還在原地。
    await scroll.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const last = panel.locator('.wiki-page[data-path="/區域 10"]');
    const inside = await page.evaluate(
      ([a, b]) => {
        const r = a.getBoundingClientRect();
        const s = b.getBoundingClientRect();
        return r.top >= s.top - 1 && r.bottom <= s.bottom + 1;
      },
      [await last.elementHandle(), await scroll.elementHandle()],
    );
    assert.equal(inside, true, "捲到最下面看得到最後一頁");
    assert.equal(await panel.locator("input[type=search]").isVisible(), true, "搜尋框留在原地");
    assert.equal(await panel.evaluate((el) => el.querySelector(".side-body")?.scrollTop ?? 0), 0, "面板本身不捲");
    assert.deepEqual(errors, []);
    await context.close();
  });
}
