import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_WORK_ITEM_FILTER,
  fromStateChoice,
  isDefaultWorkItemFilter,
  parseWorkItemFilter,
  stateChoice,
  stateLabel,
  stateOptions,
  statesFor,
  workItemFilterKey,
} from "./work-item-filter.ts";

const STATES = [
  { name: "New", closed: false },
  { name: "Active", closed: false },
  { name: "Resolved", closed: false },
  { name: "Closed", closed: true },
  { name: "Removed", closed: true },
];
const f = (over: Partial<typeof DEFAULT_WORK_ITEM_FILTER> = {}) => ({ ...DEFAULT_WORK_ITEM_FILTER, ...over });

test("讀回存起來的條件：舊版沒有 states；壞掉的用預設值", () => {
  assert.deepEqual(parseWorkItemFilter('{"state":"closed","kind":"Bug"}'), f({ state: "closed", kinds: ["Bug"] }));
  assert.deepEqual(parseWorkItemFilter('{"state":"all","states":["New","Active"]}'), f({ state: "all", states: ["New", "Active"] }));
  assert.deepEqual(parseWorkItemFilter("{壞掉"), f());
  assert.deepEqual(parseWorkItemFilter(null), f());
  assert.ok(isDefaultWorkItemFilter(f()));
  assert.ok(!isDefaultWorkItemFilter(f({ state: "all", states: ["New"] })));
});

test("狀態選單：伺服器上的狀態；「進行中」勾所有還沒結束的，「已結束」勾結束的", () => {
  assert.deepEqual(stateOptions(STATES).map(([v]) => v), ["New", "Active", "Resolved", "Closed", "Removed"]);
  assert.deepEqual(stateChoice(f(), STATES), ["New", "Active", "Resolved"]);
  assert.deepEqual(stateChoice(f({ state: "closed" }), STATES), ["Closed", "Removed"]);
  assert.deepEqual(stateChoice(f({ state: "all" }), STATES), []);
  assert.deepEqual(stateChoice(f({ state: "all", states: ["Active"] }), STATES), ["Active"]);
  assert.equal(stateLabel(f()), "進行中");
  assert.equal(stateLabel(f({ state: "closed" })), "已結束");
  assert.equal(stateLabel(f({ state: "all", states: ["Active"] })), null);
});

test("勾的狀態 → 條件：剛好是還沒結束的存成 open（新的狀態也算），其他組合存成指定的狀態", () => {
  assert.deepEqual(fromStateChoice(["Resolved", "new", "Active"], STATES), { state: "open", states: [] });
  assert.deepEqual(fromStateChoice(["Removed", "Closed"], STATES), { state: "closed", states: [] });
  assert.deepEqual(fromStateChoice([], STATES), { state: "all", states: [] });
  assert.deepEqual(fromStateChoice(["New", "Active"], STATES), { state: "all", states: ["New", "Active"] });
  assert.deepEqual(fromStateChoice(["Active", "Closed"], STATES), { state: "all", states: ["Active", "Closed"] });
});

test("讀不到狀態清單：只有「進行中」「已結束」兩項（和以前一樣）", () => {
  const options = stateOptions([]);
  assert.deepEqual(options.map(([, label]) => label), ["進行中", "已結束"]);
  const [open, closed] = options.map(([v]) => v);
  assert.deepEqual(stateChoice(f(), []), [open]);
  assert.deepEqual(fromStateChoice([closed], []), { state: "closed", states: [] });
  assert.deepEqual(fromStateChoice([open, closed], []), { state: "all", states: [] });
});

test("離線副本的鍵：沒有指定狀態時和以前一樣（不含 states），升級後還找得到以前存的副本", () => {
  assert.equal(
    workItemFilterKey(f()),
    JSON.stringify({ role: "assigned", person: "@me", state: "open", kinds: [], projects: [], areas: [] }),
  );
  assert.equal(workItemFilterKey(parseWorkItemFilter('{"state":"open"}')), workItemFilterKey(f()));
  assert.match(workItemFilterKey(f({ state: "all", states: ["New"] })), /"states":\["New"\]/);
});

test("狀態只列選的專案、類型用得到的；同名只列一次，依流程的階段排", () => {
  const st = (name: string, stage: number, closed = false) => ({ name, stage, closed });
  const sets = [
    { project: "A", kind: "Task", states: [st("New", 0), st("Active", 1), st("Closed", 3, true)] },
    { project: "A", kind: "Bug", states: [st("New", 0), st("Resolved", 2), st("Closed", 3, true)] },
    { project: "B", kind: "Task", states: [st("To Do", 0), st("Doing", 1), st("Done", 3, true)] },
  ];
  const names = (projects: string[], kinds: string[]) => statesFor(sets, projects, kinds).map((s) => s.name);
  // 沒選專案、類型：全部，依階段排。
  assert.deepEqual(names([], []), ["New", "To Do", "Active", "Doing", "Resolved", "Closed", "Done"]);
  assert.deepEqual(names(["A"], []), ["New", "Active", "Resolved", "Closed"]);
  assert.deepEqual(names(["A"], ["Task"]), ["New", "Active", "Closed"]);
  assert.deepEqual(names([], ["Task"]), ["New", "To Do", "Active", "Doing", "Closed", "Done"]);
  // 選的類型在這個專案裡沒有：列這個專案的全部狀態。
  assert.deepEqual(names(["B"], ["Bug"]), ["To Do", "Doing", "Done"]);
  // 選的專案還沒讀到：沒有狀態（選單改列「進行中」「已結束」）。
  assert.deepEqual(names(["C"], []), []);
});
