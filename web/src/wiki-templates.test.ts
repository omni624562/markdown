import assert from "node:assert/strict";
import { test } from "node:test";
import { newPageBody, wikiTemplateFolder, wikiTemplatePages } from "./wiki-templates.ts";

const PATHS = ["/首頁", "/產品", "/產品/安裝", "/範本", "/範本/會議記錄", "/範本/週報", "/範本/週報/舊版", "/範本-說明"];

test("Wiki 裡放範本的頁面：最上層的「範本」或「Templates」（不分大小寫）", () => {
  assert.equal(wikiTemplateFolder(PATHS), "/範本");
  assert.equal(wikiTemplateFolder(["/Docs", "/TEMPLATES", "/TEMPLATES/Bug"]), "/TEMPLATES");
  assert.equal(wikiTemplateFolder(["/.templates"]), "/.templates");
  // 不在最上層的不算。
  assert.equal(wikiTemplateFolder(["/產品/範本", "/產品"]), null);
  assert.equal(wikiTemplateFolder([]), null);
});

test("範本頁面：只有直接的子頁面，依名稱排", () => {
  assert.deepEqual(wikiTemplatePages(PATHS, "/範本"), ["/範本/會議記錄", "/範本/週報"].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(wikiTemplatePages(PATHS, "/沒有"), []);
});

test("新頁面的內容：沒有範本時只有標題；範本的 {{標題}} 與日期換掉", () => {
  const now = new Date(2026, 10, 3, 9, 5);
  assert.equal(newPageBody("安裝說明", null, now), "# 安裝說明\n\n");
  assert.equal(newPageBody("安裝說明", "  \n", now), "# 安裝說明\n\n");
  assert.equal(newPageBody("週會 $1", "# {{標題}}\n\n> {{日期}}（{{ title }}）", now), "# 週會 $1\n\n> 2026-11-03（週會 $1）");
  // 不認得的變數原樣保留。
  assert.equal(newPageBody("A", "{{不知道}}", now), "{{不知道}}");
});
