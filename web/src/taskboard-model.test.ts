import assert from "node:assert/strict";
import { test } from "node:test";
import { type BoardItem, buildBoard, filterBoard, hoursText } from "./taskboard-model.ts";

const w = (id: number, kind: string, state: string, parent: number | null, extra: Partial<BoardItem> = {}): BoardItem => ({
  id,
  title: `項目 ${id}`,
  state,
  kind,
  assignedTo: null,
  priority: null,
  parent,
  ...extra,
});
const TASK = new Set(["Task"]);
const STATES = ["New", "Active", "Resolved", "Closed"];

test("每個上層項目一列，子項目依狀態放進欄位", () => {
  const items = [
    w(1, "User Story", "Active", null, { priority: 2 }),
    w(11, "Task", "New", 1),
    w(12, "Task", "Resolved", 1),
    w(2, "User Story", "New", null, { priority: 1 }),
    w(21, "Task", "Active", 2),
  ];
  const b = buildBoard(items, [], STATES, TASK);
  assert.deepEqual(b.columns, STATES);
  assert.deepEqual(
    b.rows.map((r) => r.parent?.id),
    [2, 1],
    "優先順序 1 的在前",
  );
  assert.deepEqual(b.rows[1].cells.get("New")!.map((c) => c.id), [11]);
  assert.deepEqual(b.rows[1].cells.get("Resolved")!.map((c) => c.id), [12]);
});

test("上層不在這個 Sprint：用另外讀到的上層；沒有上層的工作放最後一列", () => {
  const items = [w(11, "Task", "New", 100), w(30, "Task", "Active", null), w(40, "Bug", "New", null)];
  const b = buildBoard(items, [w(100, "User Story", "Active", null)], STATES, TASK);
  assert.deepEqual(
    b.rows.map((r) => r.parent?.id ?? null),
    [40, 100, null],
  );
  assert.deepEqual(b.rows[2].cells.get("Active")!.map((c) => c.id), [30]);
  assert.equal([...b.rows[0].cells.values()].flat().length, 0, "沒有子項目的 Bug 自己是一列");
});

test("卡片上出現清單外的狀態：接在最後一欄", () => {
  const b = buildBoard([w(1, "User Story", "New", null), w(11, "Task", "Blocked", 1)], [], STATES, TASK);
  assert.deepEqual(b.columns, [...STATES, "Blocked"]);
});

test("中間層（Feature → Story → Task）：Story 是一列，不再當 Feature 的卡片", () => {
  const items = [w(5, "Feature", "Active", null), w(1, "User Story", "Active", 5), w(11, "Task", "New", 1)];
  const b = buildBoard(items, [], STATES, TASK);
  const cardIds = b.rows.flatMap((r) => [...r.cells.values()].flat().map((c) => c.id));
  assert.deepEqual(cardIds, [11]);
  assert.ok(b.rows.some((r) => r.parent?.id === 1));
});

test("只看某個人", () => {
  const items = [
    w(1, "User Story", "Active", null, { assignedTo: "甲" }),
    w(11, "Task", "New", 1, { assignedTo: "乙" }),
    w(2, "User Story", "Active", null, { assignedTo: "乙" }),
    w(21, "Task", "New", 2, { assignedTo: "甲" }),
  ];
  const b = filterBoard(buildBoard(items, [], STATES, TASK), "乙");
  assert.deepEqual(
    b.rows.map((r) => r.parent?.id),
    [1, 2],
  );
  assert.deepEqual(b.rows[0].cells.get("New")!.map((c) => c.id), [11]);
  assert.equal(b.rows[1].cells.get("New")!.length, 0, "上層是乙的那一列留著，但不顯示甲的卡片");
});

test("工時摘要", () => {
  const label = { remaining: (n: string) => `剩 ${n}`, completed: (n: string) => `完成 ${n}` };
  assert.equal(hoursText(w(1, "Task", "New", null, { remaining: 3.25, completed: 1 }), label), "剩 3.3 · 完成 1");
  assert.equal(hoursText(w(1, "Task", "New", null), label), "");
});
