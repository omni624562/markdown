import assert from "node:assert/strict";
import { test } from "node:test";
import { type BoardItem, buildBoard, capacityRows, filterBoard, hoursText, workingDays } from "./taskboard-model.ts";

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
  assert.equal(hoursText(w(1, "Task", "New", null, { remaining: 0, completed: 0.01 }), label), "", "0 小時不顯示");
});

test("工作天：扣掉週末與休假", () => {
  // 2026-11-02 是星期一。
  assert.equal(workingDays("2026-11-02", "2026-11-08", []), 5);
  assert.equal(workingDays("2026-11-02T00:00:00Z", "2026-11-13T00:00:00Z", [{ start: "2026-11-04T00:00:00Z", end: "2026-11-05T00:00:00Z" }]), 8);
  assert.equal(workingDays("2026-11-07", "2026-11-08", []), 0, "週末");
});

test("容量：從今天算到 Sprint 結束，比較每個人的剩餘工時", () => {
  const cards = [
    w(1, "Task", "Active", null, { assignedTo: "王小明", remaining: 10 }),
    w(2, "Task", "New", null, { assignedTo: "王小明", remaining: 8 }),
    w(3, "Task", "New", null, { assignedTo: "李大同", remaining: 2 }),
    w(4, "Task", "New", null, { assignedTo: "外部的人", remaining: 3 }),
    w(5, "Task", "New", null, { remaining: 5 }),
  ];
  const cap = {
    members: [
      { name: "王小明", perDay: 6, daysOff: [{ start: "2026-11-05", end: "2026-11-05" }] },
      { name: "李大同", perDay: 4, daysOff: [] },
      { name: "沒排工作也沒容量", perDay: 0, daysOff: [] },
    ],
    teamDaysOff: [{ start: "2026-11-06", end: "2026-11-06" }],
  };
  // 今天是 11/4（三），Sprint 到 11/6（五）：11/4、11/5、11/6，11/6 團隊休假。
  const rows = capacityRows(cap, cards, "2026-10-26", "2026-11-06", "2026-11-04");
  assert.deepEqual(
    rows.map((r) => [r.name, r.available, r.assigned, r.over]),
    [
      ["王小明", 6, 18, true],
      ["李大同", 8, 2, false],
      ["外部的人", 0, 3, true],
      [null, 0, 5, false],
    ],
  );
});
