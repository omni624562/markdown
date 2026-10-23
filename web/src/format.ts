/**
 * Markdown 格式指令：只操作 CodeMirror 的 EditorState，不碰 DOM，方便單元測試。
 */
import { EditorSelection, type EditorState, type StateCommand, type TransactionSpec } from "@codemirror/state";
import { t } from "./i18n.ts";

function apply(state: EditorState, dispatch: Parameters<StateCommand>[0]["dispatch"], spec: TransactionSpec) {
  dispatch(state.update(spec, { scrollIntoView: true, userEvent: "input" }));
  return true;
}

/**
 * 用 `marker` 包住選取範圍（`close` 是結尾，預設和開頭相同，例如 `<u>`…`</u>`）；已經包住時則移除。
 * 沒有選取時插入成對符號並把游標放中間。
 */
export function toggleWrap(marker: string, close = marker): StateCommand {
  return ({ state, dispatch }) => {
    const n = marker.length;
    const m = close.length;
    const tr = state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - n, range.from);
      const after = state.sliceDoc(range.to, range.to + m);
      if (before === marker && after === close) {
        return {
          changes: [
            { from: range.from - n, to: range.from },
            { from: range.to, to: range.to + m },
          ],
          range: EditorSelection.range(range.from - n, range.to - n),
        };
      }
      // 游標（或選取範圍）在已經套用的格式裡面：拿掉這組標記，不用自己去刪 <mark> 之類的標籤。
      const span = enclosingSpan(state, range.from, range.to, marker, close);
      if (span) {
        const shift = (pos: number) => (pos >= span.to - m ? pos - n - m : pos > span.from + n ? pos - n : span.from);
        return {
          changes: [
            { from: span.from, to: span.from + n },
            { from: span.to - m, to: span.to },
          ],
          range: EditorSelection.range(shift(range.anchor), shift(range.head)),
        };
      }
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: close },
        ],
        range: EditorSelection.range(range.from + n, range.to + n),
      };
    });
    return apply(state, dispatch, tr);
  };
}

/**
 * 同一行裡包住 `from`～`to` 的一組 `open`…`close`（含標記本身）；沒有時回傳 null。
 * 單一字元的標記（`*`、`_`、`` ` ``）不能是更長標記的一部分（`*` 不會配到 `**` 的一半）。
 */
export function enclosingSpan(
  state: EditorState,
  from: number,
  to: number,
  open: string,
  close: string,
): { from: number; to: number } | null {
  const line = state.doc.lineAt(from);
  if (to > line.to) return null;
  const text = line.text;
  const single = open.length === 1 && open === close;
  const isMarker = (i: number, mk: string) =>
    text.startsWith(mk, i) && (!single || (text[i - 1] !== mk && text[i + 1] !== mk));
  const a = from - line.from;
  const b = to - line.from;
  let i = 0;
  while (i < text.length) {
    if (!isMarker(i, open)) {
      i++;
      continue;
    }
    let j = i + open.length;
    while (j < text.length && !isMarker(j, close)) j++;
    if (j >= text.length) return null;
    const end = j + close.length;
    if (i <= a && b <= end && !(a === b && (a === i || a === end))) return { from: line.from + i, to: line.from + end };
    i = end;
  }
  return null;
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
    const changes = state.changes(
      sorted.map((l, i) => {
        const existing = l.text.match(LINE_PREFIX)?.[0] ?? "";
        return {
          from: l.from,
          to: l.from + existing.length,
          insert: removing ? "" : prefixFor(style, i),
        };
      }),
    );
    // 游標在行首（例如空白行）時要跑到新加的標記後面，才能接著打字。
    return apply(state, dispatch, { changes, selection: state.selection.map(changes, 1) });
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
    const label = isUrl ? t("連結文字") : selected || t("連結文字");
    const url = isUrl ? selected : "https://";
    const insert = `[${label}](${url})`;
    // 選取的是網址時，選取標籤讓使用者輸入；否則選取網址。
    const from = isUrl ? range.from + 1 : range.from + label.length + 3;
    const to = isUrl ? from + label.length : from + url.length;
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.range(from, to) };
  });
  return apply(state, dispatch, tr);
};

export const TABLE_TEMPLATE = t("| 欄位 1 | 欄位 2 |\n| --- | --- |\n| 內容 | 內容 |");

/** 清除格式時會拿掉的成對標記（由長到短比對）。 */
const INLINE_MARKERS: [string, string][] = [
  ["<mark>", "</mark>"],
  ["<sup>", "</sup>"],
  ["<sub>", "</sub>"],
  ["<ins>", "</ins>"],
  ["<u>", "</u>"],
  ["**", "**"],
  ["__", "__"],
  ["~~", "~~"],
  ["*", "*"],
  ["_", "_"],
  ["`", "`"],
];

/** 選取範圍裡的行內格式標記（粗體、斜體、刪除線、程式碼、底線、螢光、上下標）。 */
const INLINE_MARK_RE = /<\/?(?:u|mark|sup|sub|ins)>|\*\*|__|~~|(?<![\w*])\*(?=\S)|(?<=\S)\*(?![\w*])|`/gi;

/**
 * 清除格式：拿掉選取範圍裡的行內格式標記；選取範圍剛好被標記包住時（例如選了 **重點** 裡的「重點」），
 * 外面的標記也一起拿掉。連結、標題、清單等不受影響。
 */
export const clearInlineFormat: StateCommand = ({ state, dispatch }) => {
  if (state.selection.ranges.every((r) => r.empty)) {
    // 沒有選取：拿掉游標所在位置外面的所有格式標記（例如游標在 <mark>重點</mark> 裡）。
    const pos = state.selection.main.head;
    const changes: { from: number; to: number }[] = [];
    for (const [open, close] of INLINE_MARKERS) {
      const span = enclosingSpan(state, pos, pos, open, close);
      if (!span || changes.some((c) => c.from < span.to && span.from < c.to && (c.from === span.from || c.to === span.to))) continue;
      changes.push({ from: span.from, to: span.from + open.length }, { from: span.to - close.length, to: span.to });
    }
    if (!changes.length) return false;
    const set = state.changes(changes);
    return apply(state, dispatch, { changes: set, selection: EditorSelection.cursor(set.mapPos(pos, -1)) });
  }
  const tr = state.changeByRange((range) => {
    let from = range.from;
    let to = range.to;
    // 由外往內剝掉包住選取範圍的標記。
    for (let changed = true; changed; ) {
      changed = false;
      for (const [open, close] of INLINE_MARKERS) {
        if (state.sliceDoc(from - open.length, from) === open && state.sliceDoc(to, to + close.length) === close) {
          from -= open.length;
          to += close.length;
          changed = true;
          break;
        }
      }
    }
    const inner = state.sliceDoc(range.from, range.to).replace(INLINE_MARK_RE, "");
    return {
      changes: { from, to, insert: inner },
      range: EditorSelection.range(from, from + inner.length),
    };
  });
  return apply(state, dispatch, tr);
};
