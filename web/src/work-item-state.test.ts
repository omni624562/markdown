import assert from "node:assert/strict";
import { test } from "node:test";
import { stateTone } from "./work-item-state.ts";

test("狀態名稱對應的分類：英文與中文的流程範本、不分大小寫、前後空白", () => {
  const cases: [string, string][] = [
    ["New", "new"],
    ["To Do", "new"],
    ["Proposed", "new"],
    ["Active", "active"],
    ["In Progress", "active"],
    ["Committed", "active"],
    ["Open", "active"],
    ["Resolved", "resolved"],
    ["Closed", "closed"],
    [" Done ", "closed"],
    ["Completed", "closed"],
    ["Removed", "removed"],
    ["Cut", "removed"],
    ["已關閉", "closed"],
    ["已完成", "closed"],
    ["已解決", "resolved"],
    ["進行中", "active"],
  ];
  assert.deepEqual(cases.map(([s]) => stateTone(s)), cases.map(([, tone]) => tone));
});

test("認不得的自訂狀態當成進行中", () => {
  assert.equal(stateTone("自訂狀態"), "active");
  assert.equal(stateTone("Ready for QA"), "active");
});
