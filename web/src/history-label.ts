/** 版本記錄的時間顯示（依介面語言的日期格式，加上「幾分鐘前」）。 */
import { currentLang, t } from "./i18n.ts";

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** 日期格式跟著介面語言（中文介面用台灣的格式）。 */
function locale(): string {
  return currentLang() === "en" ? "en-US" : "zh-TW";
}

let formatters: { lang: string; absolute: Intl.DateTimeFormat; relative: Intl.RelativeTimeFormat } | null = null;

function format(): { absolute: Intl.DateTimeFormat; relative: Intl.RelativeTimeFormat } {
  const lang = locale();
  if (formatters?.lang !== lang) {
    formatters = {
      lang,
      absolute: new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }),
      relative: new Intl.RelativeTimeFormat(lang, { numeric: "auto" }),
    };
  }
  return formatters;
}

export function timeAgo(ms: number, now = Date.now()): string {
  const seconds = Math.round((ms - now) / 1000);
  if (Math.abs(seconds) < 60) return t("剛剛");
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format().relative.format(Math.round(seconds / size), unit);
  }
  return t("剛剛");
}

export function versionTitle(ms: number, now = Date.now()): string {
  return t("{time}（{ago}）", { time: format().absolute.format(ms), ago: timeAgo(ms, now) });
}

export function sizeLabel(bytes: number): string {
  return bytes < 1024 ? t("{n} 位元組", { n: bytes }) : `${(bytes / 1024).toFixed(1)} KB`;
}
