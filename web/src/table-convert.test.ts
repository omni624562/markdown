import assert from "node:assert/strict";
import { test } from "node:test";
import { delimitedRows, jsonTable, pastedTable, rowsToTable, splitCsvLine, textToTable } from "./table-convert.ts";

test("從試算表複製的 Tab 分隔文字轉成表格（第一行是標題）", () => {
  assert.equal(
    pastedTable("項目\t負責人\t工時\r\n登入頁\t王小明\t3\r\n報表\t李大同\t\r\n"),
    "| 項目 | 負責人 | 工時 |\n| --- | --- | --- |\n| 登入頁 | 王小明 | 3 |\n| 報表 | 李大同 |  |",
  );
});

test("不像表格的文字不轉：沒有 Tab、只有一行、欄數不一樣、每行都是 Tab 縮排", () => {
  assert.equal(pastedTable("王小明 李大同\n報表"), null);
  assert.equal(pastedTable("項目\t負責人"), null);
  assert.equal(pastedTable("項目\t負責人\n登入頁"), null);
  assert.equal(pastedTable("\tif (x) {\n\t\treturn;\n\t}"), null);
  assert.equal(pastedTable("\tfoo()\n\tbar()"), null);
});

test("儲存格裡的 | 跳脫", () => {
  assert.equal(rowsToTable([["a|b", "c"], ["1", "2"]]), "| a\\|b | c |\n| --- | --- |\n| 1 | 2 |");
});

test("CSV：雙引號裡的逗號與 \"\"", () => {
  assert.deepEqual(splitCsvLine('王小明,"台北, 信義區","說""你好"""'), ["王小明", "台北, 信義區", '說"你好"']);
  assert.deepEqual(delimitedRows("名字,地點\n王小明,\"台北, 信義區\"", ","), [["名字", "地點"], ["王小明", "台北, 信義區"]]);
});

test("選取的文字轉成表格：有 Tab 用 Tab，否則用逗號", () => {
  assert.equal(textToTable("名字,工時\n王小明,3"), "| 名字 | 工時 |\n| --- | --- |\n| 王小明 | 3 |");
  assert.equal(textToTable("名字\t備註\n王小明\t週一, 週三"), "| 名字 | 備註 |\n| --- | --- |\n| 王小明 | 週一, 週三 |");
  assert.equal(textToTable("只有一行,沒有第二行"), null);
});

test("JSON 物件陣列轉成表格：欄位照第一次出現的順序，缺的留空，巢狀的寫成 JSON", () => {
  const json = JSON.stringify([
    { 編號: 1201, 標題: "登入頁面跑版", 指派: "王小明" },
    { 編號: 1198, 標題: "匯出 PDF\n加頁碼", 標籤: ["前端", "PDF"], 指派: null },
  ]);
  assert.equal(
    jsonTable(json),
    [
      "| 編號 | 標題 | 指派 | 標籤 |",
      "| --- | --- | --- | --- |",
      "| 1201 | 登入頁面跑版 | 王小明 |  |",
      '| 1198 | 匯出 PDF 加頁碼 |  | ["前端","PDF"] |',
    ].join("\n"),
  );
  // 儲存格裡的 | 要跳脫。
  assert.equal(jsonTable('[{"a":"x|y"}]'), "| a |\n| --- |\n| x\\|y |");
  // 不是物件陣列、空的、壞掉的：不轉。
  for (const no of ["[]", "[1,2]", "[[1,2]]", '{"a":1}', "[{}]", "[{\"a\":1}", "一般文字", '[{"a":1}, 2]']) assert.equal(jsonTable(no), null, no);
});
