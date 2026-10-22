/** 自訂字型：整理使用者輸入的字型名稱，以及列出可以挑選的字型。 */
import { desktop } from "./desktop.ts";

export interface FontChoice {
  /** 寫進 CSS 的字型名稱。 */
  name: string;
  /** 顯示用的中文名稱（例如「微軟正黑體」）。 */
  label?: string;
  mono?: boolean;
}

/** 字型名稱最長幾個字。 */
export const FONT_NAME_LIMIT = 80;

/** 沒辦法讀取電腦字型清單時（網頁版）提供的常見字型。 */
export const COMMON_FONTS: readonly FontChoice[] = [
  { name: "Microsoft JhengHei", label: "微軟正黑體" },
  { name: "PMingLiU", label: "新細明體" },
  { name: "DFKai-SB", label: "標楷體" },
  { name: "Noto Sans TC", label: "思源黑體" },
  { name: "Noto Serif TC", label: "思源宋體" },
  { name: "LXGW WenKai TC", label: "霞鶩文楷" },
  { name: "PingFang TC", label: "蘋方" },
  { name: "Sarasa Mono TC", label: "更紗黑體（等寬）", mono: true },
  { name: "Cascadia Code", mono: true },
  { name: "Consolas", mono: true },
  { name: "JetBrains Mono", mono: true },
  { name: "Fira Code", mono: true },
];

/** 去掉字型名稱裡會破壞 CSS 的字元（引號、反斜線、分號、大括號與控制字元）。 */
export function cleanFontName(name: string): string {
  return name
    .replace(/[\p{Cc}"'\\;{}<>]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FONT_NAME_LIMIT);
}

/** 自訂字型放在最前面，後面接原本的字型（沒有安裝或缺字時用）；沒有自訂時回傳空字串。 */
export function fontStack(name: string, fallback: string): string {
  const clean = cleanFontName(name);
  return clean ? `"${clean}", ${fallback}` : "";
}

let cached: Promise<FontChoice[]> | null = null;

/** 電腦上安裝的字型；讀不到時改用常見字型清單。 */
export function installedFonts(): Promise<FontChoice[]> {
  cached ??= load().catch((e) => {
    console.error(e);
    return [...COMMON_FONTS];
  });
  return cached;
}

// 網頁版不用瀏覽器的 queryLocalFonts：一點字型欄位就跳出權限詢問太突兀，直接提供常見字型，也可以自己輸入名稱。
async function load(): Promise<FontChoice[]> {
  const list = desktop ? await desktop.listFonts() : [];
  return list.length ? list : [...COMMON_FONTS];
}
