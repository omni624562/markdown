/**
 * 右側欄的分頁（大綱、反向連結、Wiki、助理）：哪些分頁有、現在選哪一頁（不碰畫面，方便測試）。
 */

export type RightTab = "outline" | "backlinks" | "wiki" | "assistant";

/** 分頁由左到右的順序。 */
export const RIGHT_TABS: readonly RightTab[] = ["outline", "backlinks", "wiki", "assistant"];

/** 助理分頁至少要這麼寬才好用（右側欄預設 248px 是給大綱的）。 */
export const ASSISTANT_MIN_WIDTH = 340;

/** 記住的分頁；不認得的當成沒記。 */
export function parseRightTab(raw: string | null): RightTab | null {
  return (RIGHT_TABS as readonly string[]).includes(raw ?? "") ? (raw as RightTab) : null;
}

/**
 * 現在要顯示哪一頁：記住的那一頁還在就用它；不在了就用第一個不是助理的分頁；
 * 只剩助理時回傳 null（助理要使用者自己打開，不會因為設定開了就自動冒出來）。
 */
export function pickRightTab(saved: RightTab | null, available: readonly RightTab[]): RightTab | null {
  if (saved && available.includes(saved)) return saved;
  return available.find((tab) => tab !== "assistant") ?? null;
}
