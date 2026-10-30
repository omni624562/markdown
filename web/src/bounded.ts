/**
 * 有上限的快取：放進 `Map` 時，超過 `max` 筆就刪掉最久沒有更新的。
 * 記工作項目、標題這類資料的快取，開著編輯器一整天也不會一直變大。
 */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  // 先刪再放，更新過的項目排到最後（最晚才被清掉）。
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}
