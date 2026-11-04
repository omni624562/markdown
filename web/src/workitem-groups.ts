/**
 * 工作項目清單的分組：
 * - 「依上層項目分組」：排成一棵樹（Epic → Feature → User Story → Task），每一項只出現一次，
 *   在它的上層底下；不在清單上的上層（例如不是指派給你的 Feature）也列出來當標題列（淡色、不算數）。
 * - 「依區域分組」：篩選選了區域時一個區域一組，沒選時依專案底下的第一層區域分組（見 `areaGroups`）。
 * - 「依區域＋上層項目分組」：和依區域分組一樣的組，組裡再依上層排成樹（見 `areaTrees`）。
 */

import { collator } from "./collator.ts";

export interface GroupItem {
  id: number;
  kind: string;
  title: string;
}

/** 樹的一個節點：項目與它底下的子項目。 */
export interface TreeNode<T> {
  item: T;
  /** 不在清單上、只是用來分組的上層。 */
  dim: boolean;
  children: TreeNode<T>[];
}

/**
 * 依上層項目排成樹。`items` 是清單上的項目（順序照清單：最近更新的在前面）；
 * `parentOf` 是每個項目的上層編號（清單上的與讀到的上層都要有，沒有上層是 null）；
 * `parents` 是讀到的上層項目（不在清單上的上層用）。
 * 子項目依編號由小到大排（和建立的先後一樣，Task 1、2、3 依序往下）；最上層先依層級
 * （Epic → Feature → Story → Task），同一層再依編號。沒有上層、底下也沒有項目的（例如 Epic 底下的
 * 項目都不在清單上）也是最上層的一列，不另外分一組。讀不到的上層就當成沒有上層。
 */
export function parentTree<T extends GroupItem>(
  items: T[],
  parentOf: Map<number, number | null>,
  parents: Map<number, T>,
): TreeNode<T>[] {
  const listed = new Map(items.map((it) => [it.id, it]));
  const nodes = new Map<number, TreeNode<T>>();
  /** 已經接到上層（或確定是最上層）的節點。 */
  const placed = new Set<number>();
  const roots: TreeNode<T>[] = [];
  const nodeOf = (id: number): TreeNode<T> | null => {
    let node = nodes.get(id);
    if (node) return node;
    const item = listed.get(id) ?? parents.get(id);
    if (!item) return null;
    node = { item, dim: !listed.has(id), children: [] };
    nodes.set(id, node);
    return node;
  };
  for (const it of items) {
    let node = nodeOf(it.id)!;
    // 往上接到上層，直到接上已經放好的節點或最上層（`seen` 避免上層關係繞成圈）。
    const seen = new Set<number>();
    while (!placed.has(node.item.id)) {
      placed.add(node.item.id);
      seen.add(node.item.id);
      const p = parentOf.get(node.item.id);
      const parent = p != null && !seen.has(p) ? nodeOf(p) : null;
      if (!parent) {
        roots.push(node);
        break;
      }
      parent.children.push(node);
      node = parent;
    }
  }
  const byId = (a: TreeNode<T>, b: TreeNode<T>) => a.item.id - b.item.id;
  const sort = (list: TreeNode<T>[]) => {
    list.sort(byId);
    for (const n of list) sort(n.children);
  };
  sort(roots);
  roots.sort((a, b) => kindLevel(a.item.kind) - kindLevel(b.item.kind) || a.item.id - b.item.id);
  return roots;
}

/** 常見類型（Agile、Scrum、CMMI、Basic 流程）的層級，最上層是 0；沒列到的（自訂類型）當成 Story 那一層。 */
const LEVELS: Record<string, number> = {
  Epic: 0,
  Feature: 1,
  "User Story": 2,
  "Product Backlog Item": 2,
  Requirement: 2,
  Issue: 2,
  Bug: 2,
  Task: 3,
};

export function kindLevel(kind: string): number {
  return LEVELS[kind] ?? 2;
}

/** 節點底下（不含自己）清單上的項目，依類型計數；類型照第一次出現的層級排（例如 User Story 在 Task 前面）。 */
export function kindCounts<T extends GroupItem>(node: TreeNode<T>): [string, number][] {
  const counts = new Map<string, number>();
  let level = node.children;
  while (level.length) {
    for (const n of level) if (!n.dim) counts.set(n.item.kind, (counts.get(n.item.kind) ?? 0) + 1);
    level = level.flatMap((n) => n.children);
  }
  return [...counts];
}

/** 「依區域分組」的一組。 */
export interface AreaGroup<T> {
  /** 這一組的區域路徑（例如 `產品\IRIS`，專案本身那一組是專案名稱）；沒有區域的那一組是 null。 */
  area: string | null;
  /**
   * 標題：相對於專案的路徑，用「 › 」隔開（例如「IRIS › 監控」；專案本身那一組是專案名稱），
   * 清單上有好幾個專案時前面加上專案。沒有區域的那一組是 null（畫面上寫「其他」）。
   */
  title: string | null;
  /**
   * 組裡的項目（照清單的順序）；`sub` 是項目在這個區域底下的子區域時標在列上的小字：相對於這一組的路徑
   * （`IRIS` 那一組裡 `IRIS\監控` 的項目是「監控」，`IRIS\監控\告警` 是「監控 › 告警」），剛好在這個區域時是 null。
   */
  items: { item: T; sub: string | null }[];
}

/** 區域路徑的分隔符號（`產品\IRIS\監控`）。 */
const AREA_SEP = "\\";
/** 標題、小字裡的分隔。 */
const AREA_JOIN = " › ";

const segments = (path: string): string[] =>
  path
    .split(AREA_SEP)
    .map((s) => s.trim())
    .filter(Boolean);
/** 比對用：不分大小寫（Azure DevOps 的區域路徑不分大小寫），去掉多餘的空白與分隔符號。 */
const areaKey = (path: string): string => segments(path).join(AREA_SEP).toLowerCase();
/** `path` 等於 `area` 或在它底下。 */
const isUnder = (path: string, area: string): boolean => path === area || path.startsWith(area + AREA_SEP);

/**
 * 依區域分組。`selected` 是篩選選的區域（完整路徑），`order` 是區域下拉選單列出的順序（還沒讀到時是空的）。
 *
 * - 有選區域：一個選的區域一組，照下拉選單的順序；項目放在包含它的區域裡最深的那一個（例如選了 `IRIS` 與
 *   `IRIS\監控`，`IRIS\監控` 底下的放在 `IRIS\監控`），在更下面的子區域時 `sub` 寫出子區域（「監控」）。
 *   不在任何選的區域裡的（例如輸入編號找到的）照沒選區域的方式分組，排在後面。
 * - 沒選區域：依專案底下的第一層區域（`專案\X`）分組，直接在專案底下的是專案名稱那一組；
 *   順序照下拉選單（專案本身排在它的區域前面），不知道順序的依名稱排。
 * - 沒有區域的（更新前存下的離線副本）放在最後一組（`area`、`title` 是 null）。
 *
 * 比對不分大小寫；沒有項目的組不列出（和其他分組一樣）。
 */
export function areaGroups<T extends { area?: string | null }>(items: readonly T[], selected: readonly string[], order: readonly string[] = []): AreaGroup<T>[] {
  const index = new Map<string, number>();
  order.forEach((p, i) => {
    const k = areaKey(p);
    if (!index.has(k)) index.set(k, i);
  });
  const orderKeys = [...index.keys()];
  /** 在下拉選單的第幾個；專案本身（選單上沒有）排在它的第一個區域前面；不知道的排在最後。 */
  const rank = (key: string): number => {
    const i = index.get(key);
    if (i !== undefined) return i;
    if (!key.includes(AREA_SEP)) {
      const first = orderKeys.findIndex((k) => k.startsWith(key + AREA_SEP));
      if (first >= 0) return index.get(orderKeys[first])! - 0.5;
    }
    return order.length;
  };
  // 選的區域：去掉重複，照下拉選單的順序（不在選單裡的照原本的順序排在後面）。
  const chosen = new Map<string, string>();
  for (const a of selected) {
    const k = areaKey(a);
    if (k && !chosen.has(k)) chosen.set(k, segments(a).join(AREA_SEP));
  }
  const picked = [...chosen.keys()].sort((a, b) => rank(a) - rank(b));
  // 深的在前面：找包含項目的區域時先找到最深的。
  const deepestFirst = [...picked].sort((a, b) => segments(b).length - segments(a).length);

  const groups = new Map<string, { area: string; items: { item: T; sub: string | null }[] }>();
  const none: T[] = [];
  for (const item of items) {
    const parts = segments(item.area ?? "");
    if (!parts.length) {
      none.push(item);
      continue;
    }
    const key = parts.join(AREA_SEP).toLowerCase();
    const inPicked = deepestFirst.find((a) => isUnder(key, a));
    const groupKey = inPicked ?? parts.slice(0, 2).join(AREA_SEP).toLowerCase();
    let group = groups.get(groupKey);
    if (!group) {
      group = { area: inPicked ? chosen.get(inPicked)! : parts.slice(0, 2).join(AREA_SEP), items: [] };
      groups.set(groupKey, group);
    }
    const base = segments(group.area);
    const sub = parts.length > base.length ? parts.slice(base.length).join(AREA_JOIN) : null;
    group.items.push({ item, sub });
  }

  const project = (key: string) => key.split(AREA_SEP)[0];
  const others = [...groups.keys()]
    .filter((k) => !chosen.has(k))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        collator.compare(project(a), project(b)) ||
        segments(a).length - segments(b).length ||
        collator.compare(a, b),
    );
  const keys = [...picked.filter((k) => groups.has(k)), ...others];
  // 清單上有好幾個專案時，標題前面加上專案才分得出來。
  const several = new Set(keys.map(project)).size > 1;
  const titleOf = (area: string) => {
    const parts = segments(area);
    return (several || parts.length === 1 ? parts : parts.slice(1)).join(AREA_JOIN);
  };
  const out: AreaGroup<T>[] = keys.map((k) => {
    const g = groups.get(k)!;
    return { area: g.area, title: titleOf(g.area), items: g.items };
  });
  if (none.length) out.push({ area: null, title: null, items: none.map((item) => ({ item, sub: null })) });
  return out;
}

/** 「依區域＋上層項目分組」的一組：和 `areaGroups` 的組一樣（區域、標題、項目），另外是組裡的樹。 */
export interface AreaTree<T> extends AreaGroup<T> {
  /**
   * 只用這一組的項目依上層排成的樹（見 `parentTree`）。上層不在這一組時（在別的區域，或不在清單上）
   * 也列出來當標題列，淡色；所以同一個上層可以在好幾組各淡淡地出現一次，組裡的項目只出現在自己的那一組。
   */
  tree: TreeNode<T>[];
}

/**
 * 依區域＋上層項目分組：先和「依區域分組」一樣分組（`areaGroups`：組、順序、標題、項目都一樣，數量也一樣），
 * 每一組裡再只用這一組的項目依上層排成樹（`parentTree`）。例如 Task 在 Cobalt、它的 Story 在 IRIS：
 * Task 只在 Cobalt 那一組，Story 在 IRIS 那一組是一般的列，在 Cobalt 那一組是 Task 上面淡色的上層。
 *
 * `parentOf`、`parents` 和 `parentTree` 一樣；別的組的項目當上層時用清單上的那一份（不用另外讀到的）。
 */
export function areaTrees<T extends GroupItem & { area?: string | null }>(
  items: readonly T[],
  selected: readonly string[],
  order: readonly string[],
  parentOf: Map<number, number | null>,
  parents: Map<number, T>,
): AreaTree<T>[] {
  const known = new Map(parents);
  for (const it of items) known.set(it.id, it);
  return areaGroups(items, selected, order).map((g) => ({
    ...g,
    tree: parentTree(
      g.items.map(({ item }) => item),
      parentOf,
      known,
    ),
  }));
}
