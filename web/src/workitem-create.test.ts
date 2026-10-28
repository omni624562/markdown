import assert from "node:assert/strict";
import { test } from "node:test";
import { draftFromSelection } from "./workitem-create.ts";

test("draftFromSelection 用第一行當標題，其餘當內容", () => {
  assert.deepEqual(draftFromSelection("- [ ] 修正登入失敗\n  - 帳號有空白時\n  - 密碼過期時"), {
    title: "修正登入失敗",
    description: "  - 帳號有空白時\n  - 密碼過期時",
  });
  assert.deepEqual(draftFromSelection("\n## 匯出 PDF 跑版\n\n表格太寬\n"), { title: "匯出 PDF 跑版", description: "表格太寬" });
  assert.deepEqual(draftFromSelection("1. 單行"), { title: "單行", description: "" });
  assert.deepEqual(draftFromSelection("   "), { title: "", description: "" });
});
