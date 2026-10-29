/**
 * 工作項目清單「依上層項目分組」：同一個 User Story（或其他上層項目）底下的 Task 放在一組，
 * 組標題是上層項目；清單上本身就有子項目的項目（例如指派給你的 Story）自己當一組的開頭。
 */

export interface GroupItem {
  id: number;
  kind: string;
  title: string;
}

export interface ParentGroup<T> {
  /** 上層項目的編號；沒有上層的那一組是 null。 */
  parent: number | null;
  title: string | null;
  /** 上層項目本身（當這一組的標題列；讀不到時沒有）。 */
  head?: T;
  /** 這一組的子項目（不含上層項目本身）。 */
  items: T[];
}

/**
 * 依上層項目分組，組的順序照清單上第一次出現的位置（清單是最近更新的在前面）。
 * `parentOf` 是每個項目的上層編號（沒有就是 null）；`parents` 是讀到的上層項目（不在清單上的上層用）。
 * 上層項目放在 `head`（清單上本身就有的也一樣，不會在組裡重複出現）。
 * 沒有上層、也不是別人上層的項目放在最後一組（標題是 `none`）。
 * `title` 產生組標題（`item` 是上層項目，讀不到時是 undefined）。
 */
export function groupByParent<T extends GroupItem>(
  items: T[],
  parentOf: Map<number, number | null>,
  parents: Map<number, T>,
  none: string,
  title: (item: GroupItem | undefined, id: number) => string,
): ParentGroup<T>[] {
  const listed = new Map(items.map((it) => [it.id, it]));
  // 清單上有子項目的項目：自己當一組的開頭。
  const heads = new Set<number>();
  for (const it of items) {
    const p = parentOf.get(it.id);
    if (p != null && listed.has(p)) heads.add(p);
  }
  const groups = new Map<number | null, T[]>();
  const order: (number | null)[] = [];
  const add = (key: number | null, it: T) => {
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
      if (key !== null) order.push(key);
    }
    list.push(it);
  };
  for (const it of items) {
    if (heads.has(it.id)) {
      // 清單上的上層項目：只建立這一組（自己當標題列）。
      if (!groups.has(it.id)) {
        groups.set(it.id, []);
        order.push(it.id);
      }
    } else add(parentOf.get(it.id) ?? null, it);
  }
  const out: ParentGroup<T>[] = order.map((key) => {
    const head = listed.get(key!) ?? parents.get(key!);
    return { parent: key, title: title(head, key!), head, items: groups.get(key)! };
  });
  const rest = groups.get(null);
  if (rest?.length) out.push({ parent: null, title: none, items: rest });
  return out;
}
