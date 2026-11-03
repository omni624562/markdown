import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanFolder, dailyName, dailyTemplate, dateOfDaily, fillWorkItems, folderSegments, hasWorkItemsVar, neighborNote, withCursor, workItemChecklist } from "./daily-notes.ts";
import { fillTemplate } from "./templates.ts";

test("每日筆記的檔名是本機日期", () => {
  assert.equal(dailyName(new Date(2026, 10, 2, 23, 59)), "2026-11-02.md");
  assert.equal(dailyName(new Date(2027, 0, 5)), "2027-01-05.md");
});

test("認得每日筆記的檔名，不存在的日期不算", () => {
  assert.equal(dateOfDaily("2026-11-02.md"), "2026-11-02");
  assert.equal(dateOfDaily("2026-11-02.MD"), "2026-11-02");
  assert.equal(dateOfDaily("2026-02-29.md"), null, "2026 年不是閏年");
  assert.equal(dateOfDaily("2028-02-29.md"), "2028-02-29");
  assert.equal(dateOfDaily("2026-13-01.md"), null);
  assert.equal(dateOfDaily("週報 2026-11-02.md"), null);
  assert.equal(dateOfDaily("2026-11-02.txt"), null);
});

test("資料夾設定：/ 與 \\ 都可以，空白是最上層，不能跳出開啟的資料夾", () => {
  assert.deepEqual(folderSegments("每日筆記"), ["每日筆記"]);
  assert.deepEqual(folderSegments(" 筆記\\每日 /"), ["筆記", "每日"]);
  assert.deepEqual(folderSegments("./筆記//每日"), ["筆記", "每日"]);
  assert.deepEqual(folderSegments(""), []);
  assert.deepEqual(folderSegments("  /  "), []);
  assert.equal(folderSegments("../別的"), null);
  assert.equal(folderSegments("筆記/../.."), null);
  assert.equal(folderSegments("a:b"), null);
  assert.equal(folderSegments("筆記."), null, "Windows 不能用句點結尾");
  assert.equal(cleanFolder(" 筆記\\每日 "), "筆記/每日");
  assert.equal(cleanFolder("a|b"), null);
});

test("前一天、後一天：跳過沒寫的日子，不是每日筆記的檔案不算", () => {
  const names = ["2026-10-28.md", "2026-10-30.md", "會議.md", "2026-11-02.md", "2026-11-05.md", "2026-02-30.md"];
  assert.equal(neighborNote(names, "2026-11-02", -1), "2026-10-30.md");
  assert.equal(neighborNote(names, "2026-11-02", 1), "2026-11-05.md");
  // 從沒寫筆記的日子（例如今天還沒寫）往前找。
  assert.equal(neighborNote(names, "2026-11-04", -1), "2026-11-02.md");
  assert.equal(neighborNote(names, "2026-10-28", -1), null);
  assert.equal(neighborNote(names, "2026-11-05", 1), null);
  assert.equal(neighborNote([], "2026-11-02", 1), null);
});

test("內建範本填好今天的日期，游標放在第一個待辦後面", () => {
  const body = fillTemplate(dailyTemplate(false), new Date(2026, 10, 2, 9, 0));
  assert.match(body, /^# 2026-11-02（星期一）\n/);
  const { text, line, column } = withCursor(body);
  const lines = text.split("\n");
  assert.equal(lines[line - 1], "- [ ] ", "空的待辦補上空白，直接打字就是待辦事項");
  assert.equal(column, 7);
  // 沒有空的待辦：放在最後。
  assert.deepEqual(withCursor("# 標題\n\n內容\n"), { text: "# 標題\n\n內容\n", line: 4, column: 1 });
  assert.deepEqual(withCursor("# 標題"), { text: "# 標題", line: 1, column: 5 });
});

const wi = (id: number, title: string, priority: number | null, changed: string | null) => ({
  id,
  title,
  priority,
  changed,
  state: "Active",
  kind: "Task",
  project: "產品",
  assignedTo: "王小明",
  webUrl: `https://ado.test/c/產品/_workitems/edit/${id}`,
});

test("連上 Azure DevOps 時內建範本多一段工作項目，放在今天要做之後", () => {
  assert.equal(hasWorkItemsVar(dailyTemplate(false)), false);
  const body = dailyTemplate(true);
  assert.equal(hasWorkItemsVar(body), true);
  assert.match(body, /## 今天要做\n\n- \[ \]\n\n## 工作項目\n\n\{\{工作項目\}\}\n\n## 會議與討論/);
  assert.doesNotMatch(dailyTemplate(false), /工作項目|\{\{work\}\}/);
  // 游標還是在「今天要做」的空待辦。
  const filled = fillWorkItems(body, [wi(1, "寫測試", 2, null)], "");
  const { text, line } = withCursor(filled);
  assert.equal(text.split("\n")[line - 1], "- [ ] ");
});

test("工作項目變成待辦清單：優先順序高的在前，一樣時最近更新的在前", () => {
  const list = workItemChecklist([
    wi(3, "舊的", 2, "2026-10-01T00:00:00Z"),
    wi(4, "新的", 2, "2026-11-01T00:00:00Z"),
    wi(5, "沒有優先順序", null, "2026-11-02T00:00:00Z"),
    wi(6, "最重要 [緊急]", 1, null),
  ]);
  assert.equal(
    list,
    [
      "- [ ] [#6 最重要 \\[緊急\\]](https://ado.test/c/產品/_workitems/edit/6)",
      "- [ ] [#4 新的](https://ado.test/c/產品/_workitems/edit/4)",
      "- [ ] [#3 舊的](https://ado.test/c/產品/_workitems/edit/3)",
      "- [ ] [#5 沒有優先順序](https://ado.test/c/產品/_workitems/edit/5)",
    ].join("\n"),
  );
});

test("範本裡的 {{工作項目}}／{{workitems}}：換成清單；沒有連上時拿掉那一行；沒有工作項目時寫說明", () => {
  const items = [wi(7, "整理文件", 2, null)];
  assert.equal(fillWorkItems("# 今天\n\n  {{ 工作項目 }}\n\n結尾", items, "（沒有）"), "# 今天\n\n- [ ] [#7 整理文件](https://ado.test/c/產品/_workitems/edit/7)\n\n結尾");
  assert.equal(fillWorkItems("{{workitems}}\n", [], "（沒有）"), "（沒有）\n");
  assert.equal(fillWorkItems("a\n{{工作項目}}\nb", null, "（沒有）"), "a\n\nb");
  // 寫在句子中間的不算（只認單獨一行）。
  assert.equal(fillWorkItems("今天的 {{工作項目}} 很多", items, "（沒有）"), "今天的 {{工作項目}} 很多");
  assert.equal(hasWorkItemsVar("今天的 {{工作項目}} 很多"), false);
});
