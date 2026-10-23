/**
 * 快速輸入日期：打「@今天」「@明天」「@下週一」「@月底」……自動完成成日期，
 * 可以選「2026-10-22（星期四）」「2026-10-22」「民國 115 年 10 月 22 日」「10/22」。
 * 待辦總覽認得這些寫法（截止日）。
 * 關鍵字是中文詞（文件內容），英文介面也一樣；英文介面插入的是英文寫法（2026-10-22 (Thursday)），不提供民國年。
 */
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { currentLang, t } from "./i18n.ts";

const WEEKDAYS = "日一二三四五六"; // i18n-ignore
// 中文的日期關鍵字是輸入的內容，不是介面文字。
const DAY_WORDS: [string, number][] = [
  ["今天", 0], // i18n-ignore
  ["明天", 1], // i18n-ignore
  ["後天", 2], // i18n-ignore
  ["大後天", 3], // i18n-ignore
  ["昨天", -1], // i18n-ignore
  ["前天", -2], // i18n-ignore
];

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** 星期幾（0 是星期日）在以星期一開頭的一週中的位置。 */
const mondayIndex = (day: number) => (day + 6) % 7;

/** 所有關鍵字與對應的日期。 */
export function dateWords(today: Date): [string, Date][] {
  const out: [string, Date][] = DAY_WORDS.map(([w, n]) => [w, addDays(today, n)]);
  const monday = addDays(today, -mondayIndex(today.getDay()));
  for (let i = 0; i < 7; i++) {
    const name = WEEKDAYS[(i + 1) % 7];
    const thisWeek = addDays(monday, i);
    // 「週五」：今天以後最近的星期五（今天就是星期五時是今天）。
    const upcoming = thisWeek < today ? addDays(thisWeek, 7) : thisWeek;
    out.push([`週${name}`, upcoming], [`這週${name}`, thisWeek], [`下週${name}`, addDays(thisWeek, 7)]); // i18n-ignore
  }
  out.push(["下週", addDays(monday, 7)]); // i18n-ignore
  out.push(["月底", new Date(today.getFullYear(), today.getMonth() + 1, 0)]); // i18n-ignore
  out.push(["下個月", new Date(today.getFullYear(), today.getMonth() + 1, 1)]); // i18n-ignore
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * 一個日期可以插入的寫法，第一個是預設。英文介面用英文的星期名稱，不提供民國年；
 * 每一種寫法待辦總覽都認得（截止日）。
 */
export function dateFormats(d: Date): { text: string; label: string }[] {
  if (currentLang() === "en") {
    const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
    return [
      { text: `${iso(d)} (${weekday})`, label: t("日期與星期") },
      { text: iso(d), label: t("日期") },
      { text: `${d.getMonth() + 1}/${d.getDate()}`, label: t("月／日") },
    ];
  }
  // 中文介面插入的中文日期寫法是文件內容。
  const weekday = `星期${WEEKDAYS[d.getDay()]}`; // i18n-ignore
  return [
    { text: `${iso(d)}（${weekday}）`, label: t("日期與星期") }, // i18n-ignore
    { text: iso(d), label: t("日期") },
    { text: `民國 ${d.getFullYear() - 1911} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日（${weekday}）`, label: t("民國年") }, // i18n-ignore
    { text: `${d.getMonth() + 1}/${d.getDate()}`, label: t("月／日") },
  ];
}

/** 把「週」的別名統一：周、星期、禮拜。 */
const normalize = (s: string) => s.replace(/周|星期|禮拜/g, "週").replace("本週", "這週"); // i18n-ignore

export function dateCompletion(ctx: CompletionContext, today = new Date()): CompletionResult | null {
  const m = ctx.matchBefore(/@[一-鿿]{1,5}/);
  if (!m) return null;
  const typed = normalize(m.text.slice(1));
  const words = dateWords(today).filter(([w]) => w.startsWith(typed));
  if (!words.length) return null;
  const options: Completion[] = [];
  if (words.length === 1 || words[0][0] === typed) {
    // 打完整個詞：列出各種寫法。
    const [word, d] = words.find(([w]) => w === typed) ?? words[0];
    dateFormats(d).forEach((f, i) =>
      options.push({ label: `@${word}`, displayLabel: f.text, detail: f.label, apply: f.text, boost: 10 - i }),
    );
  } else {
    for (const [word, d] of words.slice(0, 12)) {
      const f = dateFormats(d)[0];
      options.push({ label: `@${word}`, detail: f.text, apply: f.text });
    }
  }
  return { from: m.from, options, filter: false };
}
