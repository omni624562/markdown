/**
 * 一起改好幾個工作項目（不碰畫面，方便測試）：共同的狀態、每一個要送出的變更。
 */
import type { AdoWorkItem, AdoWorkItemChange } from "./desktop.ts";

/** 每一組（專案、類型）都有的狀態，依第一組的順序。 */
export function commonStates(lists: readonly string[][]): string[] {
  if (!lists.length) return [];
  return lists[0].filter((s) => lists.every((l) => l.includes(s)));
}

/** 這個工作項目要送出的變更（狀態和現在一樣就不送）；沒有要改的回傳 null。 */
export function changeFor(item: AdoWorkItem, change: AdoWorkItemChange): AdoWorkItemChange | null {
  const out: AdoWorkItemChange = { ...change };
  if (out.state === item.state) delete out.state;
  if (out.priority !== undefined && out.priority === item.priority) delete out.priority;
  return Object.keys(out).length ? out : null;
}
