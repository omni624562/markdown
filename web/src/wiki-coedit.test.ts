import assert from "node:assert/strict";
import { test } from "node:test";
import { myChanges, recentEditor } from "./wiki-coedit.ts";

test("recentEditor 只提醒別人在 15 分鐘內的修改", () => {
  const now = Date.parse("2026-10-28T10:00:00Z");
  const info = { author: "王小明", date: "2026-10-28T09:55:00Z" };
  assert.deepEqual(recentEditor(info, "陳大文", now), { author: "王小明", at: Date.parse(info.date) });
  assert.equal(recentEditor(info, " 王小明 ", now), null);
  assert.equal(recentEditor({ ...info, date: "2026-10-28T09:30:00Z" }, null, now), null);
  assert.equal(recentEditor({ author: null, date: info.date }, null, now), null);
  assert.equal(recentEditor({ author: "王小明", date: "not a date" }, null, now), null);
});

test("myChanges 以整行列出修改、新增與刪除（不含段落間的空行）", () => {
  const base = ["# 標題", "", "第一段", "", "第二段", "", "第三段"].join("\n");
  const mine = ["# 標題", "", "第一段（改過）", "", "第二段", "", "新增的一段", "", "第三段"].join("\n");
  assert.deepEqual(myChanges(base, mine), [
    { before: "第一段", after: "第一段（改過）" },
    { before: "", after: "新增的一段" },
  ]);
  assert.deepEqual(myChanges(base, ["# 標題", "", "第一段", "", "第三段"].join("\n")), [{ before: "第二段", after: "" }]);
  assert.deepEqual(myChanges("a\nb", "x\na\nb\nc"), [
    { before: "", after: "x" },
    { before: "", after: "c" },
  ]);
  assert.deepEqual(myChanges(base, base), []);
  assert.deepEqual(myChanges("a\n\nb", "a\n\n\nb"), []);
});
