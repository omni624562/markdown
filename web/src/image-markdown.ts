/**
 * 圖片的 Markdown 語法（檔案面板的圖片分頁「插入連結」用）。純函式，沒有 DOM。
 */
import { basename, dirname, relativePath } from "./paths.ts";

/** Markdown 圖片語法：從目前文件所在的資料夾算相對路徑（沒有文件、不同磁碟時用完整路徑）；`(`、`)`、空白要跳脫。 */
export function imageMarkdown(imagePath: string, docPath: string | null | undefined): string {
  const target = (docPath && relativePath(dirname(docPath), imagePath)) || imagePath.replace(/\\/g, "/");
  const url = /[\s()]/.test(target) ? `<${target}>` : target;
  const name = basename(imagePath).replace(/\.[^.]+$/, "");
  return `![${name.replace(/[[\]]/g, "")}](${url})`;
}

