/**
 * 檔案的 Markdown 連結（檔案面板右鍵「插入連結」用）：路徑相對於目前的文件，算不出來（沒有文件、不同磁碟）時用完整路徑；
 * 含空白或括號時用角括號包起來。純函式，沒有 DOM。
 */
import { basename, dirname, relativePath } from "./paths.ts";

export function fileLink(filePath: string, docPath: string | null | undefined): string {
  const target = (docPath && relativePath(dirname(docPath), filePath)) || filePath.replace(/\\/g, "/");
  const url = /[\s()]/.test(target) ? `<${target}>` : target;
  return `[${basename(filePath).replace(/[[\]]/g, "")}](${url})`;
}
