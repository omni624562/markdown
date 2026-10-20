import assert from "node:assert/strict";
import { test } from "node:test";
import { basename, dirname, isInside, localImagePath, markdownUrl, rebase, resolvePath } from "./paths.ts";

test("dirname 與 basename 接受兩種分隔符號", () => {
  assert.equal(dirname("C:\\筆記\\週報.md"), "C:\\筆記");
  assert.equal(dirname("C:\\週報.md"), "C:\\");
  assert.equal(dirname("/home/u/a.md"), "/home/u");
  assert.equal(dirname("/a.md"), "/");
  assert.equal(dirname("a.md"), "");
  assert.equal(basename("\\\\nas\\共用\\筆記.md"), "筆記.md");
  assert.equal(basename("/home/u/a.md"), "a.md");
});

test("isInside 不會把名稱相同開頭的資料夾當成子資料夾", () => {
  assert.ok(isInside("C:\\筆記\\a.md", "C:\\筆記"));
  assert.ok(isInside("C:\\筆記", "C:\\筆記"));
  assert.ok(!isInside("C:\\筆記二\\a.md", "C:\\筆記"));
  assert.ok(isInside("/home/u/x/y.md", "/home/u"));
});

test("rebase 換掉改名資料夾的前綴", () => {
  assert.equal(rebase("C:\\筆記\\舊\\a.md", "C:\\筆記\\舊", "C:\\筆記\\新"), "C:\\筆記\\新\\a.md");
  assert.equal(rebase("C:\\筆記\\舊.md", "C:\\筆記\\舊", "C:\\筆記\\新"), null);
});

test("resolvePath 處理 ./ 與 ../", () => {
  assert.equal(resolvePath("C:\\筆記\\週報", "assets/圖.png"), "C:\\筆記\\週報\\assets\\圖.png");
  assert.equal(resolvePath("C:\\筆記\\週報", "../img/./a.png"), "C:\\筆記\\img\\a.png");
  assert.equal(resolvePath("C:\\", "../../a.png"), "C:\\a.png");
  assert.equal(resolvePath("/home/u", "../../../a.png"), "/a.png");
  assert.equal(resolvePath("\\\\nas\\共用", "a.png"), "\\\\nas\\共用\\a.png");
});

test("localImagePath 只處理本機相對路徑", () => {
  assert.equal(localImagePath("assets/a%20b.png", "C:\\筆記"), "C:\\筆記\\assets\\a b.png");
  assert.equal(localImagePath("./a.png?v=2", "/home/u"), "/home/u/a.png");
  assert.equal(localImagePath("C:/圖/a.png", "/home/u"), "C:/圖/a.png");
  assert.equal(localImagePath("https://example.com/a.png", "C:\\筆記"), null);
  assert.equal(localImagePath("data:image/png;base64,AAAA", "C:\\筆記"), null);
  assert.equal(localImagePath("//cdn.example.com/a.png", "C:\\筆記"), null);
  assert.equal(localImagePath("/a.png", "C:\\筆記"), null);
});

test("markdownUrl 在需要時加上角括號", () => {
  assert.equal(markdownUrl("assets/週報-20261020.png"), "assets/週報-20261020.png");
  assert.equal(markdownUrl("assets/my note (1).png"), "<assets/my note (1).png>");
});
