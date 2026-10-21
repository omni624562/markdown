/**
 * Markdown 表格的資料模型：即時預覽中直接編輯表格時，先把表格拆成儲存格，改好再組回 Markdown
 * （之後交給核心的 formatTable 依中文字寬對齊）。
 */
import { buildRow, splitCells } from "./table.ts";

export type Align = "left" | "center" | "right" | null;

export interface TableModel {
  /** 表格在清單或引言裡時，每一行前面的縮排。 */
  indent: string;
  header: string[];
  aligns: Align[];
  body: string[][];
}

function alignOf(cell: string): Align {
  const c = cell.trim();
  const left = c.startsWith(":");
  const right = c.endsWith(":");
  return left && right ? "center" : left ? "left" : right ? "right" : null;
}

function separator(align: Align): string {
  return align === "center" ? ":---:" : align === "left" ? ":---" : align === "right" ? "---:" : "---";
}

export function parseTable(markdown: string): TableModel {
  const lines = markdown.split("\n").filter((l) => l.trim());
  const indent = lines[0]?.match(/^\s*/)?.[0] ?? "";
  const rows = lines.map((l) => splitCells(l.slice(indent.length)).map((c) => c.text));
  const width = Math.max(1, ...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(Math.max(0, width - r.length)).fill("")].slice(0, width);
  return {
    indent,
    header: pad(rows[0] ?? []),
    aligns: pad(rows[1] ?? []).map(alignOf),
    body: rows.slice(2).map(pad),
  };
}

export function serializeTable(t: TableModel): string {
  return [buildRow(t.header), buildRow(t.aligns.map(separator)), ...t.body.map(buildRow)]
    .map((l) => t.indent + l)
    .join("\n");
}

/** 第 `row` 列（0 是標題列）、第 `col` 欄的原始文字。 */
export function cellText(t: TableModel, row: number, col: number): string {
  return (row === 0 ? t.header : t.body[row - 1])?.[col] ?? "";
}

/** 編輯後的文字放回儲存格：`|` 要跳脫，換行改成 `<br>`。 */
export function toCell(text: string): string {
  return text
    .trim()
    .replace(/\r?\n/g, "<br>")
    .replace(/(?<!\\)\|/g, "\\|");
}

export function setCell(t: TableModel, row: number, col: number, text: string): TableModel {
  const next = structuredClone(t);
  if (row === 0) next.header[col] = toCell(text);
  else if (next.body[row - 1]) next.body[row - 1][col] = toCell(text);
  return next;
}

/** 在第 `row` 列下面插入一列（`row` 是 0 時插在最上面的資料列）。 */
export function insertRow(t: TableModel, row: number): TableModel {
  const next = structuredClone(t);
  next.body.splice(Math.max(0, row), 0, Array(t.header.length).fill(""));
  return next;
}

export function deleteRow(t: TableModel, row: number): TableModel {
  if (row < 1 || row > t.body.length) return t;
  const next = structuredClone(t);
  next.body.splice(row - 1, 1);
  return next;
}

/** 在第 `col` 欄右邊插入一欄。 */
export function insertColumn(t: TableModel, col: number): TableModel {
  const next = structuredClone(t);
  const at = col + 1;
  next.header.splice(at, 0, "");
  next.aligns.splice(at, 0, null);
  for (const r of next.body) r.splice(at, 0, "");
  return next;
}

export function deleteColumn(t: TableModel, col: number): TableModel {
  if (t.header.length <= 1) return t;
  const next = structuredClone(t);
  next.header.splice(col, 1);
  next.aligns.splice(col, 1);
  for (const r of next.body) r.splice(col, 1);
  return next;
}

export function setAlign(t: TableModel, col: number, align: Align): TableModel {
  const next = structuredClone(t);
  next.aligns[col] = align;
  return next;
}
