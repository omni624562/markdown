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

/**
 * Azure DevOps 儲存庫的名稱（預設用資料夾名稱）：可以用中文與空白，但不能有 `\ / : * ? " < > | ; # $ { } , + = [ ]`
 * 與控制字元（換成 `-`），不能用 `_` 或 `.` 開頭、`.` 結尾，最多 64 個字。
 */
export function adoRepoNameFrom(folder: string): string {
  const name = [...folder.normalize("NFC").replace(/[\\/:*?"<>|;#$\{\},+=\[\]\u0000-\u001f\u007f]+/g, "-")]
    .slice(0, 64)
    .join("")
    .replace(/-{2,}/g, "-")
    .replace(/^[\s._-]+|[\s.-]+$/g, "");
  return name || "notes";
}
