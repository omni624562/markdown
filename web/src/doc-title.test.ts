import assert from "node:assert/strict";
import { test } from "node:test";
import { isUntitledName, shortTitle, titleFileName, titleOf } from "./doc-title.ts";

const md = (text: string) => titleOf(text.split("\n"), "markdown");

test("Markdown：第一個標題（任何層級），去掉 # 與行內符號", () => {
  assert.equal(md("前言\n\n## 第三季 **產品** 規劃 ##\n# 後面的標題"), "第三季 產品 規劃");
  assert.equal(md("# [會議紀錄](https://x.test) `v2` <mark>重點</mark>"), "會議紀錄 v2 重點");
  assert.equal(md("###### 很深的標題"), "很深的標題");
  assert.equal(md("內文\n\n設計稿\n===\n\n# 之後"), "設計稿", "Setext 標題");
});

test("Markdown：#標籤、程式碼區塊與 front matter 裡的 # 不算標題", () => {
  assert.equal(md("#專案A 待辦\n\n```sh\n# 註解\n```\n"), "#專案A 待辦");
  assert.equal(md("```sh\n# 註解\n```\n\n# 真的標題"), "真的標題");
  assert.equal(md("---\ntitle: x\n---\n\n# 標題"), "標題");
  assert.equal(md("#\n\n# \n內容"), "內容", "空的標題跳過");
});

test("Markdown：沒有標題時用第一行有字的（去掉清單、引言符號）", () => {
  assert.equal(md("\n\n   \n- [ ] 買**牛奶**\n- 其他"), "買牛奶");
  assert.equal(md("> 引用的一句話"), "引用的一句話");
  assert.equal(md("![](a.png)\n第二行"), "第二行");
  assert.equal(md(""), "");
  assert.equal(md("  \n\n"), "");
});

test("純文字用第一行有字的；JSON 沒有標題", () => {
  assert.equal(titleOf(["", "  # 不是標題  ", "x"], "text"), "# 不是標題");
  assert.equal(titleOf(['{ "a": 1 }'], "json"), "");
});

test("只看前面一段：很後面才出現的標題不算", () => {
  const lines = ["開頭", ...Array.from({ length: 2000 }, () => "內文"), "# 很後面的標題"];
  assert.equal(titleOf(lines, "markdown"), "開頭");
});

test("分頁名稱太長時截斷加「…」", () => {
  assert.equal(shortTitle("短標題"), "短標題");
  const long = "一二三四五六七八九十".repeat(4);
  assert.equal(shortTitle(long), `${long.slice(0, 29)}…`);
  assert.equal([...shortTitle(long)].length, 30);
  assert.equal(shortTitle("😀".repeat(31)), `${"😀".repeat(29)}…`, "表情符號算一個字");
});

test("標題當成檔名：去掉不能用的字元，最多 60 字", () => {
  assert.equal(titleFileName('A/B 測試：「方案」? <草稿> | "v2" *'), "AB 測試：「方案」 草稿 v2");
  assert.equal(titleFileName("  ..點開頭.  "), "點開頭");
  assert.equal([...titleFileName("字".repeat(80))].length, 60);
  assert.equal(titleFileName("///"), "");
});

test("預設名稱（還沒取名）", () => {
  assert.ok(isUntitledName("未命名.md"));
  assert.ok(isUntitledName("未命名"));
  assert.ok(isUntitledName("未命名.txt"));
  assert.ok(isUntitledName("Untitled.md"));
  assert.ok(!isUntitledName("未命名 2.md"));
  assert.ok(!isUntitledName("週報.md"));
});
