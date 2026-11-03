import assert from "node:assert/strict";
import { test } from "node:test";
import { movedPaths, relinkText, wikiHref } from "./wiki-relink.ts";
import { pageLinkResolver } from "./wiki-text.ts";

const PAGES = ["/首頁", "/產品", "/產品/安裝 說明", "/產品/安裝 說明/附錄", "/產品/規格", "/文件"];

/** 把 `from` 搬到 `to`：回傳每一頁要改成的內文（沒有要改的不列）。 */
function relinkAll(sources: Record<string, string>, from: string, to: string): Record<string, string> {
  const moved = movedPaths(PAGES, from, to);
  const before = pageLinkResolver(PAGES);
  const after = pageLinkResolver(PAGES.map((p) => moved.get(p) ?? p));
  const out: Record<string, string> = {};
  for (const [page, text] of Object.entries(sources)) {
    const next = relinkText(text, page, moved, before, after);
    if (next !== null) out[page] = next;
  }
  return out;
}

test("搬移的頁面與底下的子頁面", () => {
  assert.deepEqual(
    [...movedPaths(PAGES, "/產品/安裝 說明", "/文件/安裝")],
    [
      ["/產品/安裝 說明", "/文件/安裝"],
      ["/產品/安裝 說明/附錄", "/文件/安裝/附錄"],
    ],
  );
  // 只比對整段名稱（「/產品」不包含「/產品線」）。
  assert.deepEqual([...movedPaths(["/產品", "/產品線"], "/產品", "/商品").keys()], ["/產品"]);
});

test("連結寫法：- 寫成 %2D、空白寫成 -，會讓連結斷掉的字元編碼，中文照原樣", () => {
  assert.equal(wikiHref("/產品/安裝 說明"), "/產品/安裝-說明");
  assert.equal(wikiHref("/A-B/C (舊) #1"), "/A%2DB/C-%28舊%29-%231");
  assert.equal(wikiHref("/100%"), "/100%25");
  // 寫出來的連結解析回同一頁。
  for (const p of ["/A-B/C (舊) #1", "/100%", "/產品/安裝 說明"]) assert.equal(pageLinkResolver([p])(wikiHref(p), "/"), p);
});

test("連到搬移的頁面（和子頁面）的連結改成新位置；保留錨點；沒指到的、網址不改", () => {
  const out = relinkAll(
    {
      "/首頁": [
        "- [安裝](/產品/安裝-說明)、[附錄](/產品/安裝-說明/附錄#第一節)",
        "- [規格](/產品/規格) 不變",
        "- [網址](https://ado.test/c/P/_wiki/wikis/P.wiki/21/安裝-說明) 不變",
        "```",
        "[程式碼裡的](/產品/安裝-說明)",
        "```",
      ].join("\n"),
      "/產品/規格": "見 [安裝](安裝-說明.md)。\n[ref]: ./安裝-說明",
      "/文件": "沒有連結",
    },
    "/產品/安裝 說明",
    "/文件/安裝",
  );
  assert.deepEqual(out, {
    "/首頁": [
      "- [安裝](/文件/安裝)、[附錄](/文件/安裝/附錄#第一節)",
      "- [規格](/產品/規格) 不變",
      "- [網址](https://ado.test/c/P/_wiki/wikis/P.wiki/21/安裝-說明) 不變",
      "```",
      "[程式碼裡的](/產品/安裝-說明)",
      "```",
    ].join("\n"),
    "/產品/規格": "見 [安裝](/文件/安裝)。\n[ref]: /文件/安裝",
  });
});

test("搬移的頁面自己裡面的相對連結：搬過去後指到別頁的改成絕對路徑，指到子頁面的不用改", () => {
  const out = relinkAll(
    {
      "/產品/安裝 說明": "前面是 [規格](../規格)、[附錄](附錄)、[自己](/產品/安裝-說明)",
    },
    "/產品/安裝 說明",
    "/安裝",
  );
  assert.deepEqual(out, {
    "/產品/安裝 說明": "前面是 [規格](/產品/規格)、[附錄](附錄)、[自己](/安裝)",
  });
});

test("只改名：同一層的相對連結也跟著改", () => {
  const out = relinkAll({ "/產品/規格": "[安裝](安裝-說明) <a href=\"安裝-說明\">安裝</a>" }, "/產品/安裝 說明", "/產品/安裝指南");
  assert.deepEqual(out, { "/產品/規格": "[安裝](/產品/安裝指南) <a href=\"/產品/安裝指南\">安裝</a>" });
});
