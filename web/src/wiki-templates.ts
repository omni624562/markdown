/**
 * 新 Wiki 頁面的範本（不碰畫面，方便測試）：Wiki 最上層名為「範本」或「Templates」的頁面底下的子頁面
 * 當成這個 Wiki 共用的範本；範本裡的 {{標題}}（{{title}}）換成新頁面的標題，日期等變數同文件範本。
 */
import { fillTemplate } from "./templates.ts";

/** 放共用範本的最上層頁面名稱（不分大小寫；頁面名稱是使用者取的，不翻譯）。 */
// i18n-ignore
const FOLDERS = ["範本", "templates", ".templates"];

/** Wiki 裡放範本的最上層頁面（例如 `/範本`）；沒有時回傳 null。 */
export function wikiTemplateFolder(paths: readonly string[]): string | null {
  return paths.find((p) => /^\/[^/]+$/.test(p) && FOLDERS.includes(p.slice(1).toLowerCase())) ?? null;
}

/** 範本頁面：放範本的頁面底下的直接子頁面，依名稱排。 */
export function wikiTemplatePages(paths: readonly string[], folder: string): string[] {
  const prefix = `${folder}/`;
  return paths
    .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
    .sort((a, b) => a.localeCompare(b));
}

/** 新頁面的內容：沒有範本時只有標題；有範本時換掉 {{標題}} 與日期等變數。 */
export function newPageBody(title: string, template: string | null, now = new Date()): string {
  if (template === null || !template.trim()) return `# ${title}\n\n`;
  return fillTemplate(
    template.replace(/\{\{\s*(?:標題|title)\s*\}\}/g, () => title),
    now,
  );
}
