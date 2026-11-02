/**
 * 錯誤紀錄：最近發生的錯誤（哪裡、什麼時候、訊息與呼叫堆疊）記在記憶體裡，
 * 「複製錯誤紀錄」時整理成一段文字，方便回報問題。不碰畫面，方便測試。
 */

export interface ErrorEntry {
  at: number;
  /** 在哪裡發生（例如「預覽：workitem-chips」「工作項目畫面」「未處理的錯誤」）。 */
  where: string;
  message: string;
  stack: string | null;
}

/** 最多記幾筆（太舊的先丟掉）。 */
export const ERROR_LOG_LIMIT = 50;

const entries: ErrorEntry[] = [];
const listeners = new Set<(e: ErrorEntry) => void>();

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

/** 記下一個錯誤；回傳記下的那一筆。 */
export function logError(where: string, e: unknown, now: number = Date.now()): ErrorEntry {
  const entry: ErrorEntry = {
    at: now,
    where,
    message: errorMessage(e),
    stack: e instanceof Error && e.stack ? e.stack : null,
  };
  entries.push(entry);
  if (entries.length > ERROR_LOG_LIMIT) entries.splice(0, entries.length - ERROR_LOG_LIMIT);
  for (const fn of listeners) fn(entry);
  return entry;
}

export function errorEntries(): readonly ErrorEntry[] {
  return entries;
}

export function clearErrorLog(): void {
  entries.length = 0;
}

/** 有新的錯誤時呼叫（例如顯示提示）。 */
export function onError(fn: (e: ErrorEntry) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 整理成可以貼到回報裡的文字（新的在後面；`header` 放版本等資訊）。 */
export function errorLogText(header: string[] = [], list: readonly ErrorEntry[] = entries): string {
  const lines = [...header];
  if (header.length) lines.push("");
  for (const e of list) {
    lines.push(`[${new Date(e.at).toISOString()}] ${e.where}: ${e.message}`);
    if (e.stack) lines.push(...e.stack.split("\n").slice(0, 8).map((l) => `    ${l.trim()}`));
  }
  return lines.join("\n");
}

/** 不需要讓使用者知道的錯誤（瀏覽器的雜訊、使用者自己取消的動作）。 */
export function isNoise(e: unknown): boolean {
  const name = e instanceof Error ? e.name : "";
  const message = errorMessage(e);
  return name === "AbortError" || /ResizeObserver loop/i.test(message) || /^Script error\.?$/i.test(message);
}
