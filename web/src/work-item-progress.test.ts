import assert from "node:assert/strict";
import { test } from "node:test";
import { doneRatio, hoursRatio, hoursText, leaves, progressOf } from "./work-item-progress.ts";
import type { TreeNode } from "./workitem-groups.ts";

test("依狀態分類計數，移除的不算", () => {
  const p = progressOf([
    { state: "Closed" },
    { state: "Closed" },
    { state: "Done" },
    { state: "Resolved" },
    { state: "Active" },
    { state: "New" },
    { state: "Removed" },
  ]);
  assert.deepEqual(p.counts, { closed: 3, resolved: 1, active: 1, new: 1 });
  assert.equal(p.total, 6);
  assert.deepEqual(p.states.closed, [["Closed", 2], ["Done", 1]]);
  assert.equal(doneRatio(p), 0.5);
  assert.equal(doneRatio(progressOf([])), null);
});

test("工時：有填的才算，都沒填時是 null", () => {
  const p = progressOf([
    { state: "Active", remaining: 4, completed: 2 },
    { state: "Closed", remaining: 0, completed: 6.5 },
    { state: "New" },
  ]);
  assert.equal(p.remaining, 4);
  assert.equal(p.completed, 8.5);
  assert.ok(Math.abs(hoursRatio(p)! - 8.5 / 12.5) < 1e-9);
  assert.equal(hoursRatio(progressOf([{ state: "New" }])), null);
  assert.equal(hoursText(9), "9");
  assert.equal(hoursText(2.5), "2.5");
});

test("Feature 的進度算底下所有最下層的項目，淡色的上層不算", () => {
  const n = (id: number, children: TreeNode<{ id: number }>[] = [], dim = false): TreeNode<{ id: number }> => ({ item: { id }, dim, children });
  const feature = n(200, [n(201, [n(1001), n(1002)], true), n(202, [n(1003)]), n(1004)]);
  assert.deepEqual(leaves(feature).map((i) => i.id), [1001, 1002, 1003, 1004]);
  assert.deepEqual(leaves(n(1)), []);
});
