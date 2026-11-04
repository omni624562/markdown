/**
 * 工作項目清單「依上層項目分組」：排成一棵樹（Epic → Feature → User Story → Task），每一項只出現一次，
 * 在它的上層底下；不在清單上的上層（例如不是指派給你的 Feature）也列出來當標題列（淡色、不算數）。
 */

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
