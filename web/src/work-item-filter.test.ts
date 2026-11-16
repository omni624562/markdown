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
  sprintOptions,
  sprintTeam,
  statesFor,
  storedWorkItemFilter,
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

test("Sprint 不存起來：每次打開都從本週開始；離線副本的鍵分得出不同的 Sprint", () => {
  const picked = f({ projects: ["產品"], iterations: ["產品\\Sprint 46"] });
  const stored = storedWorkItemFilter(picked);
  assert.ok(!stored.includes("iterations"), stored);
  assert.deepEqual(parseWorkItemFilter(stored).iterations, []);
  assert.deepEqual(parseWorkItemFilter('{"projects":["產品"],"iterations":["產品\\\\Sprint 46"]}').iterations, []);
  assert.notEqual(workItemFilterKey(picked), workItemFilterKey(f({ projects: ["產品"] })));
  // 沒選 Sprint 時和以前的鍵一樣（升級後還找得到以前存的離線副本）。
  assert.equal(workItemFilterKey(f()), JSON.stringify({ role: "assigned", person: "@me", state: "open", kinds: [], projects: [], areas: [] }));
  assert.ok(!isDefaultWorkItemFilter(f({ iterations: ["產品"] })));
});

test("Sprint 選單：新的在上面，標出本週、下一個、已結束與日期；最後是沒有排進 Sprint", () => {
  const sprint = (n: number, start: string | null, finish: string | null, current = false) => ({ path: `產品\\Sprint ${n}`, name: `Sprint ${n}`, start, finish, current });
  const list = [
    sprint(45, "2026-10-27T00:00:00Z", "2026-11-02T00:00:00Z"),
    sprint(46, "2026-11-03T00:00:00Z", "2026-11-09T00:00:00Z"),
    sprint(47, "2026-11-10T00:00:00Z", "2026-11-23T00:00:00Z", true),
    sprint(48, "2026-11-24T00:00:00Z", "2026-12-07T00:00:00Z"),
    sprint(49, null, null),
  ];
  const { options, current, columns } = sprintOptions(list, "產品");
  assert.equal(current, "產品\\Sprint 47");
  // 選單裡分欄：名稱、狀態、日期；沒有的是空字串，「沒有排進 Sprint」不分欄。
  assert.deepEqual(columns.get("產品\\Sprint 47"), ["Sprint 47", "本週", "11/10–11/23"]);
  assert.deepEqual(columns.get("產品\\Sprint 49"), ["Sprint 49", "", ""]);
  assert.equal(columns.get("產品"), undefined);
  assert.deepEqual(
    options.map(([, label]) => label),
    [
      "Sprint 49",
      "Sprint 48（下一個，11/24–12/7）",
      "Sprint 47（本週，11/10–11/23）",
      "Sprint 46（已結束，11/3–11/9）",
      "Sprint 45（已結束，10/27–11/2）",
      "沒有排進 Sprint（Backlog）",
    ],
  );
  assert.deepEqual(options.at(-1), ["產品", "沒有排進 Sprint（Backlog）"]);
  // 團隊沒有設定日期（沒有「目前」）：沒有預設值，只有名字與日期。
  const none = sprintOptions([sprint(1, "2026-01-05T00:00:00Z", "2026-01-18T00:00:00Z")], "產品");
  assert.equal(none.current, null);
  assert.deepEqual(none.options[0], ["產品\\Sprint 1", "Sprint 1（1/5–1/18）"]);
  assert.deepEqual(sprintOptions([], "產品").options, [["產品", "沒有排進 Sprint（Backlog）"]]);
});

test("Sprint 依哪個團隊：設定指定的 → 自己所屬的 → 專案的預設團隊", () => {
  const team = (name: string, d = false, mine = false) => ({ name, default: d, mine });
  const teams = [team("產品團隊", true), team("前端"), team("Contoso", false, true), team("後端", false, true)];
  const none = { adoDefaultProject: "", adoDefaultTeam: "" };
  assert.equal(sprintTeam(teams, "產品", none)?.name, "Contoso");
  // 設定裡這個專案指定了預設團隊：用它；指定的是別的專案就不算。
  assert.equal(sprintTeam(teams, "產品", { adoDefaultProject: "產品", adoDefaultTeam: "前端" })?.name, "前端");
  assert.equal(sprintTeam(teams, "產品", { adoDefaultProject: "別的", adoDefaultTeam: "前端" })?.name, "Contoso");
  // 自己屬於好幾個團隊、其中一個是預設團隊：用預設團隊。
  assert.equal(sprintTeam([team("前端", false, true), team("產品團隊", true, true)], "產品", none)?.name, "產品團隊");
  // 讀不到自己所屬的團隊：用專案的預設團隊。
  assert.equal(sprintTeam([team("前端"), team("產品團隊", true)], "產品", none)?.name, "產品團隊");
  assert.equal(sprintTeam([], "產品", none), null);
});
