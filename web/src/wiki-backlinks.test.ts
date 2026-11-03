import assert from "node:assert/strict";
import { test } from "node:test";
import { findBacklinks, linksIn } from "./wiki-backlinks.ts";
import { pageLinkResolver } from "./wiki-text.ts";

const hrefs = (md: string) => linksIn(md).map((l) => [l.line, l.href]);

test("找出內文裡的連結：行內、參考式、<a>、網址；程式碼與圖片裡的不算", () => {
  const md = [
    "請看 [安裝](/產品/安裝-說明) 和 [規格](<../規格 書.md> \"標題\")。",
    "![圖](/.attachments/a.png) [[_TOC_]]",
    "`[不算](/x)` 直接寫 https://ado.test/c/P/_wiki/wikis/P.wiki/12/安裝。",
    "```",
    "[不算](/y)",
    "```",
    "[ref]: /產品/安裝-說明",
    '<a href="/產品">產品</a> <!-- [不算](/z) --> [錨點](#標題)',
    "[同一行](/A) 又一次 [同一行](/A)",
  ].join("\n");
  assert.deepEqual(hrefs(md), [
    [1, "/產品/安裝-說明"],
    [1, "../規格 書.md"],
    [3, "https://ado.test/c/P/_wiki/wikis/P.wiki/12/安裝"],
    [7, "/產品/安裝-說明"],
    [8, "/產品"],
    [9, "/A"],
  ]);
  // 連結文字就是網址時只算一次；網址結尾的標點不算。
  assert.deepEqual(hrefs("[https://x.test/a](https://x.test/a) 和 https://x.test/b."), [
    [1, "https://x.test/a"],
    [1, "https://x.test/b"],
  ]);
  // `~~~` 圍起來的也是程式碼區塊；長度不夠的結尾不算結束。
  assert.deepEqual(hrefs("~~~~\n[不算](/a)\n~~~\n[不算](/b)\n~~~~\n[算](/c)"), [[6, "/c"]]);
});

test("清單上顯示的那一行：去掉前後空白，太長截斷", () => {
  const [link] = linksIn(`   - [安裝](/安裝) ${"字".repeat(300)}`);
  assert.ok(link.text.startsWith("- [安裝](/安裝)"));
  assert.ok(link.text.endsWith("…"));
  assert.ok([...link.text].length <= 161);
});

test("哪些頁面連到這一頁：相對、絕對路徑都算，自己連到自己不算", () => {
  const pages = ["/產品", "/產品/安裝 說明", "/產品/規格", "/首頁", "/其他"];
  const resolve = pageLinkResolver(pages);
  const sources = [
    { page: "/首頁", text: "- [安裝](/產品/安裝-說明)\n- [規格](/產品/規格)" },
    { page: "/產品/規格", text: "前置作業見 [安裝](./安裝-說明.md)。\n\n再看一次 [這裡](安裝-說明)" },
    { page: "/產品/安裝 說明", text: "[本頁](/產品/安裝-說明)" },
    { page: "/其他", text: "沒有連結 [別的](/產品)" },
  ];
  assert.deepEqual(
    findBacklinks("/產品/安裝 說明", sources, resolve).map((b) => [b.page, b.line]),
    [
      ["/首頁", 1],
      ["/產品/規格", 1],
      ["/產品/規格", 3],
    ],
  );
  assert.deepEqual(findBacklinks("/首頁", sources, resolve), []);
});
