import assert from "node:assert/strict";
import { test } from "node:test";
import { insideInlineSpan, matchSymbol } from "./auto-symbols.ts";

test("打字自動轉符號的規則", () => {
  assert.deepEqual(matchSymbol("a <="), { from: "<=", to: "≤" });
  assert.deepEqual(matchSymbol("x>="), { from: ">=", to: "≥" });
  assert.deepEqual(matchSymbol("1 !="), { from: "!=", to: "≠" });
  assert.deepEqual(matchSymbol("A ->"), { from: "->", to: "→" });
  assert.deepEqual(matchSymbol("±+-"), { from: "+-", to: "±" });
  // 一路打出 <=> 與 <->
  assert.deepEqual(matchSymbol("a ≤>"), { from: "≤>", to: "⇔" });
  assert.deepEqual(matchSymbol("a ←>"), { from: "←>", to: "↔" });
  // HTML 註解結尾、連續箭頭不轉
  assert.equal(matchSymbol("x -->"), null);
  assert.equal(matchSymbol("<--"), null);
  assert.equal(matchSymbol("==>"), null);
  assert.equal(matchSymbol("abc"), null);
});

test("行內數學公式與還沒打完的行內程式碼裡不轉換", () => {
  assert.equal(insideInlineSpan("程式碼 `a"), true);
  assert.equal(insideInlineSpan("程式碼 `a` 後面"), false);
  assert.equal(insideInlineSpan("若 $a"), true);
  assert.equal(insideInlineSpan("若 $a$ 且 b"), false);
  assert.equal(insideInlineSpan("價格 \\$5 與 b"), false);
});
