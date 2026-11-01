/**
 * 編輯工作項目欄位用的小工具：標籤的輸入與比較、Sprint 選單的分組。
 */

/** 反覆項目（Sprint）：路徑（`產品\Sprint 3`）與起訖日期（沒有設定時是 null）。 */
export interface Iteration {
  path: string;
  start: string | null;
  finish: string | null;
}

/** 標籤輸入框的文字 → 標籤：逗號、分號、頓號都可以隔開，去掉空白與重複的（不分大小寫）。 */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,;，；、]/)) {
    const tag = raw.trim();
    if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out;
}

/** 兩組標籤是否一樣（不分大小寫與順序）。 */
export function sameTags(a: readonly string[], b: readonly string[]): boolean {
  const norm = (list: readonly string[]) => [...new Set(list.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
  const x = norm(a);
  const y = norm(b);
  return x.length === y.length && x.every((t, i) => t === y[i]);
}

export interface IterationOption {
  /** 完整路徑（送回伺服器的值）。 */
  path: string;
  /** 顯示的名稱：去掉最前面的專案名稱；專案本身（不屬於任何 Sprint）是空字串。 */
  label: string;
  /** 今天在這個 Sprint 的日期之間。 */
  current: boolean;
}

export interface IterationGroup {
  /** `upcoming`：進行中與之後的；`undated`：沒有設定日期；`past`：已結束（最近的在前）。 */
  kind: "upcoming" | "undated" | "past";
  items: IterationOption[];
}

const DAY = 86_400_000;

/** 去掉路徑最前面的專案名稱（`產品\Sprint 3` → `Sprint 3`）。 */
export function iterationLabel(path: string): string {
  const i = path.indexOf("\\");
  return i < 0 ? "" : path.slice(i + 1);
}

/**
 * Sprint 選單的分組：進行中與之後的（依開始日期）、沒有日期的（原本的順序）、已結束的（最近的在前）。
 * 空的組不列出。結束日期當天整天都還算進行中。
 */
export function iterationGroups(list: readonly Iteration[], now: number): IterationGroup[] {
  const time = (s: string | null) => (s ? Date.parse(s) : NaN);
  const upcoming: [number, IterationOption][] = [];
  const undated: IterationOption[] = [];
  const past: [number, IterationOption][] = [];
  for (const it of list) {
    const start = time(it.start);
    const finish = time(it.finish);
    const option = { path: it.path, label: iterationLabel(it.path), current: false };
    if (!Number.isFinite(finish)) undated.push(option);
    else if (finish + DAY <= now) past.push([finish, option]);
    else {
      option.current = !Number.isFinite(start) || start <= now;
      upcoming.push([Number.isFinite(start) ? start : finish, option]);
    }
  }
  const groups: IterationGroup[] = [
    { kind: "upcoming", items: upcoming.sort((a, b) => a[0] - b[0]).map(([, o]) => o) },
    { kind: "undated", items: undated },
    { kind: "past", items: past.sort((a, b) => b[0] - a[0]).map(([, o]) => o) },
  ];
  return groups.filter((g) => g.items.length);
}
