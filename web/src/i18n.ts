/**
 * 介面語言。以繁體中文原文當作鍵：`t("下一個")`；英文介面時查 `locales/en`，查不到就顯示中文。
 * 參數寫成 `{name}`：`t("已開啟「{name}」", { name })`。英文需要單複數時，翻譯寫成
 * `["{n} result", "{n} results"]`，依 `n`（或 `count`）是不是 1 選一個。
 *
 * 語言在啟動時決定（設定的「介面語言」，預設跟隨系統），切換後重新載入介面。
 * 選擇存在 localStorage（`ui-lang`），讓所有模組載入時就能同步讀到。
 */
import { en, type Translation } from "./locales/en.ts";
import * as storage from "./storage.ts";

export type LangPref = "system" | "zh-TW" | "en";
export type Lang = "zh-TW" | "en";


/** 依設定與系統語言決定介面語言：中文（任何地區）用繁體中文，其他語言用英文。 */
export function resolveLang(pref: string | null, systemLangs: readonly string[]): Lang {
  if (pref === "zh-TW" || pref === "en") return pref;
  const first = systemLangs.find(Boolean) ?? "zh-TW";
  return /^zh\b/i.test(first) ? "zh-TW" : "en";
}

function systemLangs(): readonly string[] {
  // Node 22 也有 navigator（en-US）：不在瀏覽器裡（單元測試）時一律用中文，測試結果才不會隨環境改變。
  if (typeof document === "undefined" || typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

export function langPref(): LangPref {
  const p = storage.load("ui-lang");
  return p === "zh-TW" || p === "en" ? p : "system";
}

export function setLangPref(pref: LangPref): void {
  if (pref === "system") storage.remove("ui-lang");
  else storage.save("ui-lang", pref);
}

let lang: Lang = resolveLang(langPref(), systemLangs());

/** 目前的介面語言。 */
export function currentLang(): Lang {
  return lang;
}

/** 設定裡的選項。語言名稱一律用該語言本身寫（看不懂目前語言的人也找得到）。 */
export function langPrefs(): { id: LangPref; label: string }[] {
  return [
    { id: "system", label: t("跟隨系統") },
    { id: "zh-TW", label: "繁體中文" }, // i18n-ignore
    { id: "en", label: "English" },
  ];
}

/** 測試用：直接指定語言。 */
export function useLang(l: Lang): void {
  lang = l;
}

function fill(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

function pick(tr: Translation, params?: Record<string, string | number>): string {
  if (typeof tr === "string") return tr;
  const n = params?.n ?? params?.count;
  return Number(n) === 1 ? tr[0] : tr[1];
}

/** 翻譯介面文字（`zh` 是繁體中文原文）。 */
export function t(zh: string, params?: Record<string, string | number>): string {
  const tr = lang === "en" ? en[zh] : undefined;
  return fill(tr === undefined ? zh : pick(tr, params), params);
}

const CJK = /[㐀-鿿＀-￯　-〿]/;
const ATTRS = ["title", "aria-label", "placeholder", "alt"];

/** 翻譯一段靜態 HTML（index.html）：文字與 title、aria-label、placeholder 屬性。 */
export function translateDom(root: ParentNode): void {
  if (lang !== "en") return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    const key = text.trim();
    if (!key || !CJK.test(key)) continue;
    const tr = en[key];
    if (tr !== undefined) node.nodeValue = text.replace(key, pick(tr));
  }
  for (const el of root.querySelectorAll<HTMLElement>(ATTRS.map((a) => `[${a}]`).join(","))) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      const tr = v && CJK.test(v) ? en[v] : undefined;
      if (tr !== undefined) el.setAttribute(a, pick(tr));
    }
  }
}
