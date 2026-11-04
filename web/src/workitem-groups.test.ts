import assert from "node:assert/strict";
import { test } from "node:test";
import { type GroupItem, type TreeNode, kindCounts, parentTree } from "./workitem-groups.ts";

const task = (id: number) => ({ id, kind: "Task", title: `T${id}` });
const story = (id: number) => ({ id, kind: "User Story", title: `S${id}` });
const feature = (id: number) => ({ id, kind: "Feature", title: `F${id}` });
const epic = (id: number) => ({ id, kind: "Epic", title: `E${id}` });

/** 樹畫成文字：`編號`，淡色的加 `~`，子項目放在括號裡。 */
function draw(nodes: TreeNode<GroupItem>[]): string {
  return nodes.map((n) => `${n.dim ? "~" : ""}${n.item.id}${n.children.length ? `(${draw(n.children)})` : ""}`).join(" ");
}

test("Feature → Story → Task：每一項只出現一次，在它的上層底下；不在清單上的上層淡色", () => {
  // 清單：Task 1、2 在 Story 10 底下，Story 10 在 Feature 100 底下；Story 20（指派給我）也在 Feature 100 底下。
  const items = [task(1), story(20), task(2), story(10)];
  const parentOf = new Map<number, number | null>([
    [1, 10],
    [2, 10],
    [20, 100],
    [10, 100],
    [100, null],
  ]);
  const parents = new Map<number, GroupItem>([
    [10, story(10)],
    [100, feature(100)],
  ]);
  const roots = parentTree(items, parentOf, parents);
  // Story 10 在清單上：不是淡色，也不會在 Feature 底下和 Task 那一組各出現一次。
  assert.equal(draw(roots), "~100(10(1 2) 20)");
});

test("往上一路到最上層（Epic）；每一層依編號由小到大，不管清單的順序", () => {
  const items = [task(3), task(1), task(2)];
  const parentOf = new Map<number, number | null>([
    [1, 10],
    [2, 20],
    [3, 20],
    [10, 100],
    [20, 200],
    [100, 1000],
    [200, 1000],
    [1000, null],
  ]);
  const parents = new Map<number, GroupItem>([
    [10, story(10)],
    [20, story(20)],
    [100, feature(100)],
    [200, feature(200)],
    [1000, epic(1000)],
  ]);
  assert.equal(draw(parentTree(items, parentOf, parents)), "~1000(~100(~10(1)) ~200(~20(2 3)))");
});

test("同一個 Story 的 Task 依編號由小到大（清單是最近更新的在前面）", () => {
  const items = [task(1940132), task(1940131), task(1940130), task(1940129)];
  const parentOf = new Map<number, number | null>(items.map((t) => [t.id, 1940123]));
  parentOf.set(1940123, null);
  const roots = parentTree(items, parentOf, new Map([[1940123, story(1940123)]]));
  assert.equal(draw(roots), "~1940123(1940129 1940130 1940131 1940132)");
});

test("沒有上層也沒有子項目的也是最上層的一列（不另外分組）；讀不到的上層當成沒有上層；上層繞成圈不會當掉", () => {
  const items = [task(1), task(2), task(3)];
  const parentOf = new Map<number, number | null>([
    [1, null],
    [2, 42],
    [3, 10],
    [10, 3],
  ]);
  // Story 10 那一層在 Task 1、2 前面。
  assert.equal(draw(parentTree(items, parentOf, new Map([[10, story(10)]]))), "~10(3) 1 2");
});

test("最上層依層級排（Epic → Feature → Story → Task），同一層依編號；底下沒有清單上項目的 Epic 也在最上面", () => {
  // 截圖裡的情況：Epic 指派給我，但底下的 Feature、Story 不是我的；Feature 沒有上層。
  const items = [task(5), feature(1900179), epic(1766587), story(1657015), feature(1711921), epic(1746624), task(6)];
  const parentOf = new Map<number, number | null>([
    [5, 300],
    [6, null],
    [300, null],
    [1900179, null],
    [1766587, null],
    [1657015, null],
    [1711921, null],
    [1746624, null],
  ]);
  const roots = parentTree(items, parentOf, new Map([[300, story(300)]]));
  assert.equal(draw(roots), "1746624 1766587 1711921 1900179 ~300(5) 1657015 6");
});

test("標題列的摘要：底下清單上的項目依類型計數，淡色的不算，類型照層級排", () => {
  const items = [task(1), task(2), story(10), task(3)];
  const parentOf = new Map<number, number | null>([
    [1, 10],
    [2, 20],
    [3, 20],
    [10, 100],
    [20, 100],
    [100, null],
  ]);
  const parents = new Map<number, GroupItem>([
    [20, story(20)],
    [100, feature(100)],
  ]);
  const [root] = parentTree(items, parentOf, parents);
  assert.deepEqual(kindCounts(root), [
    ["User Story", 1],
    ["Task", 3],
  ]);
});
