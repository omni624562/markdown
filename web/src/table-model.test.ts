import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cellText,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  parseTable,
  serializeTable,
  setAlign,
  setCell,
  toCell,
} from "./table-model.ts";

const MD = "| 項目 | 數量 |\n| :--- | ---: |\n| 蘋果 | 3 |\n| 香蕉 | `a|b` |";

test("解析與組回表格", () => {
  const t = parseTable(MD);
  assert.deepEqual(t.header, ["項目", "數量"]);
  assert.deepEqual(t.aligns, ["left", "right"]);
  assert.deepEqual(t.body, [
    ["蘋果", "3"],
    ["香蕉", "`a|b`"],
  ]);
  assert.equal(serializeTable(t), "| 項目 | 數量 |\n| :--- | ---: |\n| 蘋果 | 3 |\n| 香蕉 | `a|b` |");
  assert.equal(cellText(t, 0, 1), "數量");
  assert.equal(cellText(t, 2, 0), "香蕉");
});

test("清單裡的表格保留縮排，缺少的儲存格補空", () => {
  const t = parseTable("  | a | b |\n  | --- | --- |\n  | 1 |");
  assert.equal(t.indent, "  ");
  assert.deepEqual(t.body, [["1", ""]]);
  assert.ok(serializeTable(t).split("\n").every((l) => l.startsWith("  | ")));
});

test("編輯儲存格：| 跳脫、換行變 <br>", () => {
  assert.equal(toCell("a|b\n第二行"), "a\\|b<br>第二行");
  assert.equal(toCell("蘋果\n\n"), "蘋果");
  assert.equal(toCell("已跳脫 \\| 不再跳脫"), "已跳脫 \\| 不再跳脫");
  const t = setCell(parseTable(MD), 1, 1, "5");
  assert.equal(t.body[0][1], "5");
  assert.equal(parseTable(MD).body[0][1], "3"); // 原本的不受影響
});

test("新增、刪除列與欄，設定對齊", () => {
  let t = parseTable(MD);
  t = insertRow(t, 1);
  assert.deepEqual(t.body[1], ["", ""]);
  t = deleteRow(t, 2);
  assert.equal(t.body.length, 2);
  assert.equal(deleteRow(t, 0), t); // 標題列不能刪
  t = insertColumn(t, 0);
  assert.deepEqual(t.header, ["項目", "", "數量"]);
  t = setAlign(t, 1, "center");
  assert.ok(serializeTable(t).split("\n")[1].includes(":---:"));
  t = deleteColumn(t, 1);
  assert.deepEqual(t.header, ["項目", "數量"]);
});
