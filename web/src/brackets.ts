// i18n-ignore-file（全形括號與標點是比對用的資料，不是介面文字）
/**
 * 括號與引號自動配對，含全形「」『』（）《》【】“”。
 *
 * CodeMirror 內建的 closeBrackets 只處理直接輸入的字元，輸入法組字時會刻意略過；
 * 而注音、倉頡打出的全形標點都經過組字，所以這裡在組字結束後另外補上配對。
 */
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

export const PAIRS: Record<string, string> = {
  "「": "」",
  "『": "』",
  "（": "）",
  "《": "》",
  "【": "】",
  "“": "”",
  "〈": "〉",
};
const CLOSERS = new Set(Object.values(PAIRS));

/** 一般文字（Markdown、純文字）使用的配對清單；英文單引號會和縮寫衝突，所以不配對。 */
const BRACKETS = ["(", "[", "{", '"', ...Object.keys(PAIRS)];

/** 下一個字元是這些時才自動補上右括號，避免在詞的中間插入。 */
function canCloseBefore(next: string): boolean {
  return next === "" || /[\s)\]}>」』）》】”〉，。、；：！？,.;:!?]/.test(next);
}

const addAutoCloser = StateEffect.define<number>();
/** 自動補上的右括號位置；只有這些位置在輸入對應右括號時才會「跳過」。 */
const autoClosers = StateField.define<readonly number[]>({
  create: () => [],
  update(value, tr) {
    let next = value.map((p) => tr.changes.mapPos(p, 1)).filter((p) => p < tr.state.doc.length);
    for (const e of tr.effects) if (e.is(addAutoCloser)) next = [...next, e.value];
    if (tr.selection) {
      const line = tr.state.doc.lineAt(tr.selection.main.head);
      next = next.filter((p) => p >= line.from && p <= line.to);
    }
    return next;
  },
});

interface Pending {
  start: number;
  selected: string;
}

/** 組字結束後，判斷剛輸入的是不是全形左／右括號並補上配對。 */
export function afterComposition(view: EditorView, pending: Pending): void {
  const { state } = view;
  const head = state.selection.main.head;
  if (!state.selection.main.empty || head < pending.start) return;
  const committed = state.sliceDoc(pending.start, head);
  const next = state.sliceDoc(head, head + 1);

  if (committed in PAIRS) {
    const close = PAIRS[committed];
    if (pending.selected) {
      // 先選取文字再打「：把選取的文字包起來。
      view.dispatch({
        changes: { from: head, insert: pending.selected + close },
        selection: { anchor: head, head: head + pending.selected.length },
        userEvent: "input.type",
      });
    } else if (canCloseBefore(next)) {
      view.dispatch({
        changes: { from: head, insert: close },
        selection: { anchor: head },
        effects: addAutoCloser.of(head),
        userEvent: "input.type",
      });
    }
    return;
  }

  // 游標前剛打了右括號，而後面正好是自動補上的同一個右括號：刪掉後面那個，等於「跳過」。
  if (CLOSERS.has(committed) && next === committed && state.field(autoClosers).includes(head)) {
    view.dispatch({ changes: { from: head, to: head + 1 }, userEvent: "input.type" });
  }
}

/** 處理組字的事件：記下開始位置與選取文字，結束後等 CodeMirror 更新完文件再補配對。 */
function compositionPairs(): Extension {
  let pending: Pending | null = null;
  return EditorView.domEventHandlers({
    compositionstart(_e, view) {
      const sel = view.state.selection.main;
      pending = { start: sel.from, selected: view.state.sliceDoc(sel.from, sel.to) };
    },
    compositionend(_e, view) {
      const p = pending;
      pending = null;
      if (!p) return;
      let tries = 0;
      const run = () => {
        if (view.composing && tries++ < 10) {
          requestAnimationFrame(run);
          return;
        }
        afterComposition(view, p);
      };
      requestAnimationFrame(run);
    },
  });
}

/** Markdown 與純文字共用的配對設定。 */
export function bracketPairing(): Extension {
  return [
    closeBrackets(),
    keymap.of(closeBracketsKeymap),
    EditorState.languageData.of(() => [{ closeBrackets: { brackets: BRACKETS, before: ")]}>」』）》】”〉，。、；：！？,.;:!?" } }]),
    autoClosers,
    compositionPairs(),
  ];
}
