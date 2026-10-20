/**
 * Markdown 格式指令：只操作 CodeMirror 的 EditorState，不碰 DOM，方便單元測試。
 */
import { EditorSelection, type EditorState, type StateCommand, type TransactionSpec } from "@codemirror/state";

function apply(state: EditorState, dispatch: Parameters<StateCommand>[0]["dispatch"], spec: TransactionSpec) {
  dispatch(state.update(spec, { scrollIntoView: true, userEvent: "input" }));
  return true;
}

/** 用 `marker` 包住選取範圍；已經包住時則移除。沒有選取時插入成對符號並把游標放中間。 */
export function toggleWrap(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    const n = marker.length;
    const tr = state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - n, range.from);
      const after = state.sliceDoc(range.to, range.to + n);
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - n, to: range.from },
            { from: range.to, to: range.to + n },
          ],
          range: EditorSelection.range(range.from - n, range.to - n),
        };
      }
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: EditorSelection.range(range.from + n, range.to + n),
      };
    });
    return apply(state, dispatch, tr);
  };
}

/** 行首會被互相取代的區塊標記：標題、引言、清單、待辦。 */
const LINE_PREFIX = /^(#{1,6} |> |[-*+] \[[ xX]\] |[-*+] |\d+[.)] )/;

export type LineStyle = "h1" | "h2" | "h3" | "quote" | "bullet" | "ordered" | "task";

function prefixFor(style: LineStyle, index: number): string {
  switch (style) {
    case "h1":
      return "# ";
    case "h2":
      return "## ";
    case "h3":
      return "### ";
    case "quote":
      return "> ";
    case "bullet":
      return "- ";
    case "ordered":
      return `${index + 1}. `;
    case "task":
      return "- [ ] ";
  }
}

function hasStyle(text: string, style: LineStyle): boolean {
  const m = text.match(LINE_PREFIX)?.[0];
  if (!m) return false;
  if (style === "ordered") return /^\d+[.)] $/.test(m);
  if (style === "task") return /^[-*+] \[[ xX]\] $/.test(m);
  if (style === "bullet") return /^[-*+] $/.test(m);
  return m === prefixFor(style, 0);
}

/**
 * 把選取到的每一行套用區塊樣式。所有行都已是該樣式時改為移除（切換效果）；
 * 原本有其他標記（例如把清單改成標題）時會直接取代。
 */
export function toggleLineStyle(style: LineStyle): StateCommand {
  return ({ state, dispatch }) => {
    const lines = new Map<number, { from: number; text: string }>();
    for (const r of state.selection.ranges) {
      for (let pos = r.from; pos <= r.to; ) {
        const line = state.doc.lineAt(pos);
        lines.set(line.number, { from: line.from, text: line.text });
        pos = line.to + 1;
      }
    }
    const sorted = [...lines.values()].sort((a, b) => a.from - b.from);
    const removing = sorted.every((l) => hasStyle(l.text, style));
    const changes = sorted.map((l, i) => {
      const existing = l.text.match(LINE_PREFIX)?.[0] ?? "";
      return {
        from: l.from,
        to: l.from + existing.length,
        insert: removing ? "" : prefixFor(style, i),
      };
    });
    return apply(state, dispatch, { changes });
  };
}

/** 在游標所在行之後插入一個區塊（前後補空行），並選取 `select` 指定的部分。 */
export function insertBlock(text: string, select?: string): StateCommand {
  return ({ state, dispatch }) => {
    const line = state.doc.lineAt(state.selection.main.head);
    const atEmptyLine = line.text.trim() === "";
    const pos = atEmptyLine ? line.from : line.to;
    const before = atEmptyLine ? (line.number > 1 && state.doc.line(line.number - 1).text.trim() !== "" ? "\n" : "") : "\n\n";
    const insert = `${before}${text}\n`;
    const start = pos + before.length;
    let anchor = start + text.length;
    let head = anchor;
    if (select) {
      const i = text.indexOf(select);
      if (i >= 0) {
        anchor = start + i;
        head = anchor + select.length;
      }
    }
    return apply(state, dispatch, {
      changes: { from: pos, to: atEmptyLine ? line.to : pos, insert },
      selection: EditorSelection.range(anchor, head),
    });
  };
}

/** 插入連結：選取的文字當連結文字，並選取網址部分方便直接貼上。 */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  const tr = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);
    const isUrl = /^https?:\/\/\S+$/.test(selected);
    const label = isUrl ? "連結文字" : selected || "連結文字";
    const url = isUrl ? selected : "https://";
    const insert = `[${label}](${url})`;
    // 選取的是網址時，選取標籤讓使用者輸入；否則選取網址。
    const from = isUrl ? range.from + 1 : range.from + label.length + 3;
    const to = isUrl ? from + label.length : from + url.length;
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.range(from, to) };
  });
  return apply(state, dispatch, tr);
};

export const TABLE_TEMPLATE = "| 欄位 1 | 欄位 2 |\n| --- | --- |\n| 內容 | 內容 |";
