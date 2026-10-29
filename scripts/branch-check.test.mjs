import assert from "node:assert/strict";
import { test } from "node:test";
import { violations } from "./branch-check.mjs";

const inMain = (sha) => sha.startsWith("m");

test("只把 main 合併進來的 PR 沒有問題", () => {
  assert.deepEqual(violations("main", [{ sha: "a1", parents: ["a0", "m5"], subject: "Merge branch 'main'" }], inMain), []);
  assert.deepEqual(violations("main", [], inMain), []);
});

test("目標不是 main、或合併了別的功能分支時擋下來", () => {
  assert.equal(violations("claude/other", [], inMain).length, 1);
  const stacked = violations("main", [{ sha: "b1", parents: ["b0", "c9"], subject: "Merge claude/甲 into claude/乙" }], inMain);
  assert.equal(stacked.length, 1);
  assert.match(stacked[0], /Merge claude\/甲 into claude\/乙/);
});
