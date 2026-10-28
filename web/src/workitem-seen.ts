/**
 * 工作項目「上次看過之後有沒有更新」：記住每個項目看過時的最後更新時間（不碰畫面，方便測試）。
 * 第一次使用時，目前清單上的項目都當成看過了，免得全部都標示成新的。
 */

/** 工作項目編號 → 看過時的最後更新時間（毫秒）。 */
export type SeenMap = Record<string, number>;

/** 最多記住幾個項目（超過時先忘掉最舊的）。 */
export const SEEN_LIMIT = 500;

interface Item {
  id: number;
  changed: string | null;
}

export function changedAt(changed: string | null): number {
  const ms = changed ? Date.parse(changed) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/** `new`：指派給你、還沒看過；`updated`：看過之後又有更新。 */
export function markOf(seen: SeenMap | null, item: Item): "new" | "updated" | null {
  if (!seen) return null;
  const at = seen[item.id];
  if (at === undefined) return "new";
  return changedAt(item.changed) > at ? "updated" : null;
}

/**
 * 記下清單上的項目。`mine` 是「指派給你、還沒結束」的清單：上面沒看過的項目要標示成新的；
 * 其他清單（搜尋、看別人的）沒看過的直接當成看過，不然會滿滿都是新的。
 * 回傳新的記錄與有沒有改變（要不要存檔）。
 */
export function remember(seen: SeenMap | null, items: readonly Item[], mine: boolean): { seen: SeenMap; changed: boolean } {
  const first = !seen;
  const out: SeenMap = { ...seen };
  let changed = first;
  for (const it of items) {
    if (out[it.id] === undefined && (first || !mine)) {
      out[it.id] = changedAt(it.changed);
      changed = true;
    }
  }
  return { seen: out, changed };
}

/** 記下「看過了」（開啟項目時）。 */
export function markSeen(seen: SeenMap | null, item: Item): { seen: SeenMap; changed: boolean } {
  const at = changedAt(item.changed);
  if (seen && seen[item.id] !== undefined && seen[item.id] >= at) return { seen, changed: false };
  return { seen: { ...seen, [item.id]: at }, changed: true };
}

/** 只留最近更新的 `limit` 個。 */
export function trimSeen(seen: SeenMap, limit = SEEN_LIMIT): SeenMap {
  const entries = Object.entries(seen);
  if (entries.length <= limit) return seen;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, limit));
}
