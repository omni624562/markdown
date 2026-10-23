/** GitHub 相關的文字處理（不碰畫面，可以單獨測試）。 */
import { t } from "./i18n.ts";

/** GitHub 儲存庫名稱只能用英數字、`.`、`-`、`_`；其他字元換成 `-`。 */
export function repoNameFrom(folder: string): string {
  const name = folder
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
  return name || "notes";
}

/** 「3 天前」這類相對時間（儲存庫清單用）。 */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (Number.isNaN(days)) return "";
  if (days <= 0) return t("今天更新");
  if (days < 30) return t("{n} 天前更新", { n: days });
  if (days < 365) return t("{n} 個月前更新", { n: Math.floor(days / 30) });
  return t("{n} 年前更新", { n: Math.floor(days / 365) });
}
