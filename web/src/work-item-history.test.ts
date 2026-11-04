import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdoWorkItem, AdoWorkItemRevision } from "./desktop.ts";
import { fieldName, historyMarkdown, workItemUrl } from "./work-item-history.ts";

const item: AdoWorkItem = {
  id: 123,
  title: "登入 [失敗]",
  state: "Active",
  kind: "Bug",
  project: "產品",
  assignedTo: "李大同",
  changed: null,
  priority: 2,
  webUrl: "https://tfs/DC/產品/_workitems/edit/123",
};

const rev = (r: Partial<AdoWorkItemRevision>): AdoWorkItemRevision => ({
  rev: 1,
  author: "王小明",
  date: "2026-10-02T03:00:00Z",
  fields: [],
  comment: null,
  added: [],
  removed: [],
  ...r,
});

test("修改紀錄：每次一段，欄位原本 → 之後，長文字只標有修改，加減關聯與留言", () => {
  const md = historyMarkdown(item, [
    rev({
      rev: 3,
      author: "李大同",
      fields: [
        { field: "System.State", old: "New", new: "Active", long: false },
        { field: "System.AssignedTo", old: null, new: "李大同", long: false },
        { field: "System.Description", old: null, new: null, long: true },
        { field: "Custom.ReleaseNote", old: "a*b", new: null, long: false },
      ],
      added: [{ kind: "parent", id: 42, name: "Parent" }],
      removed: [{ kind: "attachment", id: null, name: "log.txt" }],
      comment: "<p>開始處理</p>",
    }),
  ]);
  assert.match(md, /^# 修改紀錄：Bug 123：登入 \\\[失敗\\\]\n/);
  assert.match(md, /### 李大同・2026-10-02 \d\d:00/);
  assert.match(md, /- \*\*狀態\*\*：New → Active/);
  assert.match(md, /- \*\*指派給\*\*：李大同\n/, "原本沒有值時只寫之後的");
  assert.match(md, /- \*\*說明\*\*：內容有修改/);
  assert.match(md, /- \*\*ReleaseNote\*\*：a\\\*b → （空白）/, "沒列到的欄位用最後一段名稱");
  assert.match(md, /- 加入上層 \[#42\]\(<https:\/\/tfs\/DC\/產品\/_workitems\/edit\/42>\)/);
  assert.match(md, /- 移除附件 log\.txt/);
  assert.match(md, /留言：\n\n> 開始處理/);
});

test("修改紀錄：沒有紀錄、欄位名稱與工作項目網址", () => {
  assert.match(historyMarkdown(item, []), /還沒有修改紀錄/);
  assert.equal(fieldName("Microsoft.VSTS.Scheduling.RemainingWork"), "剩餘工時");
  assert.equal(fieldName("Custom.Foo"), "Foo");
  assert.equal(workItemUrl(item, 9), "https://tfs/DC/產品/_workitems/edit/9");
});
