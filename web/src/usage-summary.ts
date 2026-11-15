/**
 * 助理用量的摘要：把每天的費用整理成「今天、最近 7 天、這個月、上個月」和最近幾天的清單。
 * 不碰 DOM，可以直接測試。日期（`2026-11-15`）、月份（`2026-11`）都是這台電腦的時區。
 */

export interface UsageHistory {
  today: string;
  month: string;
  /** 這個月的總額（包含還沒有每日紀錄的部分）。 */
  usd: number;
  limit: number;
  days: { date: string; usd: number }[];
  months: { month: string; usd: number }[];
}

export interface UsageSummary {
  today: number;
  last7: number;
  month: number;
  /** 上個月的總額；沒有紀錄時是 null（不是 0：可能是升級之前，沒記到）。 */
  lastMonth: number | null;
  lastMonthName: string;
  /** 最近 `recentDays` 天（由新到舊），沒有用量的那幾天是 0。 */
  recent: { date: string; usd: number }[];
  /** 這個月的總額裡，沒有每日紀錄的部分（升級到有每日紀錄的版本之前用掉的）。 */
  untracked: number;
  /** 最早的一筆每日紀錄；一筆都沒有時是 null。 */
  since: string | null;
}

/** `2026-11-15` 往前（負數）或往後幾天。 */
export function shiftDay(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** 上一個月（`2026-01` → `2025-12`）。 */
export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export function summarize(h: UsageHistory, recentDays = 14): UsageSummary {
  const byDay = new Map(h.days.map((d) => [d.date, d.usd]));
  const sum = (dates: string[]) => dates.reduce((n, d) => n + (byDay.get(d) ?? 0), 0);
  const back = (n: number) => Array.from({ length: n }, (_, i) => shiftDay(h.today, -i));
  const lastMonthName = previousMonth(h.month);
  const tracked = h.days.filter((d) => d.date.startsWith(`${h.month}-`)).reduce((n, d) => n + d.usd, 0);
  const stored = h.months.find((m) => m.month === lastMonthName);
  // 上個月：優先用換月時收起來的總額；沒有的話用那個月的每日紀錄加起來（都沒有就是沒記到）。
  const lastMonthDays = h.days.filter((d) => d.date.startsWith(`${lastMonthName}-`));
  const lastMonth = stored ? stored.usd : lastMonthDays.length ? lastMonthDays.reduce((n, d) => n + d.usd, 0) : null;
  const untracked = h.usd - tracked;
  return {
    today: byDay.get(h.today) ?? 0,
    last7: sum(back(7)),
    month: h.usd,
    lastMonth,
    lastMonthName,
    recent: back(recentDays).map((date) => ({ date, usd: byDay.get(date) ?? 0 })),
    // 浮點數加總的誤差不算。
    untracked: untracked > 0.005 ? untracked : 0,
    since: h.days.length ? h.days.reduce((a, d) => (d.date < a ? d.date : a), h.days[0].date) : null,
  };
}
