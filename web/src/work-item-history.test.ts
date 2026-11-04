import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdoFieldChange, AdoWorkItem, AdoWorkItemRevision } from "./desktop.ts";
import { useLang } from "./i18n.ts";
import { dayLabel, fieldName, historyMarkdown, mergeRevisions, numberText, workItemUrl } from "./work-item-history.ts";

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

/** 本地時間（測試結果不隨時區改變）。 */
const at = (local: string) => new Date(local).toISOString();

const rev = (r: Partial<AdoWorkItemRevision>): AdoWorkItemRevision => ({
  rev: 1,
  author: "王小明",
  date: at("2026-10-02T11:00"),
  fields: [],
  comment: null,
  added: [],
  removed: [],
  ...r,
});

const f = (field: string, old: string | null, value: string | null, long = false): AdoFieldChange => ({ field, old, new: value, long });

test("修改紀錄：標題、共幾次修改、依日期分段，每項是「誰・幾點」，下面列出欄位、關聯與留言", () => {
  const md = historyMarkdown(item, [
    rev({
      rev: 3,
      author: "李大同",
      date: at("2026-10-02T14:59"),
      fields: [
        f("System.State", "New", "Active"),
        f("System.AssignedTo", null, "李大同"),
        f("System.Description", null, null, true),
        f("Custom.ReleaseNote", "a*b", null),
      ],
      added: [{ kind: "parent", id: 42, name: "Parent" }],
      removed: [{ kind: "attachment", id: null, name: "log.txt" }],
      comment: "<p>開始處理</p><p>第二段</p>",
    }),
  ]);
  assert.match(md, /^# 修改紀錄：Bug 123：登入 \\\[失敗\\\]\n\n共 1 次修改\n\n## 2026年10月2日 週五\n\n- \*\*李大同\*\*・14:59\n/);
  assert.match(md, /\n {2}- \*\*狀態\*\*：New → Active\n/);
  assert.match(md, /\n {2}- \*\*指派給\*\*：李大同\n/, "原本沒有值時只寫之後的");
  assert.match(md, /\n {2}- \*\*工作項目說明\*\*：內容有修改\n/);
  assert.match(md, /\n {2}- \*\*ReleaseNote\*\*：a\\\*b → （空白）\n/, "沒列到的欄位用最後一段名稱");
  assert.match(md, /\n {2}- 加入上層 \[#42\]\(<https:\/\/tfs\/DC\/產品\/_workitems\/edit\/42>\)\n/);
  assert.match(md, /\n {2}- 移除附件 log\.txt\n/);
  // 留言是這一項底下的引言（不要空行，清單才不會變成鬆散清單）。
  assert.match(md, /\n {2}> 留言：開始處理\n {2}>\n {2}> 第二段\n$/);
});

test("修改紀錄：同一個人 10 分鐘內連續的修改合成一項（欄位的原本取最早、之後取最新，關聯與留言都留著）", () => {
  const md = historyMarkdown(item, [
    rev({
      rev: 4,
      date: at("2026-10-02T11:09"),
      fields: [f("System.State", "Active", "Resolved"), f("Microsoft.VSTS.Common.Priority", "1", "2")],
      comment: "<p>第二則</p>",
      added: [{ kind: "related", id: 7, name: "Related" }],
    }),
    rev({
      rev: 3,
      date: at("2026-10-02T11:03"),
      fields: [f("System.State", "New", "Active"), f("Microsoft.VSTS.Common.Priority", "2", "1")],
      comment: "<p>第一則</p>",
      added: [{ kind: "related", id: 7, name: "Related" }, { kind: "parent", id: 9, name: "Parent" }],
    }),
  ]);
  assert.match(md, /共 1 次修改/);
  assert.equal(md.match(/^- /gm)?.length, 1, "合成一項");
  assert.match(md, /- \*\*王小明\*\*・11:09\n/, "時間是最新那次");
  assert.match(md, /\*\*狀態\*\*：New → Resolved/);
  assert.doesNotMatch(md, /優先順序/, "改回原本的值就不列");
  assert.equal(md.match(/加入相關 \[#7\]/g)?.length, 1, "同一個關聯只列一次");
  assert.match(md, /加入上層 \[#9\]/);
  assert.match(md, /> 留言：第一則\n {2}>\n {2}> 留言：第二則/, "留言舊到新都留著");

  // 間隔 10 分鐘以上、或不同人：不合併。
  const apart = mergeRevisions([
    rev({ date: at("2026-10-02T11:10"), fields: [f("System.Title", "b", "c")] }),
    rev({ date: at("2026-10-02T11:00"), fields: [f("System.Title", "a", "b")] }),
  ]);
  assert.equal(apart.length, 2);
  const others = mergeRevisions([
    rev({ author: "李大同", date: at("2026-10-02T11:01"), fields: [f("System.Title", "b", "c")] }),
    rev({ author: "王小明", date: at("2026-10-02T11:00"), fields: [f("System.Title", "a", "b")] }),
  ]);
  assert.equal(others.length, 2);
  // 連續的才合併：中間隔了別人的修改就分開。
  const between = mergeRevisions([
    rev({ date: at("2026-10-02T11:04") }),
    rev({ author: "李大同", date: at("2026-10-02T11:02") }),
    rev({ date: at("2026-10-02T11:00") }),
  ]);
  assert.deepEqual(
    between.map((e) => e.author),
    ["王小明", "李大同", "王小明"],
  );
});

test("修改紀錄：看板的重複欄位、ExtensionMarker、啟用／解決／關閉的人與時間不列；只剩這些的修改整項略過", () => {
  const md = historyMarkdown(item, [
    rev({
      rev: 3,
      date: at("2026-10-02T12:00"),
      fields: [
        f("System.State", "New", "Active"),
        f("System.BoardColumn", "New", "Active"),
        f("WEF_6A5B_Kanban.Column", "New", "Active"),
        f("WEF_6A5B_Kanban.Column.Done", null, "false"),
        f("WEF_6A5B_Kanban.Lane", null, "Expedite"),
        f("System.ExtensionMarker", null, "true"),
        f("Microsoft.VSTS.Common.ActivatedBy", null, "王小明"),
        f("Microsoft.VSTS.Common.ActivatedDate", null, "2026-10-02T04:00:00Z"),
        f("Microsoft.VSTS.Common.ResolvedBy", "王小明", null),
        f("Microsoft.VSTS.Common.ResolvedDate", "2026-10-01T04:00:00Z", null),
        f("Microsoft.VSTS.Common.ClosedBy", "王小明", null),
        f("Microsoft.VSTS.Common.ClosedDate", "2026-10-01T04:00:00Z", null),
      ],
    }),
    rev({ rev: 2, author: "李大同", date: at("2026-10-01T12:00"), fields: [f("System.ExtensionMarker", null, "true")] }),
  ]);
  assert.match(md, /\*\*狀態\*\*：New → Active/);
  assert.match(md, /\*\*看板欄\*\*：New → Active/);
  for (const noise of ["Column", "Done", "Lane", "ExtensionMarker", "Activated", "Resolved", "Closed", "Expedite", "false"]) {
    assert.doesNotMatch(md, new RegExp(noise), noise);
  }
  assert.doesNotMatch(md, /李大同/, "只改了不列的欄位：整項略過");
  assert.match(md, /共 1 次修改\n/, "略過的不算只調整 Backlog 順序");
});

test("修改紀錄：Backlog 順序不寫數字；只調整順序的不列出，最上面註明次數", () => {
  const md = historyMarkdown(item, [
    rev({ rev: 5, author: "李大同", date: at("2026-10-03T09:00"), fields: [f("Microsoft.VSTS.Common.StackRank", "1000000002.0", "799907902.0")] }),
    rev({
      rev: 4,
      date: at("2026-10-02T11:00"),
      fields: [f("Microsoft.VSTS.Common.BacklogPriority", "5.0", "3.0"), f("System.ExtensionMarker", null, "true")],
    }),
    rev({
      rev: 3,
      author: "陳小華",
      date: at("2026-10-01T11:00"),
      fields: [f("System.BoardColumn", null, "New"), f("Microsoft.VSTS.Common.StackRank", null, "1000000002.0")],
    }),
  ]);
  assert.doesNotMatch(md, /1000000002|799907902|StackRank|BacklogPriority/);
  assert.match(md, /^共 1 次修改（另有 2 次只調整 Backlog 順序，沒有列出）$/m);
  assert.doesNotMatch(md, /李大同|王小明/, "只調整順序的那幾次不列出");
  assert.match(md, /- \*\*陳小華\*\*・11:00\n {2}- \*\*看板欄\*\*：New\n {2}- 調整 Backlog 順序\n/, "有其他修改時寫一項「調整 Backlog 順序」");

  // 只有留言和順序：留下來，也寫「調整 Backlog 順序」。
  const withComment = historyMarkdown(item, [rev({ fields: [f("Microsoft.VSTS.Common.StackRank", "2", "1")], comment: "<p>往前排</p>" })]);
  assert.match(withComment, /共 1 次修改\n/);
  assert.match(withComment, / {2}- 調整 Backlog 順序\n {2}> 留言：往前排/);

  // 全部都只調整順序：沒有可以列的。
  const only = historyMarkdown(item, [rev({ fields: [f("Microsoft.VSTS.Common.StackRank", "2", "1")] })]);
  assert.match(only, /還沒有修改紀錄。（另有 1 次只調整 Backlog 順序，沒有列出）\n$/);
});

test("修改紀錄：狀態和原因一起改時寫成一項；只改原因照一般欄位", () => {
  const md = historyMarkdown(item, [
    rev({ rev: 4, date: at("2026-10-03T09:00"), fields: [f("System.Reason", "Work finished", "Fixed")] }),
    rev({
      rev: 3,
      date: at("2026-10-02T11:00"),
      fields: [f("System.State", "New", "Active"), f("System.Reason", "New", "Implementation started"), f("System.AssignedTo", null, "王小明")],
    }),
    rev({ rev: 1, date: at("2026-10-01T11:00"), fields: [f("System.Title", null, "登入"), f("System.State", null, "New"), f("System.Reason", null, "New")] }),
  ]);
  assert.match(md, / {2}- \*\*狀態\*\*：New → Active（Implementation started）\n {2}- \*\*指派給\*\*：王小明\n/);
  assert.equal(md.match(/\*\*原因\*\*/g)?.length, 1, "和狀態一起改時不另外列原因");
  assert.match(md, / {2}- \*\*原因\*\*：Work finished → Fixed\n/);
  assert.match(md, / {2}- \*\*狀態\*\*：New\n/, "原因和新的狀態同名時不寫括號");
});

test("修改紀錄：數字去掉小數點後面多餘的 0（文字欄位照原樣）", () => {
  assert.equal(numberText("4.0"), "4");
  assert.equal(numberText("2.50"), "2.5");
  assert.equal(numberText("-1.000"), "-1");
  assert.equal(numberText("10.05"), "10.05");
  assert.equal(numberText("100"), "100");
  assert.equal(numberText("v1.0"), "v1.0");
  const md = historyMarkdown(item, [
    rev({
      fields: [
        f("System.Title", "1.0", "2.0"),
        f("Microsoft.VSTS.Scheduling.RemainingWork", "4.0", "2.50"),
        f("Microsoft.VSTS.Scheduling.CompletedWork", "4.0", "4"),
      ],
    }),
  ]);
  assert.match(md, /\*\*剩餘工時\*\*：4 → 2\.5\n/);
  assert.match(md, /\*\*工作項目標題\*\*：1\.0 → 2\.0\n/, "標題看起來像數字也照原樣");
  assert.doesNotMatch(md, /已完成工時/, "4.0 和 4 是同一個值");
});

test("修改紀錄：依本地日期分段，最新的在前面", () => {
  const md = historyMarkdown(item, [
    rev({ rev: 4, author: "李大同", date: at("2026-09-23T14:59"), fields: [f("System.Title", "b", "c")] }),
    rev({ rev: 3, date: at("2026-09-23T09:00"), fields: [f("System.Title", "a", "b")] }),
    rev({ rev: 2, date: at("2026-04-25T01:58"), fields: [f("System.Tags", null, "x")] }),
  ]);
  assert.deepEqual(md.match(/^## .*$/gm), ["## 2026年9月23日 週三", "## 2026年4月25日 週六"]);
  assert.match(md, /## 2026年9月23日 週三\n\n- \*\*李大同\*\*・14:59\n.*\n- \*\*王小明\*\*・09:00\n/);
  assert.equal(dayLabel(null), "（不明）");
});

test("修改紀錄：英文介面的日期與摘要", async () => {
  await useLang("en");
  try {
    assert.equal(dayLabel(at("2026-09-23T14:59")), "Wed, Sep 23, 2026");
    const md = historyMarkdown(item, [
      rev({ fields: [f("System.State", "New", "Active"), f("Microsoft.VSTS.Common.StackRank", "2", "1")] }),
      rev({ author: "李大同", date: at("2026-10-01T09:00"), fields: [f("Microsoft.VSTS.Common.StackRank", "3", "2")] }),
    ]);
    assert.match(md, /^1 change \(plus 1 change that only reordered the backlog, not shown\)$/m);
    assert.match(md, /^## Fri, Oct 2, 2026$/m);
    assert.match(md, /^- \*\*王小明\*\* · 11:00$/m);
    assert.match(md, /^ {2}- Reordered in the backlog$/m);
  } finally {
    await useLang("zh-TW");
  }
});

test("修改紀錄：沒有紀錄、欄位名稱與工作項目網址", () => {
  assert.equal(historyMarkdown(item, []), "# 修改紀錄：Bug 123：登入 \\[失敗\\]\n\n還沒有修改紀錄。\n");
  assert.equal(fieldName("Microsoft.VSTS.Scheduling.RemainingWork"), "剩餘工時");
  assert.equal(fieldName("Custom.Foo"), "Foo");
  assert.equal(workItemUrl(item, 9), "https://tfs/DC/產品/_workitems/edit/9");
});
