import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommentHeading, sectionKind } from "./work-item-look.ts";

test("工作項目段落：依標題認出是哪一種（有數字的標題任何數字都算）", () => {
  assert.equal(sectionKind("工作項目說明"), "desc");
  assert.equal(sectionKind("重現步驟"), "details");
  assert.equal(sectionKind("驗收條件"), "details");
  assert.equal(sectionKind("系統資訊"), "sysinfo");
  assert.equal(sectionKind("相關工作項目（12）"), "relations");
  assert.equal(sectionKind("留言（3）"), "comments");
  assert.equal(sectionKind("留言（3）多的字"), "other");
  assert.equal(sectionKind("自訂段落"), "other");
});

test("留言標題：名字與時間（名字裡有「・」也沒關係）", () => {
  const { name, at } = parseCommentHeading("黃昭翔・2026-10-05 14:38");
  assert.equal(name, "黃昭翔");
  assert.equal(at, new Date(2026, 9, 5, 14, 38).getTime());
  assert.equal(parseCommentHeading("王・小明・2026-01-02 03:04").name, "王・小明");
  assert.deepEqual(parseCommentHeading("（不明）"), { name: "（不明）", at: null });
});
