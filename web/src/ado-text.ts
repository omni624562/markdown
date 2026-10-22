/** Azure DevOps 相關的文字處理（不碰畫面，方便測試）。 */
import type { AdoWorkItem } from "./desktop.ts";

/** 插入文件用的工作項目連結：`[#123 標題](網址)`。 */
export function workItemLink(item: Pick<AdoWorkItem, "id" | "title" | "webUrl">): string {
  const title = item.title.replace(/[\\[\]]/g, "\\$&").replace(/\s+/g, " ").trim();
  // 網址裡的括號與空白會讓 Markdown 連結提早結束。
  const url = item.webUrl.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  return `[#${item.id}${title ? ` ${title}` : ""}](${url})`;
}

/** 網址是 http:// 時提醒權杖會用沒加密的連線傳送。 */
export function isInsecureUrl(url: string): boolean {
  return /^http:\/\//i.test(url.trim());
}
