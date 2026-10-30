import assert from "node:assert/strict";
import { test } from "node:test";
import { attachmentKind, attachmentLink, extLabel, fileSize, withFileName } from "./attachments.ts";

test("附件的類型：文字檔在 oMarker 看、圖片放大檢視、會自己執行的不直接開", () => {
  assert.equal(attachmentKind("20261005-task-1911359.md"), "text");
  assert.equal(attachmentKind("deploy.ps1"), "text");
  assert.equal(attachmentKind("截圖.PNG"), "image");
  assert.equal(attachmentKind("setup.exe"), "runnable");
  assert.equal(attachmentKind("install.msi"), "runnable");
  assert.equal(attachmentKind("報表.xlsx"), "other");
  assert.equal(attachmentKind("規格.pdf"), "other");
});

test("附件網址：只認連線中那台伺服器，檔名用 fileName", () => {
  const base = "https://tfs/DC";
  const url = withFileName("https://tfs/DC/_apis/wit/attachments/abc-123", "測試 報告.md");
  assert.match(url, /fileName=/);
  assert.deepEqual(attachmentLink(url, base), { url, name: "測試 報告.md" });
  assert.deepEqual(attachmentLink("https://tfs/DC/P/_apis/wit/attachments/x1", base), { url: "https://tfs/DC/P/_apis/wit/attachments/x1", name: "x1" });
  assert.equal(attachmentLink("https://evil/DC/_apis/wit/attachments/x1?fileName=a.md", base), null);
  assert.equal(attachmentLink("https://tfs/DC/P/_workitems/edit/1", base), null);
});

test("附件大小與副檔名", () => {
  assert.equal(fileSize(512), "512 B");
  assert.equal(fileSize(6 * 1024), "6 KB");
  assert.equal(fileSize(3.4 * 1024 * 1024), "3.4 MB");
  assert.equal(extLabel("報表.xlsx"), "XLSX");
  assert.equal(extLabel("README"), "FILE");
});
