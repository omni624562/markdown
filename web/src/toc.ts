/**
 * 目錄：在 `<!-- toc -->` 與 `<!-- /toc -->` 之間產生標題連結清單。
 * 這兩行是 HTML 註解，預覽與匯出時不會顯示；存檔時自動更新。
 */

import { t } from "./i18n.ts";

export const TOC_START = "<!-- toc -->";
export const TOC_END = "<!-- /toc -->";

export interface TocHeading {
  level: number;
  /** 錨點（和預覽中標題的 id 相同，由核心產生）。 */
  id: string;
  text: string;
}

/**
 * 標題清單轉成巢狀的 Markdown 清單。只有一個一級標題而且在最前面時，視為文件標題，不列入目錄。
 * 錨點保留中文（GitHub、Obsidian 也是這樣寫），只編碼會讓連結斷掉的字元。
 */
export function tocList(headings: TocHeading[]): string {
  let list = headings.filter((h) => h.text.trim());
  const h1 = list.filter((h) => h.level === 1);
  if (h1.length === 1 && list[0] === h1[0]) list = list.slice(1);
  if (!list.length) return "";
  const top = Math.min(...list.map((h) => h.level));
  return list
    .map((h) => `${"  ".repeat(h.level - top)}- [${h.text.replace(/([[\]\\])/g, "\\$1")}](#${h.id.replace(/[\s()<>]/g, encodeURIComponent)})`)
    .join("\n");
}

/** 插入用的完整目錄區塊。 */
export function tocBlock(headings: TocHeading[]): string {
  const list = tocList(headings) || t("（文件中還沒有標題）");
  return `${TOC_START}\n${list}\n${TOC_END}`;
}

/** 文件中有目錄區塊時，換成最新的目錄；沒有目錄或已經是最新時回傳 null。 */
export function updateToc(text: string, headings: TocHeading[]): string | null {
  const start = text.indexOf(TOC_START);
  if (start < 0) return null;
  const end = text.indexOf(TOC_END, start + TOC_START.length);
  if (end < 0) return null;
  const next = text.slice(0, start) + tocBlock(headings) + text.slice(end + TOC_END.length);
  return next === text ? null : next;
}
