/**
 * Wiki 頁面樹的排序（不碰畫面，方便測試）：拖曳或「往上移／往下移」時，算出頁面在同一層裡的新位置，
 * 先在畫面上的樹改好（不用等伺服器），失敗時再放回去。
 */

export interface OrderedPage {
  path: string;
  children: OrderedPage[];
}

/** 上層頁面的路徑（最上層頁面是 `""`）。 */
export function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

/** `path` 所在的那一層（同一個上層底下的頁面，依目前的順序）；找不到時回傳 null。 */
export function siblingsOf<T extends OrderedPage>(pages: T[], path: string): T[] | null {
  const walk = (list: OrderedPage[]): OrderedPage[] | null => {
    if (list.some((p) => p.path === path)) return list;
    const up = list.find((p) => path.startsWith(`${p.path}/`));
    return up ? walk(up.children) : null;
  };
  return walk(pages) as T[] | null;
}

/**
 * 把 `path` 拖到 `target` 的前面（`after` 是 false）或後面：在同一層裡的新位置（從 0 算起，是搬完之後的位置）。
 * 不同層、拖到自己或位置沒變時回傳 null。
 */
export function dropIndex(pages: OrderedPage[], path: string, target: string, after: boolean): number | null {
  if (path === target || parentOf(path) !== parentOf(target)) return null;
  const list = siblingsOf(pages, path);
  if (!list) return null;
  const from = list.findIndex((p) => p.path === path);
  const to = list.findIndex((p) => p.path === target);
  if (to < 0) return null;
  let index = after ? to + 1 : to;
  // 先拿掉自己，後面的往前一格。
  if (from < index) index--;
  return index === from ? null : index;
}

/** 把 `path` 移到同一層的第 `index` 個（直接改 `pages`）；回傳原本的位置，找不到時是 -1。 */
export function movePage(pages: OrderedPage[], path: string, index: number): number {
  const list = siblingsOf(pages, path);
  if (!list) return -1;
  const from = list.findIndex((p) => p.path === path);
  const [page] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(index, list.length)), 0, page);
  return from;
}
