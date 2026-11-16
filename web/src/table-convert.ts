/**
 * 把 Tab 或逗號分隔的文字（從 Excel、Google 試算表、資料庫工具或 CSV 檔複製的）轉成 Markdown 表格。
 * 第一行當標題列；每一行都要拆成同樣的欄數（至少兩欄、兩行），否則不轉。
 */

export type Separator = "\t" | ",";

/** 拆一行 CSV：雙引號包住的欄位裡可以有逗號，`""` 代表一個雙引號。 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && !cell.trim()) {
      cell = "";
      quoted = true;
    } else if (c === ",") {
      out.push(cell);
      cell = "";
    } else cell += c;
  }
  out.push(cell);
  return out;
}

/** 每一行用 `sep` 拆開都是同樣的欄數時回傳各列（儲存格去掉前後空白）；否則 null。 */
export function delimitedRows(text: string, sep: Separator): string[][] | null {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  if (lines.length < 2) return null;
  // 每一行都用 Tab 開頭：是縮排（例如程式碼），不是表格。
  if (sep === "\t" && lines.every((l) => l.startsWith("\t"))) return null;
  const rows = lines.map((l) => (sep === "\t" ? l.split("\t") : splitCsvLine(l)).map((c) => c.trim()));
  const cols = rows[0].length;
  if (cols < 2 || rows.some((r) => r.length !== cols)) return null;
  return rows;
}

/** 組成 Markdown 表格（第一列是標題）；儲存格裡的 `|` 跳脫。 */
export function rowsToTable(rows: string[][]): string {
  const line = (r: string[]) => `| ${r.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
  return [line(rows[0]), line(rows[0].map(() => "---")), ...rows.slice(1).map(line)].join("\n");
}

/** 貼上的純文字是 Tab 分隔的表格（從試算表複製）時，轉成 Markdown 表格；不是時回傳 null。 */
export function pastedTable(plain: string): string | null {
  if (!plain.includes("\t")) return null;
  const rows = delimitedRows(plain, "\t");
  return rows ? rowsToTable(rows) : null;
}

/** 選取的文字轉成表格：有 Tab 就用 Tab 分隔，否則用逗號（CSV）。 */
export function textToTable(text: string): string | null {
  const rows = delimitedRows(text, text.includes("\t") ? "\t" : ",");
  return rows ? rowsToTable(rows) : null;
}

/** 一次最多轉幾列 JSON（太大的資料不適合放進文件裡的表格）。 */
const JSON_MAX_ROWS = 500;

/** JSON 的值放進儲存格：字串照寫、null 空白、物件與陣列寫成 JSON；換行改成空白（表格一列只能一行）。 */
function cellOf(v: unknown): string {
  const s = v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/\r?\n/g, " ");
}

/**
 * 貼上的純文字是 JSON 物件陣列（API 回應、資料庫工具匯出）時轉成 Markdown 表格：欄位是所有物件的鍵，
 * 照第一次出現的順序；沒有那個鍵的格子留空。不是物件陣列、是空陣列、超過 {@link JSON_MAX_ROWS} 列時回傳 null。
 */
export function jsonTable(plain: string): string | null {
  const text = plain.trim();
  if (!text.startsWith("[")) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(data) || !data.length || data.length > JSON_MAX_ROWS) return null;
  if (!data.every((r) => r !== null && typeof r === "object" && !Array.isArray(r))) return null;
  const rows = data as Record<string, unknown>[];
  const keys: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  if (!keys.length) return null;
  return rowsToTable([keys, ...rows.map((r) => keys.map((k) => cellOf(r[k])))]);
}
