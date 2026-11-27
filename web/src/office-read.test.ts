import assert from "node:assert/strict";
import { test } from "node:test";
import { cellRef, excelDate, isDateFormat, plainNumber } from "./office-read.ts";

test("cellRef：儲存格位置換成列、欄（從 0 開始）", () => {
  assert.deepEqual(cellRef("A1"), { row: 0, col: 0 });
  assert.deepEqual(cellRef("B12"), { row: 11, col: 1 });
  assert.deepEqual(cellRef("AA3"), { row: 2, col: 26 });
  assert.equal(cellRef("1A"), null);
});

test("isDateFormat：日期、時間格式；數字、百分比、引號裡的字不算", () => {
  assert.ok(isDateFormat("yyyy/mm/dd"));
  assert.ok(isDateFormat("[$-404]e/m/d"));
  assert.ok(isDateFormat("hh:mm"));
  assert.ok(!isDateFormat("#,##0.00"));
  assert.ok(!isDateFormat("0%"));
  assert.ok(!isDateFormat('0.0"days"'));
});

test("excelDate：日期序號換成日期（有時間時加上時分）", () => {
  assert.equal(excelDate(46224), "2026/07/21");
  assert.equal(excelDate(46224.5), "2026/07/21 12:00");
  assert.equal(excelDate(0.75), "18:00");
});

test("plainNumber：去掉浮點數尾巴，其他照原樣", () => {
  assert.equal(plainNumber("0.30000000000000004"), "0.3");
  assert.equal(plainNumber("1234.5"), "1234.5");
  assert.equal(plainNumber("abc"), "abc");
});
