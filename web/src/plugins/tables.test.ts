import assert from "node:assert/strict";
import { test } from "node:test";
import { splitNumbers } from "./tables.ts";

test("表格裡不能斷開的數字：日期、時間、版本號、百分比", () => {
  assert.deepEqual(splitNumbers("2026-11-15 前交給主管"), [{ keep: "2026-11-15" }, " 前交給主管"]);
  assert.deepEqual(splitNumbers("10:30 到 2026/11/15，完成 12.5%"), [
    { keep: "10:30" },
    " 到 ",
    { keep: "2026/11/15" },
    "，完成 ",
    { keep: "12.5%" },
  ]);
  assert.deepEqual(splitNumbers("1.2.3 版"), [{ keep: "1.2.3" }, " 版"]);
  // 單獨的數字本來就不會斷開，不用包。
  assert.deepEqual(splitNumbers("第 3 季的客戶回饋"), ["第 3 季的客戶回饋"]);
  assert.deepEqual(splitNumbers(""), []);
});
