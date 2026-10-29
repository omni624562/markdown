import assert from "node:assert/strict";
import { test } from "node:test";
import { type GroupItem, groupByParent } from "./workitem-groups.ts";

const fmt = (it: GroupItem | undefined, id: number) => (it ? `${it.kind} ${it.id}：${it.title}` : `#${id}`);

const task = (id: number, title = `T${id}`) => ({ id, kind: "Task", title });
const story = (id: number, title = `S${id}`) => ({ id, kind: "User Story", title });

test("依上層項目分組：同一個 Story 的 Task 放一組，組的順序照清單", () => {
  const items = [task(1), task(2), task(3), task(4)];
  const parentOf = new Map<number, number | null>([[1, 10], [2, 20], [3, 10], [4, null]]);
  const parents = new Map<number, ReturnType<typeof task>>([[10, story(10, "登入")], [20, story(20, "匯出")]]);
  const groups = groupByParent(items, parentOf, parents, "沒有上層項目", fmt);
  assert.deepEqual(
    groups.map((g) => [g.title, g.head?.id ?? null, g.items.map((i) => i.id)]),
    [
      ["User Story 10：登入", 10, [1, 3]],
      ["User Story 20：匯出", 20, [2]],
      ["沒有上層項目", null, [4]],
    ],
  );
});

test("依上層項目分組：清單上的 Story 當組的標題列（不在組裡重複），不會再被分到它的上層", () => {
  const items = [task(1), story(10), task(2)];
  const parentOf = new Map<number, number | null>([[1, 10], [10, 99], [2, 10]]);
  const groups = groupByParent(items, parentOf, new Map([[99, { id: 99, kind: "Feature", title: "F" }]]), "無", fmt);
  assert.deepEqual(
    groups.map((g) => [g.title, g.head?.id, g.items.map((i) => i.id)]),
    [["User Story 10：S10", 10, [1, 2]]],
  );
});

test("依上層項目分組：讀不到上層項目時標題只寫編號；全部沒有上層時只有一組", () => {
  assert.deepEqual(groupByParent([task(1)], new Map([[1, 42]]), new Map(), "無", fmt).map((g) => g.title), ["#42"]);
  const groups = groupByParent([task(1), task(2)], new Map(), new Map(), "沒有上層項目", fmt);
  assert.deepEqual(groups.map((g) => [g.title, g.items.length]), [["沒有上層項目", 2]]);
});
