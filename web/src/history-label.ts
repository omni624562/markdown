/** 版本記錄的時間顯示（台灣的日期格式，加上「幾分鐘前」）。 */

const absolute = new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" });
const relative = new Intl.RelativeTimeFormat("zh-TW", { numeric: "auto" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

export function timeAgo(ms: number, now = Date.now()): string {
  const seconds = Math.round((ms - now) / 1000);
  if (Math.abs(seconds) < 60) return "剛剛";
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return "剛剛";
}

export function versionTitle(ms: number, now = Date.now()): string {
  return `${absolute.format(ms)}（${timeAgo(ms, now)}）`;
}

export function sizeLabel(bytes: number): string {
  return bytes < 1024 ? `${bytes} 位元組` : `${(bytes / 1024).toFixed(1)} KB`;
}
