import assert from "node:assert/strict";
import { test } from "node:test";
import { projectLabel, recentLabel } from "./start-page.ts";

test("最近開啟：名稱加上所在位置的最後兩層", () => {
  assert.deepEqual(recentLabel("C:\\Users\\nan\\Documents\\omarker\\Comet\\docs\\COMET.md"), { name: "COMET.md", where: "Comet › docs" });
  assert.deepEqual(recentLabel("C:\\Users\\nan\\Documents\\omarker\\Comet"), { name: "Comet", where: "Documents › omarker" });
  assert.deepEqual(recentLabel("/home/me/notes/a.md"), { name: "a.md", where: "me › notes" });
  assert.deepEqual(recentLabel("C:\\a.md"), { name: "a.md", where: "C:" });
  assert.deepEqual(recentLabel("\\\\server\\share\\報告.md"), { name: "報告.md", where: "server › share" });
  assert.deepEqual(recentLabel("C:\\Users\\nan\\Desktop\\"), { name: "Desktop", where: "Users › nan" });
});

test("起始頁的專案：自訂名稱時，位置改成資料夾本身與上一層", () => {
  assert.deepEqual(projectLabel("C:\\Users\\nan\\Documents\\omarker\\Comet", "Comet"), { name: "Comet", where: "Documents › omarker" });
  assert.deepEqual(projectLabel("C:\\Users\\nan\\Documents\\omarker\\Comet", "公司文件"), { name: "公司文件", where: "omarker › Comet" });
  assert.deepEqual(projectLabel("/notes", "筆記"), { name: "筆記", where: "notes" });
});
