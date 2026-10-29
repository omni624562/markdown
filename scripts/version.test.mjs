import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, next, notesOf, summary } from "./version.mjs";

test("下一個版本號", () => {
  assert.equal(next("1.4.2", "patch"), "1.4.3");
  assert.equal(next("1.4.2", "minor"), "1.5.0");
  assert.equal(next("1.4.2", "major"), "2.0.0");
  assert.equal(next("1.4.2", "1.6.0"), "1.6.0");
  assert.throws(() => next("1.4.2", "bigger"));
});

test("比較版本號（數字比大小，不是字串）", () => {
  assert.ok(compare("1.10.0", "1.9.9") > 0);
  assert.ok(compare("2.0.0", "10.0.0") < 0);
  assert.equal(compare("1.2.3", "1.2.3"), 0);
});

test("取出某一版的說明與摘要", () => {
  const log = "# 更新紀錄\n\n## 1.1.0 — 2026-10-23\n\n### 新功能\n\n- 斜線指令\n- `@今天` 日期\n\n## 1.0.0 — 2026-10-22\n\n- 第一版\n";
  assert.equal(notesOf(log, "1.1.0"), "### 新功能\n\n- 斜線指令\n- `@今天` 日期");
  assert.equal(notesOf(log, "1.0.0"), "- 第一版");
  assert.equal(notesOf(log, "1.0"), null);
  assert.equal(notesOf(log, "2.0.0"), null);
  assert.equal(summary(notesOf(log, "1.1.0")), "斜線指令；@今天 日期");
  assert.equal(summary("- " + "很長".repeat(100), 10).length, 10);
  // 巢狀清單：冒號後面直接接子項目，句號結尾不重複加分號。
  assert.equal(summary("- 圖示列：\n  - 拖曳頁面。\n  - 右鍵移除。\n- 其他"), "圖示列：拖曳頁面；右鍵移除；其他");
});
