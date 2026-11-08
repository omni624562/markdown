import assert from "node:assert/strict";
import { test } from "node:test";
import { imageMarkdown } from "./image-markdown.ts";

test("圖片語法用相對於目前文件的路徑；沒有文件時用完整路徑", () => {
  assert.equal(imageMarkdown("C:\\Users\\me\\產品\\assets\\王小明.png", "C:\\Users\\me\\產品\\筆記.md"), "![王小明](assets/王小明.png)");
  assert.equal(imageMarkdown("C:\\Users\\me\\產品\\assets\\圖.png", "C:\\Users\\me\\產品\\docs\\規格.md"), "![圖](../assets/圖.png)");
  assert.equal(imageMarkdown("C:\\Users\\me\\產品\\assets\\圖.png", null), "![圖](C:/Users/me/產品/assets/圖.png)");
  // 不同磁碟算不出相對路徑：用完整路徑。
  assert.equal(imageMarkdown("D:\\圖庫\\a.png", "C:\\Users\\me\\產品\\筆記.md"), "![a](D:/圖庫/a.png)");
});

test("路徑有空白或括號時用角括號包起來", () => {
  assert.equal(imageMarkdown("C:\\Users\\me\\產品\\截圖 (1).png", "C:\\Users\\me\\產品\\筆記.md"), "![截圖 (1)](<截圖 (1).png>)");
});
