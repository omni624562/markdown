/**
 * 文件統計的計算（不碰畫面，方便測試）：朗讀時間、字數目標的進度、「今天寫了多少」的起點。
 * 字數本身由 md-core（Rust）算好：中日韓文字一字算一個，英文以單字計。
 */

/** 朗讀速度：中文每分鐘約 240 字，英文每分鐘約 150 個單字（簡報、會議報告的語速）。 */
const SPEAK_CJK_PER_MIN = 240;
const SPEAK_LATIN_PER_MIN = 150;

/** 朗讀時間（分鐘，無條件進位；有內容時至少 1 分鐘）。 */
export function speakingMinutes(stats: { latinWords: number; cjkChars: number }): number {
  const minutes = stats.cjkChars / SPEAK_CJK_PER_MIN + stats.latinWords / SPEAK_LATIN_PER_MIN;
  return minutes > 0 ? Math.max(1, Math.ceil(minutes)) : 0;
}

/** 字數目標的範圍。 */
export const GOAL_MIN = 1;
export const GOAL_MAX = 10_000_000;

/**
 * 使用者輸入的目標：可以有千分位逗號、空白，或寫「2千」「1.5萬」「3k」。
 * 空白代表清除（回傳 null）；看不懂或超出範圍時回傳 undefined。
 */
export function parseGoal(input: string): number | null | undefined {
  const s = input.replace(/[\s,，_]/g, "").toLowerCase();
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)(k|千|萬|万)?字?$/.exec(s);
  if (!m) return undefined;
  const unit = m[2] === "k" || m[2] === "千" ? 1000 : m[2] ? 10_000 : 1; // i18n-ignore（中文的數量單位）
  const n = Math.round(Number(m[1]) * unit);
  return Number.isFinite(n) && n >= GOAL_MIN && n <= GOAL_MAX ? n : undefined;
}

export interface GoalProgress {
  /** 0～1（超過目標也是 1）。 */
  ratio: number;
  /** 還差幾字（達成時是 0）。 */
  left: number;
  reached: boolean;
}

export function goalProgress(words: number, goal: number): GoalProgress {
  const ratio = goal > 0 ? Math.min(1, words / goal) : 0;
  return { ratio, left: Math.max(0, goal - words), reached: words >= goal };
}

/** 這次更新是不是剛好跨過目標（從沒達成變成達成）：只在同一份文件繼續寫的時候提示。 */
export function justReached(before: number | null, after: number, goal: number | undefined): boolean {
  return !!goal && before !== null && before < goal && after >= goal;
}

/** 本機日期（YYYY-MM-DD）。 */
export function dayOf(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** 每份文件今天第一次打開時的字數（`d` 日期、`s` 字數）。 */
export type TodayMap = Record<string, { d: string; s: number }>;

/**
 * 記下 `key` 今天的起點（已經有今天的就沿用），並清掉不是今天的紀錄。
 * `changed` 表示要存回去（第一次記、或清掉了舊的）。
 */
export function trackToday(map: TodayMap, key: string, words: number, today: string): { map: TodayMap; start: number; changed: boolean } {
  const existing = map[key];
  if (existing && existing.d === today) return { map, start: existing.s, changed: false };
  const next: TodayMap = {};
  for (const [k, v] of Object.entries(map)) if (v.d === today) next[k] = v;
  next[key] = { d: today, s: words };
  return { map: next, start: words, changed: true };
}

/** 記住最多幾份文件的字數目標（超過時丟掉最舊設定的）。 */
export const GOAL_LIMIT = 300;

/** 設定（`goal` 是 null 時清除）某份文件的目標，回傳新的對照表；最近設定的排在最後。 */
export function withGoal(goals: Record<string, number>, key: string, goal: number | null): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [k, v] of Object.entries(goals)) if (k !== key && Number.isInteger(v) && v >= GOAL_MIN) next[k] = v;
  if (goal !== null) next[key] = goal;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - GOAL_LIMIT))) delete next[k];
  return next;
}
