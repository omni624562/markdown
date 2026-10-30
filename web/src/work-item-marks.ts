/**
 * 工作項目內文裡常見的兩種標記（例如 COMET AI 協作摘要）：
 * - 標籤行：`AI-CodeGen / Copilot / AIState-delivered / HumanAction-review` 這種用「 / 」分開的英文代號。
 * - 檔案：整段只有一個檔案路徑或檔名（`.comet/reports/20261005-task-1911359.md`），
 *   或「附件：檔名」「詳細報告：路徑」。
 * 這裡只判斷文字（不碰畫面，方便測試）；畫面在 ui/work-item-marks.ts。
 */

/** 整行是「代號 / 代號 / 代號」（至少三個，代號是不含空白的英數字、`-`、`_`、`.`、`+`）時回傳代號。 */
export function tagLine(text: string): string[] | null {
  const line = text.trim();
  if (!/\s\/\s/.test(line)) return null;
  const parts = line.split(/\s+\/\s+/);
  if (parts.length < 3 || parts.length > 12) return null;
  return parts.every((p) => /^[A-Za-z][\w.+-]{0,39}$/.test(p)) ? parts : null;
}

/** 檔案路徑或檔名（有副檔名，沒有空白）。 */
const FILE = /^(?:\.{0,2}[\w.-]*\/)*[\w.-]*[\w-]\.[A-Za-z0-9]{1,6}$/;

/**
 * 整段是一個檔案（可以帶「附件：」這類短標籤）時回傳標籤與路徑。
 * 網址、版本號（1.2.3）、純數字不算。
 */
export function fileLine(text: string): { label: string; path: string } | null {
  const line = text.trim();
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(line)) return null;
  const m = /^(?:([^：:]{1,12})[：:]\s*)?(\S+)$/.exec(line);
  if (!m) return null;
  const path = m[2];
  if (!FILE.test(path) || /^\d+(\.\d+)+$/.test(path)) return null;
  return { label: m[1]?.trim() ?? "", path };
}

/** 路徑的檔名部分。 */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** 標籤的色相（同一個代號每次都一樣）。 */
export function tagHue(tag: string): number {
  let h = 0;
  for (const c of tag.toLowerCase()) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return h % 360;
}
