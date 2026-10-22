import assert from "node:assert/strict";
import { test } from "node:test";
import { notesForVersion, parseReleaseNotes } from "./release-notes.ts";

test("parseReleaseNotes 依分類列出項目", () => {
  const notes = parseReleaseNotes(
    "這一版是全面的安全檢查。\n\n### 新功能\n\n- 設定「封鎖遠端圖片」\n- `Ctrl+Shift+T` 重新開啟\n\n### 修正\n\n- **流程圖**連結\n  接續的說明\n",
  );
  assert.deepEqual(notes.intro, ["這一版是全面的安全檢查。"]);
  assert.deepEqual(notes.sections, [
    { title: "新功能", items: ["設定「封鎖遠端圖片」", "Ctrl+Shift+T 重新開啟"] },
    { title: "修正", items: ["流程圖連結接續的說明"] },
  ]);
  assert.deepEqual(parseReleaseNotes("- 只有項目").sections, [{ title: "", items: ["只有項目"] }]);
  assert.deepEqual(parseReleaseNotes(""), { intro: [], sections: [] });
});

test("notesForVersion 取出 CHANGELOG 中某一版的說明", () => {
  const log = "# 更新紀錄\n\n## 1.2.0 — 2026-10-23\n\n### 新功能\n\n- 甲\n\n## 1.1.0 — 2026-10-22\n\n- 乙\n";
  assert.equal(notesForVersion(log, "1.2.0"), "### 新功能\n\n- 甲");
  assert.equal(notesForVersion(log, "1.1.0"), "- 乙");
  assert.equal(notesForVersion(log, "1.1"), "");
  assert.equal(notesForVersion(log, "9.9.9"), "");
});
