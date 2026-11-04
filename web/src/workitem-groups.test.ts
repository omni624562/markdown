import assert from "node:assert/strict";
import { test } from "node:test";
import { type AreaGroup, type AreaTree, type GroupItem, type TreeNode, areaGroups, areaTrees, kindCounts, parentTree } from "./workitem-groups.ts";

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

// 「依區域分組」
const P = "Mgt-Digital_Cloud_Platform";
const at = (id: number, area?: string | null) => ({ id, area });
/** 下拉選單的區域（樹狀順序）。 */
const ORDER = [`${P}\\1730`, `${P}\\Comet`, `${P}\\ITA`, `${P}\\ITA\\監控`, `${P}\\ITA\\維運`, `${P}\\共用`];
/** 分組畫成文字：`標題: 編號（子區域）…`，一組一行。 */
function drawAreas(groups: AreaGroup<{ id: number }>[]): string[] {
  return groups.map((g) => `${g.title ?? "（其他）"}: ${g.items.map(({ item, sub }) => (sub ? `${item.id}(${sub})` : String(item.id))).join(" ")}`);
}

test("依區域分組：一個選的區域一組，照下拉選單的順序；子區域的項目在上層那一組，標出子區域", () => {
  const items = [at(1, `${P}\\ITA\\監控`), at(2, `${P}\\Comet`), at(3, `${P}\\1730`), at(4, `${P}\\ITA`), at(5, `${P}\\ITA\\監控\\告警`)];
  // 選的順序和下拉選單不同（例如存下來的舊順序）：照下拉選單排。
  const groups = areaGroups(items, [`${P}\\ITA`, `${P}\\1730`, `${P}\\Comet`], ORDER);
  assert.deepEqual(drawAreas(groups), ["1730: 3", "Comet: 2", "ITA: 1(監控) 4 5(監控 › 告警)"]);
  assert.deepEqual(
    groups.map((g) => g.area),
    [`${P}\\1730`, `${P}\\Comet`, `${P}\\ITA`],
  );
});

test("依區域分組：放在包含它的選的區域裡最深的那一個；不分大小寫", () => {
  const items = [at(1, `${P}\\ITA\\監控`), at(2, `${P.toLowerCase()}\\ita\\監控\\告警`), at(3, `${P}\\ita\\維運`)];
  const groups = areaGroups(items, [`${P}\\ITA`, `${P}\\ITA\\監控`], ORDER);
  assert.deepEqual(drawAreas(groups), ["ITA: 3(維運)", "ITA › 監控: 1 2(告警)"]);
});

test("依區域分組：沒有項目的區域不列；不在選的區域裡的依第一層區域排在後面，沒有區域的放在最後的「其他」", () => {
  const items = [at(1, `${P}\\共用\\文件`), at(2), at(3, `${P}\\ITA`), at(4, null), at(5, ""), at(6, P)];
  const groups = areaGroups(items, [`${P}\\1730`, `${P}\\ITA`], ORDER);
  assert.deepEqual(drawAreas(groups), ["ITA: 3", `${P}: 6`, "共用: 1(文件)", "（其他）: 2 4 5"]);
  assert.equal(groups.at(-1)!.area, null);
});

test("依區域分組：沒選區域時依專案底下的第一層區域分組，直接在專案底下的是專案那一組（排在最前面）", () => {
  const items = [at(1, `${P}\\ITA\\監控`), at(2, `${P}\\Comet`), at(3, P), at(4, `${P}\\ITA`), at(5, `${P}\\1730\\前端`)];
  // 照下拉選單的順序。
  assert.deepEqual(drawAreas(areaGroups(items, [], ORDER)), [`${P}: 3`, "1730: 5(前端)", "Comet: 2", "ITA: 1(監控) 4"]);
  // 還沒讀到下拉選單（例如沒選專案）：專案在前面，區域依名稱排。
  assert.deepEqual(drawAreas(areaGroups(items, [])), [`${P}: 3`, "1730: 5(前端)", "Comet: 2", "ITA: 1(監控) 4"]);
  assert.deepEqual(drawAreas(areaGroups([at(1, "產品\\後端"), at(2, "產品\\前端"), at(3, "產品\\後端")], [])), ["前端: 2", "後端: 1 3"]);
});

test("依區域分組：清單上有好幾個專案時，標題前面加上專案", () => {
  const items = [at(1, "平台\\ITA"), at(2, `${P}\\ITA`), at(3, "平台"), at(4, `${P}\\Comet\\API`)];
  // 不知道順序時專案依名稱排（和其他清單一樣用 collator），每個專案本身那一組在它的區域前面。
  assert.deepEqual(drawAreas(areaGroups(items, [])), [
    "平台: 3",
    "平台 › ITA: 1",
    `${P} › Comet: 4(API)`,
    `${P} › ITA: 2`,
  ]);
  // 選的區域在不同專案也一樣。
  assert.deepEqual(drawAreas(areaGroups(items, [`${P}\\ITA`, "平台\\ITA"], [`${P}\\ITA`, "平台\\ITA"])), [`${P} › ITA: 2`, "平台 › ITA: 1", "平台: 3", `${P} › Comet: 4(API)`]);
});

test("依區域分組：組裡照清單原本的順序（最近更新的在前面）", () => {
  const items = [at(9, `${P}\\ITA\\監控`), at(2, `${P}\\ITA`), at(7, `${P}\\ITA\\維運`)];
  assert.deepEqual(drawAreas(areaGroups(items, [`${P}\\ITA`], ORDER)), ["ITA: 9(監控) 2 7(維運)"]);
});

// 「依區域＋上層項目分組」
type AreaItem = GroupItem & { area?: string | null };
/** 某個區域的工作項目：`wi(5, "Task", "Comet")`；`area` 是 undefined 時沒有區域（舊的離線副本）。 */
const wi = (id: number, kind: string, area?: string): AreaItem => ({ id, kind, title: `${kind} ${id}`, area: area === undefined ? undefined : `${P}\\${area}` });
/** 分組畫成文字：`標題: 樹`，一組一行。 */
function drawAreaTrees(groups: AreaTree<AreaItem>[]): string[] {
  return groups.map((g) => `${g.title ?? "（其他）"}: ${draw(g.tree)}`);
}

/**
 * 選了 1730、ITA、Comet：
 * - 1730：Story 40 與它的 Task 41（在子區域「前端」）。
 * - ITA：Story 20 與它的 Task 21（在子區域「監控」）；Story 20 在 Feature 100 底下（不在清單上）。
 * - Comet：Story 30 與它的 Task 31、32；Task 5 也在 Comet，但它的上層是 ITA 的 Story 20。Story 30 也在 Feature 100 底下。
 */
const PICKED_AREAS = [`${P}\\1730`, `${P}\\ITA`, `${P}\\Comet`];
const AREA_ITEMS = [
  wi(5, "Task", "Comet"),
  wi(21, "Task", "ITA\\監控"),
  wi(20, "User Story", "ITA"),
  wi(31, "Task", "Comet"),
  wi(41, "Task", "1730\\前端"),
  wi(30, "User Story", "Comet"),
  wi(32, "Task", "Comet\\API"),
  wi(40, "User Story", "1730"),
];
const AREA_PARENT_OF = new Map<number, number | null>([
  [5, 20],
  [21, 20],
  [20, 100],
  [31, 30],
  [32, 30],
  [30, 100],
  [41, 40],
  [40, null],
  [100, null],
]);
/** 讀到的上層（伺服器回的上層也包含清單上的項目，例如 Story 20）。 */
const AREA_PARENTS = new Map<number, AreaItem>([
  [20, { ...wi(20, "User Story", "ITA"), title: "讀到的舊標題" }],
  [30, wi(30, "User Story", "Comet")],
  [40, wi(40, "User Story", "1730")],
  [100, wi(100, "Feature", "ITA")],
]);

test("依區域＋上層項目分組：組和依區域分組一樣，組裡是只用這一組的項目排的樹；上層在別的區域時淡色地列在這一組", () => {
  const groups = areaTrees(AREA_ITEMS, PICKED_AREAS, ORDER, AREA_PARENT_OF, AREA_PARENTS);
  assert.deepEqual(drawAreaTrees(groups), [
    "1730: 40(41)",
    // Task 5 只在 Comet；它的 Story 20（ITA）在這裡是淡色的上層。
    "Comet: ~100(~20(5) 30(31 32))",
    // Feature 100 不在清單上：在 Comet、ITA 兩組各淡淡地出現一次。
    "ITA: ~100(20(21))",
  ]);
  // 組、順序、標題、項目（數量）與子區域的小字都和依區域分組一樣。
  const plain = areaGroups(AREA_ITEMS, PICKED_AREAS, ORDER);
  assert.deepEqual(
    groups.map(({ area, title, items }) => ({ area, title, items })),
    plain.map(({ area, title, items }) => ({ area, title, items })),
  );
  assert.deepEqual(
    groups.map((g) => g.items.length),
    [2, 4, 2],
  );
  // 每個清單上的項目只在一組裡是一般的列（不是淡色），而且就是它的區域那一組。
  const solid = (nodes: TreeNode<AreaItem>[]): number[] => nodes.flatMap((n) => [...(n.dim ? [] : [n.item.id]), ...solid(n.children)]);
  for (const g of groups)
    assert.deepEqual(
      solid(g.tree).sort((a, b) => a - b),
      g.items.map(({ item }) => item.id).sort((a, b) => a - b),
    );
});

test("依區域＋上層項目分組：別的組的項目當上層時用清單上的那一份；沒有區域的放在最後的「其他」，也排成樹", () => {
  const items = [...AREA_ITEMS, wi(7, "Task"), wi(8, "Task", "共用")];
  const parentOf = new Map([...AREA_PARENT_OF, [7, 30], [8, null]]);
  const groups = areaTrees(items, PICKED_AREAS, ORDER, parentOf, AREA_PARENTS);
  assert.deepEqual(drawAreaTrees(groups).slice(1), ["Comet: ~100(~20(5) 30(31 32))", "ITA: ~100(20(21))", "共用: 8", "（其他）: ~100(~30(7))"]);
  const comet = groups.find((g) => g.title === "Comet")!;
  const story20 = comet.tree[0].children[0];
  assert.equal(story20.item, items.find((it) => it.id === 20), "Story 20 用清單上的那一份");
  assert.equal(story20.item.title, "User Story 20");
});
