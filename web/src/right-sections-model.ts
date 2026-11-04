/**
 * 右側欄分區（大綱、反向連結、Wiki）的收合狀態與分隔線位置（不碰畫面，方便測試）。
 */

export type RightSection = "outline" | "backlinks" | "wiki";

/** 分區由上到下的順序。 */
export const RIGHT_SECTIONS: readonly RightSection[] = ["outline", "backlinks", "wiki"];

/**
 * 分隔線：`ratio` 是上面那一塊（大綱與反向連結）占兩塊加起來的高度的比例。
 * `minTop`、`minBottom` 是上下至少留多高（像素，標題列加上幾列內容），`step`／`bigStep` 是方向鍵（加 Shift）一次移多少像素。
 */
export const SPLIT = { default: 0.5, min: 0.1, max: 0.9, minTop: 96, minBottom: 120, step: 16, bigStep: 48 } as const;

/** 記住的收合狀態：逗號分隔的分區名稱；不認得的略過。 */
export function parseCollapsed(raw: string | null): Set<RightSection> {
  const names = new Set((raw ?? "").split(",").map((s) => s.trim()));
  return new Set(RIGHT_SECTIONS.filter((s) => names.has(s)));
}

/** 要記住的收合狀態（依分區的順序，同樣的狀態一定是同一串字）。 */
export function formatCollapsed(collapsed: ReadonlySet<RightSection>): string {
  return RIGHT_SECTIONS.filter((s) => collapsed.has(s)).join(",");
}

/** 記住的分隔線位置；沒有記過或不合理時用預設值。 */
export function parseSplit(raw: string | null): number {
  const n = raw === null || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) return SPLIT.default;
  return round(Math.min(SPLIT.max, Math.max(SPLIT.min, n)));
}

/**
 * 依兩塊加起來的高度（`total`，像素）限制比例：上下都至少留 `minTop`／`minBottom`，也不超出 `min`～`max`。
 * 高度連最小值都放不下時，照最小值的比例分。
 */
export function clampSplit(ratio: number, total: number): number {
  const r = Number.isFinite(ratio) ? ratio : SPLIT.default;
  if (!(total > 0)) return round(Math.min(SPLIT.max, Math.max(SPLIT.min, r)));
  const lo = Math.max(SPLIT.min, SPLIT.minTop / total);
  const hi = Math.min(SPLIT.max, 1 - SPLIT.minBottom / total);
  if (lo > hi) return round(SPLIT.minTop / (SPLIT.minTop + SPLIT.minBottom));
  return round(Math.min(hi, Math.max(lo, r)));
}

/** 方向鍵：上面那一塊變高或變矮 `px` 像素（負的是往上）。 */
export function stepSplit(ratio: number, px: number, total: number): number {
  return clampSplit(total > 0 ? ratio + px / total : ratio, total);
}

/** 存起來的比例只留三位小數。 */
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
