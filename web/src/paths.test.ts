import assert from "node:assert/strict";
import { test } from "node:test";
import { basename, dirname, isInside, localImagePath, markdownUrl, rebase, relativePath, resolvePath } from "./paths.ts";

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

test("localImagePath 不讓文件連到其他網路共用資料夾（會送出 Windows 登入資訊）", () => {
  assert.equal(localImagePath("%5C%5Cattacker.example@SSL%5Cs%5Ca.png", "C:\\筆記"), null);
  assert.equal(localImagePath("\\\\203.0.113.5\\s\\a.png", "C:\\筆記"), null);
  assert.equal(localImagePath("\\\\nas\\其他\\a.png", "\\\\nas\\共用\\筆記"), null);
  assert.equal(localImagePath("\\\\NAS\\共用\\圖\\a.png", "\\\\nas\\共用\\筆記"), "\\\\NAS\\共用\\圖\\a.png");
  assert.equal(localImagePath("a.png", "\\\\nas\\共用\\筆記"), "\\\\nas\\共用\\筆記\\a.png");
  assert.equal(localImagePath("../../../evil/s/a.png", "\\\\nas\\共用\\筆記"), null);
});

test("markdownUrl 在需要時加上角括號", () => {
  assert.equal(markdownUrl("assets/週報-20261020.png"), "assets/週報-20261020.png");
  assert.equal(markdownUrl("assets/my note (1).png"), "<assets/my note (1).png>");
});

test("relativePath 產生 Markdown 連結用的相對路徑", () => {
  assert.equal(relativePath("/ws/筆記", "/ws/筆記/週報.md"), "週報.md");
  assert.equal(relativePath("/ws/筆記", "/ws/待辦.md"), "../待辦.md");
  assert.equal(relativePath("/ws", "/ws/筆記/深入/a.md"), "筆記/深入/a.md");
  assert.equal(relativePath("C:\\Notes\\週報", "c:\\notes\\會議\\a.md"), "../會議/a.md");
  assert.equal(relativePath("C:\\Notes", "D:\\a.md"), null);
  assert.equal(relativePath("webdav://abc/筆記", "webdav://abc/日記/今天.md"), "../日記/今天.md");
});
