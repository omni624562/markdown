import assert from "node:assert/strict";
import { test } from "node:test";
import { attachmentSummary, lastSegment, parseCommentHeading, parseFieldTime, sectionKind, splitWorkItemTitle } from "./work-item-look.ts";

test("工作項目段落：依標題認出是哪一種（有數字的標題任何數字都算）", () => {
  assert.equal(sectionKind("工作項目說明"), "desc");
  assert.equal(sectionKind("重現步驟"), "details");
  assert.equal(sectionKind("驗收條件"), "details");
  assert.equal(sectionKind("系統資訊"), "sysinfo");
  assert.equal(sectionKind("相關工作項目（12）"), "relations");
  assert.equal(sectionKind("留言（3）"), "comments");
  assert.equal(sectionKind("附件（4）"), "attachments");
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

test("標題拆成類型、編號、標題", () => {
  assert.deepEqual(splitWorkItemTitle("User Story 1922924：SP101【COMET】BRS 共同審閱"), { kind: "User Story", id: "1922924", title: "SP101【COMET】BRS 共同審閱" });
  assert.deepEqual(splitWorkItemTitle("Bug 12: Login fails"), { kind: "Bug", id: "12", title: "Login fails" });
  assert.equal(splitWorkItemTitle("沒有編號的標題"), null);
});

test("欄位的時間、路徑最後一段、附件摘要", () => {
  assert.equal(parseFieldTime("2026-10-29 03:00"), new Date(2026, 9, 29, 3, 0).getTime());
  assert.equal(parseFieldTime("昨天"), null);
  assert.equal(lastSegment("Mgt-Digital_Cloud_Platform\\DGT Sprint\\Sprint 101"), "Sprint 101");
  assert.equal(lastSegment("P"), "P");
  assert.equal(attachmentSummary(["a.md", "a.md", "b.png", "a.md"]), "a.md ×3, b.png");
});
