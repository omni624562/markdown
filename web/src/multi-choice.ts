/** 多選篩選（類型、專案、區域）的規則：都不勾等於不限，全部勾也等於不限。 */

import { t } from "./i18n.ts";

/**
 * 去掉重複，照選項的順序排（不在選項裡的值保留在後面，例如選項還沒讀到時）；
 * 全部選項都勾了時回傳空的（不限）。
 */
export function normalizeChoice(selected: readonly string[], options: readonly string[]): string[] {
  const picked = [...new Set(selected.map((v) => v.trim()).filter(Boolean))];
  if (options.length > 1 && options.every((o) => picked.includes(o))) return [];
  const rank = (v: string) => {
    const i = options.indexOf(v);
    return i < 0 ? options.length : i;
  };
  return picked.sort((a, b) => rank(a) - rank(b));
}

/** 按鈕上的文字：不限時是 `all`（例如「所有類型」），選一兩個列出名稱，更多時顯示第一個和個數。 */
export function choiceSummary(selected: readonly string[], labelOf: (v: string) => string, all: string): string {
  if (!selected.length) return all;
  const names = selected.map(labelOf);
  if (names.length === 1) return names[0];
  if (names.length === 2) return t("{a}、{b}", { a: names[0], b: names[1] });
  return t("{name} 等 {n} 項", { name: names[0], n: names.length });
}

/** 讀回存起來的值：舊版存的是單一字串（或 null），新版是陣列。 */
export function choiceList(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v] : [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && !!x.trim());
  return [];
}
