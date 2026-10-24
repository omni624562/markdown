/** Git 歷史畫面用到的文字與計算（頭像縮寫、網頁連結、活動統計），不碰畫面，方便測試。 */

const CJK = /[㐀-鿿豈-﫿]/;

/** 頭像上的縮寫：中文名字取第一個字，英文名字取前兩個字的字首。 */
export function initials(name: string): string {
  const n = name.trim();
  if (!n) return "?";
  if (CJK.test(n[0])) return n[0];
  const words = n.split(/[\s._-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : n.slice(0, 2)).toUpperCase();
}

/** 依 Email（沒有就用名字）固定挑一個顏色（0–7）。 */
export function colorIndex(key: string): number {
  let h = 0;
  for (const ch of key.toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 8;
}

/** 去掉遠端網址裡的帳號密碼與結尾的 `.git`。只接受 https。 */
function cleanRemote(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const path = u.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
  return `https://${u.host}${path}`;
}

/** 提交在 GitHub、Azure DevOps 網頁上的網址；其他遠端回傳 null。 */
export function commitWebUrl(remote: string | null | undefined, id: string): string | null {
  if (!remote) return null;
  const base = cleanRemote(remote);
  if (!base) return null;
  const host = new URL(base).host.toLowerCase();
  if (host === "github.com" || base.includes("/_git/")) return `${base}/commit/${id}`;
  return null;
}

export interface StatInput {
  author: string;
  time: number;
  offset: number;
}

export interface ActivityDay {
  /** YYYY-MM-DD（提交當地的日期）。 */
  date: string;
  count: number;
}

export interface Activity {
  /** 依週分欄（星期日開始），最右邊是這一週；每欄 7 天，未來的日子是 null。欄數見 `activity()`。 */
  weeks: (ActivityDay | null)[][];
  /** 一天最多幾個提交（決定顏色深淺）。 */
  max: number;
  total: number;
  /** 提交數最多的作者，最多 `limit` 位。 */
  authors: { name: string; count: number }[];
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/**
 * 每天的提交數，與提交最多的作者。`today` 是使用者這邊的今天。
 * 從最早的提交那一週開始畫（新的儲存庫不用畫一整年的空格子），最少 `minWeeks` 週、最多 `maxWeeks` 週。
 */
export function activity(commits: StatInput[], today: Date, maxWeeks = 53, limit = 5, minWeeks = 8): Activity {
  const perDay = new Map<string, number>();
  const perAuthor = new Map<string, number>();
  for (const c of commits) {
    const key = ymd(new Date((c.time + c.offset * 60) * 1000));
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
    perAuthor.set(c.author, (perAuthor.get(c.author) ?? 0) + 1);
  }
  // 用 UTC 的日期計算，避免夏令時間讓某些天重複或消失。
  const end = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const DAY = 86_400_000;
  const thisWeek = end.getTime() - end.getUTCDay() * DAY;
  const first = [...perDay.keys()].sort()[0];
  const firstDay = first ? new Date(Date.parse(first)) : null;
  const firstWeek = firstDay ? firstDay.getTime() - firstDay.getUTCDay() * DAY : thisWeek;
  const span = first ? Math.round((thisWeek - firstWeek) / (7 * DAY)) + 1 : 0;
  const weeks = Math.max(Math.min(minWeeks, maxWeeks), Math.min(maxWeeks, span));
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - end.getUTCDay() - (weeks - 1) * 7);
  const grid: (ActivityDay | null)[][] = [];
  let max = 0;
  let total = 0;
  for (let w = 0; w < weeks; w++) {
    const col: (ActivityDay | null)[] = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(start);
      day.setUTCDate(start.getUTCDate() + w * 7 + d);
      if (day > end) {
        col.push(null);
        continue;
      }
      const date = ymd(day);
      const count = perDay.get(date) ?? 0;
      max = Math.max(max, count);
      total += count;
      col.push({ date, count });
    }
    grid.push(col);
  }
  const authors = [...perAuthor].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, limit);
  return { weeks: grid, max, total, authors };
}

/** 熱度圖的顏色等級（0 是沒有提交，1–4 越來越深）。 */
export function level(count: number, max: number): number {
  if (!count || !max) return 0;
  return Math.min(4, Math.ceil((count / max) * 4));
}
