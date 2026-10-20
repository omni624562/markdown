/**
 * 中文以詞為單位移動游標（E7）。用瀏覽器內建的 Intl.Segmenter 斷詞，
 * 重新實作 Ctrl+←／→、Ctrl+Backspace／Delete 與雙擊選詞；
 * 游標旁邊不是中日文字時交回 CodeMirror 原本的行為，英文完全不受影響。
 */
import { EditorSelection, type EditorState, type Extension, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}]/u;

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("zh-Hant", { granularity: "word" }) : null;

function segments(text: string): { from: number; to: number }[] {
  if (!segmenter) return [];
  return [...segmenter.segment(text)].map((s) => ({ from: s.index, to: s.index + s.segment.length }));
}

const isCjk = (ch: string | undefined) => !!ch && CJK.test(ch);

/** 行內 `offset` 右邊是中日文字時，往右移一個詞後的位置；否則回傳 null。 */
export function wordRight(text: string, offset: number): number | null {
  if (!isCjk(String.fromCodePoint(text.codePointAt(offset) ?? 0))) return null;
  return segments(text).find((s) => s.to > offset)?.to ?? null;
}

/** 行內 `offset` 左邊是中日文字時，往左移一個詞後的位置；否則回傳 null。 */
export function wordLeft(text: string, offset: number): number | null {
  if (offset === 0 || !isCjk(text[offset - 1])) return null;
  let start: number | null = null;
  for (const s of segments(text)) {
    if (s.from >= offset) break;
    start = s.from;
  }
  return start;
}

/** `offset` 所在的中文詞（優先看右邊的字，其次看左邊的字）；不是中日文字時回傳 null。 */
export function wordAt(text: string, offset: number): { from: number; to: number } | null {
  const at = isCjk(text[offset]) ? offset : isCjk(text[offset - 1]) ? offset - 1 : -1;
  if (at < 0) return null;
  return segments(text).find((s) => s.from <= at && at < s.to) ?? null;
}

function lineWord(state: EditorState, pos: number) {
  const line = state.doc.lineAt(pos);
  const w = wordAt(line.text, pos - line.from);
  return w && { from: line.from + w.from, to: line.from + w.to };
}

function move(forward: boolean, extend: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view;
    if (view.composing || state.selection.ranges.length > 1) return false;
    const range = state.selection.main;
    const line = state.doc.lineAt(range.head);
    const off = range.head - line.from;
    const target = forward ? wordRight(line.text, off) : wordLeft(line.text, off);
    if (target === null) return false;
    const head = line.from + target;
    view.dispatch({
      selection: extend ? EditorSelection.range(range.anchor, head) : EditorSelection.cursor(head),
      scrollIntoView: true,
      userEvent: "select",
    });
    return true;
  };
}

function remove(forward: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const range = state.selection.main;
    if (view.composing || state.readOnly || state.selection.ranges.length > 1 || !range.empty) return false;
    const line = state.doc.lineAt(range.head);
    const off = range.head - line.from;
    const target = forward ? wordRight(line.text, off) : wordLeft(line.text, off);
    if (target === null) return false;
    const [from, to] = forward ? [range.head, line.from + target] : [line.from + target, range.head];
    view.dispatch({
      changes: { from, to },
      selection: EditorSelection.cursor(from),
      scrollIntoView: true,
      userEvent: forward ? "delete.forward" : "delete.backward",
    });
    return true;
  };
}

/** 雙擊中文時選取一個詞；拖曳時以詞為單位延伸。 */
const doubleClick = EditorView.mouseSelectionStyle.of((view, event) => {
  if (event.detail !== 2 || event.button !== 0 || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) {
    return null;
  }
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  let start = pos === null ? null : lineWord(view.state, pos);
  if (!start) return null;
  return {
    get(cur) {
      const p = view.posAtCoords({ x: cur.clientX, y: cur.clientY });
      const s = start!;
      if (p === null) return EditorSelection.create([EditorSelection.range(s.from, s.to)]);
      const w = lineWord(view.state, p) ?? { from: p, to: p };
      return EditorSelection.create([
        w.from < s.from ? EditorSelection.range(s.to, w.from) : EditorSelection.range(s.from, Math.max(s.to, w.to)),
      ]);
    },
    update(u) {
      if (u.docChanged && start) start = { from: u.changes.mapPos(start.from), to: u.changes.mapPos(start.to) };
    },
  };
});

export function cjkWords(): Extension {
  if (!segmenter) return [];
  return [
    Prec.high(
      keymap.of([
        { key: "Mod-ArrowLeft", mac: "Alt-ArrowLeft", run: move(false, false), shift: move(false, true) },
        { key: "Mod-ArrowRight", mac: "Alt-ArrowRight", run: move(true, false), shift: move(true, true) },
        { key: "Mod-Backspace", mac: "Alt-Backspace", run: remove(false) },
        { key: "Mod-Delete", mac: "Alt-Delete", run: remove(true) },
      ]),
    ),
    doubleClick,
  ];
}
