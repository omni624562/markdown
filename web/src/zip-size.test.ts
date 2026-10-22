import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import { zipUncompressedSize } from "./zip-size.ts";

test("zipUncompressedSize 加總解壓縮後的大小（zip 炸彈檢查）", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", "a".repeat(100_000));
  zip.file("說明.txt", "你好");
  const data = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  assert.ok(data.byteLength < 10_000, "高度壓縮");
  assert.equal(zipUncompressedSize(data), 100_000 + Buffer.byteLength("你好"));
  assert.equal(zipUncompressedSize(new TextEncoder().encode("不是 zip").buffer as ArrayBuffer), null);
});
