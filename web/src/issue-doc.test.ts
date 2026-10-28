import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdoWorkItemDetail, GitHubIssueDetail } from "./desktop.ts";
import { githubIssueMarkdown, inlineText, issueFileName, workItemMarkdown } from "./issue-doc.ts";
import { findMatches } from "./ui/issue-view.ts";

const item: AdoWorkItemDetail = {
  id: 42,
  title: "修正 [登入] *問題*",
  state: "Active",
  kind: "Bug",
  project: "產品",
  changed: "2026-10-20T06:30:00Z",
  webUrl: "https://tfs/DC/產品/_workitems/edit/42",
  assignedTo: "王小明",
  createdBy: "陳小華",
  area: "產品\\前端",
  iteration: null,
  priority: 2,
  tags: ["登入", "急件"],
  description: "<p>按下<strong>登入</strong>沒有反應</p><script>alert(1)</script>",
  details: "<ol><li>開啟網站</li><li>按登入</li></ol>",
  comments: [{ author: "李大同", created: "2026-10-21T01:00:00Z", text: "<p>已重現</p>" }],
  rev: 3,
};

test("工作項目：標題跳脫、欄位表、說明與重現步驟轉成 Markdown、留言", () => {
  const md = workItemMarkdown(item);
  assert.match(md, /^# Bug 42：修正 \\\[登入\\\] \\\*問題\\\*/);
  assert.match(md, /\| 狀態 \| Active \|/);
  assert.match(md, /\| 指派給 \| 王小明 \|/);
  assert.match(md, /\| 標籤 \| 登入、急件 \|/);
  assert.doesNotMatch(md, /反覆項目/, "空的欄位不列出");
  assert.match(md, /\[在瀏覽器開啟\]\(<https:\/\/tfs\/DC\/產品\/_workitems\/edit\/42>\)/);
  assert.match(md, /## 工作項目說明\n\n按下\*\*登入\*\*沒有反應/);
  assert.doesNotMatch(md, /script|alert/);
  assert.match(md, /## 重現步驟\n\n1\.\s+開啟網站\n2\.\s+按登入/);
  assert.match(md, /## 留言（1）\n\n### 李大同・\d{4}-\d\d-\d\d \d\d:\d\d\n\n已重現/);
});

test("工作項目沒有說明與留言時不列出空的段落", () => {
  const md = workItemMarkdown({ ...item, description: null, details: null, comments: [], kind: "Task" });
  assert.doesNotMatch(md, /## /);
});

test("GitHub issue", () => {
  const d: GitHubIssueDetail = {
    number: 7,
    title: "加上 | 分隔",
    state: "closed",
    labels: ["bug"],
    author: "omni",
    comments: 1,
    updated: null,
    webUrl: "https://github.com/o/r/issues/7",
    assignees: [],
    body: "內容 **粗體**",
    commentList: [{ author: "bot", created: null, body: "好" }],
  };
  const md = githubIssueMarkdown(d);
  assert.match(md, /^# #7 加上 \\\| 分隔/);
  assert.match(md, /\| 狀態 \| 已關閉 \|/);
  assert.match(md, /## 內容\n\n內容 \*\*粗體\*\*/);
  assert.match(md, /### bot\n\n好/);
});

test("跳脫與檔名", () => {
  assert.equal(inlineText(" a\nb  <c> "), "a b \\<c\\>");
  assert.equal(issueFileName("Bug 42", 'a/b:c*"d"?'), "Bug 42 a b c d.md");
});

test("內容裡找字：不分大小寫，同一段文字裡找出每一個", () => {
  const nodes = [{ nodeValue: "Login 登入 login" }, { nodeValue: "無" }] as unknown as Text[];
  const m = findMatches(nodes, "LOGIN");
  assert.deepEqual(
    m.map((x) => [x.start, x.end]),
    [
      [0, 5],
      [9, 14],
    ],
  );
  assert.deepEqual(findMatches(nodes, ""), []);
});
