import assert from "node:assert/strict";
import { test } from "node:test";
import { fileLink } from "./file-link.ts";

test("連結用相對於目前文件的路徑；沒有文件或不同磁碟時用完整路徑", () => {
  assert.equal(fileLink("C:\\Users\\me\\產品\\docs\\報告.pdf", "C:\\Users\\me\\產品\\筆記.md"), "[報告.pdf](docs/報告.pdf)");
  assert.equal(fileLink("C:\\Users\\me\\產品\\報告.pdf", "C:\\Users\\me\\產品\\docs\\規格.md"), "[報告.pdf](../報告.pdf)");
  assert.equal(fileLink("C:\\Users\\me\\產品\\報告.pdf", null), "[報告.pdf](C:/Users/me/產品/報告.pdf)");
  assert.equal(fileLink("D:\\共用\\報告.pdf", "C:\\Users\\me\\產品\\筆記.md"), "[報告.pdf](D:/共用/報告.pdf)");
});

test("路徑有空白或括號時用角括號包起來", () => {
  assert.equal(fileLink("C:\\Users\\me\\產品\\會議 (1).pdf", "C:\\Users\\me\\產品\\筆記.md"), "[會議 (1).pdf](<會議 (1).pdf>)");
});
