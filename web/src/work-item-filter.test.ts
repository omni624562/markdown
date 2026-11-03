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
