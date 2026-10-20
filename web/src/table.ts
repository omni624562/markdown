/**
 * Markdown 表格編輯：Tab／Shift+Tab 在儲存格間移動、Enter 新增列、插入或刪除欄列。
 * 每次操作後都用 Rust 核心的 formatTable 依東亞字寬重新對齊。
 */
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type StateCommand } from "@codemirror/state";

export type Formatter = (block: string) => string | undefined;

interface Cell {
  /** 儲存格（含前後空白）在該行中的起訖位置。 */
  from: number;
  to: number;
  text: string;
}

/** 拆出一行表格的儲存格；跳脫的 `\|` 與行內程式碼裡的 `|` 不算分隔線。 */
export function splitCells(line: string): Cell[] {
  const bars: number[] = [];
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") i++;
    else if (c === "`") inCode = !inCode;
    else if (c === "|" && !inCode) bars.push(i);
  }
  const lead = line.trimStart();
  const starts = lead.startsWith("|") ? bars : [-1, ...bars];
  const cells: Cell[] = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k] + 1;
    const to = k + 1 < starts.length ? starts[k + 1] : line.length;
    // 結尾的 `|` 之後如果只剩空白，不算一欄。
    if (k + 1 === starts.length && line.slice(from).trim() === "" && starts.length > 1) break;
    cells.push({ from, to, text: line.slice(from, to).trim() });
  }
  return cells;
}

export function buildRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

/** 在一行內，`pos` 落在第幾格。 */
export function cellIndexAt(line: string, pos: number): number {
  const cells = splitCells(line);
  const i = cells.findIndex((c) => pos <= c.to);
  return i < 0 ? cells.length - 1 : i;
}

/** 儲存格內文字的範圍（去掉前後空白）；空的儲存格回傳中間一點。 */
function contentRange(line: string, cell: Cell): { from: number; to: number } {
  const raw = line.slice(cell.from, cell.to);
  const lead = raw.length - raw.trimStart().length;
  const text = raw.trim();
  if (!text) {
    const mid = cell.from + Math.min(1, raw.length);
    return { from: mid, to: mid };
  }
  return { from: cell.from + lead, to: cell.from + lead + text.length };
}

interface TableInfo {
  from: number;
  to: number;
  lines: string[];
  /** 游標所在列（0 是標題列，1 是分隔列）。 */
  row: number;
  col: number;
  indent: string;
}

/** 找出游標所在的表格（用語法樹判斷，所以程式碼區塊裡的 `|` 不會被當成表格）。 */
export function tableAt(state: EditorState, pos: number): TableInfo | null {
  let node = syntaxTree(state).resolveInner(pos, -1);
  while (node.name !== "Table") {
    if (!node.parent) return null;
    node = node.parent;
  }
  const first = state.doc.lineAt(node.from);
  const last = state.doc.lineAt(node.to);
  const lines: string[] = [];
  for (let n = first.number; n <= last.number; n++) lines.push(state.doc.line(n).text);
  const cur = state.doc.lineAt(pos);
  const row = cur.number - first.number;
  return {
    from: first.from,
    to: last.to,
    lines,
    row,
    col: cellIndexAt(cur.text, pos - cur.from),
    indent: first.text.match(/^\s*/)![0],
  };
}

/** 把表格的各列解析成儲存格文字（分隔列也照樣拆開保留）。 */
function rowsOf(lines: string[]): string[][] {
  return lines.map((l) => splitCells(l).map((c) => c.text));
}

/** 重組並排版表格，回傳新文字與每一行的內容，供計算游標位置。 */
function render(rows: string[][], indent: string, format: Formatter): string[] {
  const cols = Math.max(...rows.map((r) => r.length));
  const filled = rows.map((r, i) => {
    const out = [...r];
    while (out.length < cols) out.push(i === 1 ? "---" : "");
    return out;
  });
  const text = filled.map((r) => indent + buildRow(r)).join("\n");
  return (format(text) ?? text).split("\n");
}

function replaceTable(
  state: EditorState,
  info: TableInfo,
  lines: string[],
  target: { row: number; col: number },
): ReturnType<EditorState["update"]> {
  const row = Math.max(0, Math.min(target.row, lines.length - 1));
  const cells = splitCells(lines[row]);
  const col = Math.max(0, Math.min(target.col, cells.length - 1));
  let offset = info.from;
  for (let i = 0; i < row; i++) offset += lines[i].length + 1;
  const range = contentRange(lines[row], cells[col]);
  return state.update({
    changes: { from: info.from, to: info.to, insert: lines.join("\n") },
    selection: EditorSelection.range(offset + range.from, offset + range.to),
    scrollIntoView: true,
    userEvent: "input.table",
  });
}

type Composing = () => boolean;

/** Tab：排版表格並移到下一格；最後一格時新增一列。 */
export function nextCell(format: Formatter, composing: Composing): StateCommand {
  return ({ state, dispatch }) => {
    if (composing()) return false;
    const info = tableAt(state, state.selection.main.head);
    if (!info) return false;
    const rows = rowsOf(info.lines);
    const cols = Math.max(...rows.map((r) => r.length));
    let { row, col } = info;
    if (row === 1) row = 2;
    else col++;
    if (col >= cols) {
      row = row === 0 ? 2 : row + 1;
      col = 0;
    }
    if (row >= rows.length) rows.push(Array(cols).fill(""));
    dispatch(replaceTable(state, info, render(rows, info.indent, format), { row, col }));
    return true;
  };
}

/** Shift+Tab：移到上一格。 */
export function previousCell(format: Formatter, composing: Composing): StateCommand {
  return ({ state, dispatch }) => {
    if (composing()) return false;
    const info = tableAt(state, state.selection.main.head);
    if (!info) return false;
    const rows = rowsOf(info.lines);
    const cols = Math.max(...rows.map((r) => r.length));
    let { row, col } = info;
    col--;
    if (col < 0) {
      row = row === 2 ? 0 : Math.max(0, row - 1);
      col = row === 0 && info.row === 0 ? 0 : cols - 1;
    }
    dispatch(replaceTable(state, info, render(rows, info.indent, format), { row, col }));
    return true;
  };
}

/** Enter：在目前這列下方新增一列；在空白列按 Enter 則刪除該列並離開表格。 */
export function newRow(format: Formatter, composing: Composing): StateCommand {
  return ({ state, dispatch }) => {
    if (composing() || !state.selection.main.empty) return false;
    const info = tableAt(state, state.selection.main.head);
    if (!info || info.row === 1) return false;
    const rows = rowsOf(info.lines);
    const cols = Math.max(...rows.map((r) => r.length));
    const current = rows[info.row];
    if (info.row >= 2 && current.every((c) => c === "")) {
      rows.splice(info.row, 1);
      const lines = render(rows, info.indent, format);
      const text = lines.join("\n");
      dispatch(
        state.update({
          changes: { from: info.from, to: info.to, insert: `${text}\n` },
          selection: { anchor: info.from + text.length + 1 },
          scrollIntoView: true,
          userEvent: "input.table",
        }),
      );
      return true;
    }
    const at = info.row === 0 ? 2 : info.row + 1;
    rows.splice(at, 0, Array(cols).fill(""));
    dispatch(replaceTable(state, info, render(rows, info.indent, format), { row: at, col: 0 }));
    return true;
  };
}

type TableEdit = "format" | "insert-row" | "insert-column" | "delete-row" | "delete-column";

/** 指令面板用的表格操作。游標不在表格中時回傳 false。 */
export function editTable(kind: TableEdit, format: Formatter): StateCommand {
  return ({ state, dispatch }) => {
    const info = tableAt(state, state.selection.main.head);
    if (!info) return false;
    const rows = rowsOf(info.lines);
    let { row, col } = info;
    switch (kind) {
      case "insert-row": {
        const at = row <= 1 ? 2 : row + 1;
        rows.splice(at, 0, Array(Math.max(...rows.map((r) => r.length))).fill(""));
        row = at;
        col = 0;
        break;
      }
      case "insert-column":
        rows.forEach((r, i) => r.splice(col + 1, 0, i === 1 ? "---" : ""));
        col++;
        break;
      case "delete-row":
        if (row < 2) return false; // 標題列與分隔列不能刪
        rows.splice(row, 1);
        row = Math.min(row, rows.length - 1);
        break;
      case "delete-column":
        if (rows[0].length <= 1) return false;
        rows.forEach((r) => r.splice(col, 1));
        col = Math.max(0, col - 1);
        break;
      case "format":
        break;
    }
    dispatch(replaceTable(state, info, render(rows, info.indent, format), { row, col }));
    return true;
  };
}
