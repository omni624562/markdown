import assert from "node:assert/strict";
import { test } from "node:test";
import { attachmentKind, attachmentLink, extLabel, fileSize, pastedName, withFileName } from "./attachments.ts";

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

test("附件網址：留言裡的網址寫法和連線設定不同時也認得，改用連線設定的伺服器", () => {
  const path = "/tfs/DefaultCollection/bf750bd1-0254-4767-be41-74118234df9e/_apis/wit/attachments/0d9c-766480421ea2?fileName=20261015-task-1922925.md";
  const expected = (base: string) => ({ url: `${base}${path.slice("/tfs/DefaultCollection".length)}`, name: "20261015-task-1922925.md" });
  // 只寫電腦名稱 ↔ 完整名稱（兩個方向）、http ↔ https、埠號不同、大小寫不同。
  for (const [href, base] of [
    [`https://almsrv01${path}`, "https://almsrv01.corp.local/tfs/DefaultCollection"],
    [`https://almsrv01.corp.local${path}`, "https://almsrv01/tfs/DefaultCollection"],
    [`https://almsrv01${path}`, "http://almsrv01:8080/tfs/DefaultCollection"],
    [`http://ALMSRV01${path}`, "https://almsrv01/tfs/defaultcollection/"],
  ]) {
    assert.deepEqual(attachmentLink(href, base), expected(base.replace(/\/+$/, "")), href);
  }
  // 連線設定的是伺服器（沒有集合）：多一層集合也認得。
  assert.equal(attachmentLink(`https://almsrv01${path}`, "https://almsrv01/tfs")?.url, `https://almsrv01${path}`);
  // 別台伺服器、別的集合、不是附件：不認。
  assert.equal(attachmentLink(`https://almsrv02${path}`, "https://almsrv01/tfs/DefaultCollection"), null);
  assert.equal(attachmentLink(`https://almsrv01.evil.com${path}`, "https://almsrv01.corp.local/tfs/DefaultCollection"), null);
  assert.equal(attachmentLink(`https://tfs.corp.com.evil.com/tfs/DC/_apis/wit/attachments/x?fileName=a.md`, "https://tfs.corp.com/tfs/DC"), null);
  assert.equal(attachmentLink(`https://almsrv01${path}`, "https://almsrv01/tfs/OtherCollection"), null);
  assert.equal(attachmentLink("ftp://almsrv01/tfs/DefaultCollection/_apis/wit/attachments/x", "https://almsrv01/tfs/DefaultCollection"), null);
});

test("附件大小與副檔名", () => {
  assert.equal(fileSize(512), "512 B");
  assert.equal(fileSize(6 * 1024), "6 KB");
  assert.equal(fileSize(3.4 * 1024 * 1024), "3.4 MB");
  assert.equal(extLabel("報表.xlsx"), "XLSX");
  assert.equal(extLabel("README"), "FILE");
});

test("貼上的圖片：檔名加上時間，附件不會同名", () => {
  const at = new Date(2026, 10, 3, 9, 5, 7);
  assert.equal(pastedName({ name: "image.png", type: "image/png" }, at), "image-20261103-090507.png");
  assert.equal(pastedName({ name: "", type: "image/jpeg" }, at), "image-20261103-090507.jpeg");
  assert.equal(pastedName({ name: "螢幕擷取畫面.png", type: "image/png" }, at), "螢幕擷取畫面-20261103-090507.png");
});
