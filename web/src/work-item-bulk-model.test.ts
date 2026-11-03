import assert from "node:assert/strict";
import { test } from "node:test";
import { changeFor, commonStates } from "./work-item-bulk-model.ts";

const item = { id: 1, title: "x", state: "Active", kind: "Task", project: "產品", assignedTo: null, changed: null, priority: 2, webUrl: "" };

test("共同的狀態：每一組都有的，依第一組的順序", () => {
  assert.deepEqual(commonStates([["New", "Active", "Resolved", "Closed"], ["New", "Active", "Closed", "Removed"]]), ["New", "Active", "Closed"]);
  assert.deepEqual(commonStates([["To Do", "Doing"], ["New", "Active"]]), []);
  assert.deepEqual(commonStates([]), []);
});

test("每一個要送出的變更：和現在一樣的狀態、優先順序不送，沒有要改的回傳 null", () => {
  assert.deepEqual(changeFor(item, { state: "Closed", priority: 1 }), { state: "Closed", priority: 1 });
  assert.deepEqual(changeFor(item, { state: "Active", assignToMe: true }), { assignToMe: true });
  assert.equal(changeFor(item, { state: "Active", priority: 2 }), null);
  // 留言一定送。
  assert.deepEqual(changeFor(item, { state: "Active", comment: "<p>好了</p>" }), { comment: "<p>好了</p>" });
});
