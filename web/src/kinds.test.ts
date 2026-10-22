import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TEXT_EXTENSIONS, isTextFileName, notTextReason } from "./kinds.ts";

test("網頁版與桌面版認得的副檔名一致", () => {
  const rust = readFileSync(new URL("../../desktop/src/workspace.rs", import.meta.url), "utf8");
  const block = rust.match(/pub const DOC_EXTENSIONS: &\[&str\] = &\[([\s\S]*?)\];/)?.[1] ?? "";
  const fromRust = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(fromRust.length > 50);
  assert.deepEqual([...TEXT_EXTENSIONS].sort(), fromRust.sort());
});

test("依副檔名判斷是不是可以開啟的文字檔", () => {
  for (const name of ["筆記.md", "設定.YAML", "資料.csv", "index.html", "main.py", "app.tsx"]) {
    assert.ok(isTextFileName(name), name);
  }
  for (const name of ["圖片.png", "壓縮檔.zip", "報告.docx", "沒有副檔名", ".md"]) {
    assert.ok(!isTextFileName(name), name);
  }
});

test("內容有 NUL 或是 PDF 時不當成文字", () => {
  assert.equal(notTextReason("# 標題\n內容"), null);
  assert.equal(notTextReason(""), null);
  assert.ok(notTextReason("\x89PNG\r\n\x1a\n\0\0\0\rIHDR"));
  assert.ok(notTextReason("%PDF-1.7\n"));
  assert.ok(notTextReason("a\0b\0")?.includes("UTF-16"));
});
