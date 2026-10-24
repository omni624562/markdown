import assert from "node:assert/strict";
import { test } from "node:test";
import { plainTaskText, setTaskDone } from "./doc-index.ts";
import { parseDoc as parse } from "./test-wasm.ts";

// 解析在 Rust（crates/md-text，那裡有完整的測試）；這裡確認 WebAssembly 版給前端的結果。
const parseDoc = (text: string) => parse(text, 2026);

test("找出待辦、負責人與截止日", () => {
  const doc = parseDoc(
    [
      "# 週報 #週報",
      "",
      "- [ ] 寫完提案 @小明 10/25",
      "- [x] 開會（@王大同、@Amy）2026-10-20",
      "  1. [ ] 子項目 `- [ ] 不算` 11月3日",
      "* [X] 星號也可以",
      "```",
      "- [ ] 程式碼裡不算 #不算",
      "```",
      "<!-- - [ ] 註解裡不算",
      "#也不算 -->",
      "寄信給 me@example.com 不是負責人",
    ].join("\n"),
  );
  assert.deepEqual(
    doc.tasks.map((t) => [t.line, t.done, t.owners, t.due]),
    [
      [3, false, ["小明"], "2026-10-25"],
      [4, true, ["王大同", "Amy"], "2026-10-20"],
      [5, false, [], "2026-11-03"],
      [6, true, [], null],
    ],
  );
  assert.equal(doc.tasks[2].text, "子項目 `- [ ] 不算` 11月3日");
  assert.deepEqual(doc.tags, ["週報"]);
});

test("標籤：中文、分層，數字與網址片段不算", () => {
  const { tags } = parseDoc("討論 #專案A、#KR2 與 #專案/前端。\n#1 不算，[連結](https://a.com/#frag) 也不算，`#程式碼` 不算\n## 標題不是標籤");
  assert.deepEqual(tags, ["專案A", "KR2", "專案/前端"]);
});

test("連結：[[文件]] 與相對路徑的 Markdown 連結", () => {
  const { links } = parseDoc(
    "見 [[會議記錄]]、[[週報#進度|本週]]，以及 [說明](筆記/%E6%9C%83%E8%AD%B0.md#標題)、[外部](https://example.com)、[本文](#標題)、![圖](assets/a.png)",
  );
  assert.deepEqual(
    links.map((l) => [l.kind, l.target]),
    [
      ["wiki", "會議記錄"],
      ["wiki", "週報"],
      ["markdown", "筆記/會議.md"],
      ["markdown", "assets/a.png"],
    ],
  );
});

test("勾選待辦", () => {
  const text = "- [ ] 一\n  - [x] 二\n普通文字";
  assert.equal(setTaskDone(text, 1, true), "- [x] 一\n  - [x] 二\n普通文字");
  assert.equal(setTaskDone(text, 2, false), "- [ ] 一\n  - [ ] 二\n普通文字");
  assert.equal(setTaskDone(text, 3, true), null);
});

test("待辦顯示的純文字", () => {
  assert.equal(plainTaskText("**完成** [提案](a.md) 與 [[週報|本週週報]]、`code`、<mark>重點</mark>"), "完成 提案 與 本週週報、code、重點");
});
