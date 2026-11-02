/**
 * 常用的項目（專案、Wiki）：選單平常只列出勾成常用的，最下面可以「顯示全部」。不碰畫面，方便測試。
 */

export type Choice = [value: string, label: string];

/** 選單最下面切換「顯示全部／只顯示常用」的選項值（不會和真的值重複）。 */
export const SHOW_ALL = "\u0000all";
export const SHOW_FAVORITES = "\u0000favorites";

export interface FavoriteOptions {
  /** 要列在選單裡的選項。 */
  items: Choice[];
  /** 最下面的切換：`all` 是「顯示全部」，`favorites` 是「只顯示常用」，`null` 是沒有（沒設常用）。 */
  toggle: "all" | "favorites" | null;
  /** 全部有幾個（給「顯示全部（N）」用）。 */
  total: number;
}

/**
 * 選單要列哪些：沒設常用（或常用的都不在清單裡）就全部；有常用時只列常用的，
 * 目前選的不是常用的也留著（不然選單上看不到現在選的是哪個）。順序照原本的清單。
 */
export function favoriteOptions(items: readonly Choice[], favorites: readonly string[], showAll: boolean, current: string | null): FavoriteOptions {
  const fav = new Set(favorites);
  const any = items.some(([v]) => fav.has(v));
  if (!any) return { items: [...items], toggle: null, total: items.length };
  if (showAll) return { items: [...items], toggle: "favorites", total: items.length };
  return { items: items.filter(([v]) => fav.has(v) || v === current), toggle: "all", total: items.length };
}

/** 常用的排在前面（工作項目的專案篩選：選項不藏起來，只是常用的先列）。 */
export function favoritesFirst(items: readonly Choice[], favorites: readonly string[]): Choice[] {
  const fav = new Set(favorites);
  return [...items.filter(([v]) => fav.has(v)), ...items.filter(([v]) => !fav.has(v))];
}

/** 讀存下來的常用清單（壞掉就當沒有）。 */
export function parseFavorites(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
