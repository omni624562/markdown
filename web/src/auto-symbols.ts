/**
 * 打字自動轉符號：輸入 `<=` 變成 `≤`、`->` 變成 `→` 等。
 * 程式碼、HTML、網址與數學公式裡不轉換；轉換後馬上按 Backspace 或 Ctrl+Z 會還原成原本打的字。
 */
import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { Annotation, type EditorState, type Extension, Prec, StateField } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

/** 打的字（最後一個字元觸發）→ 符號。`≤>`、`←>` 讓 `<=>`、`<->` 也能一路打出來。 */
export const AUTO_SYMBOLS: readonly [string, string][] = [
  ["≤>", "⇔"],
  ["←>", "↔"],
  ["<=", "≤"],
  [">=", "≥"],
  ["!=", "≠"],
  ["->", "→"],
  ["<-", "←"],
  ["=>", "⇒"],
  ["+-", "±"],
];

/** 這些語法節點裡不轉換。 */
const SKIP = /^(InlineCode|CodeText|FencedCode|CodeBlock|HTMLTag|HTMLBlock|Comment|CommentBlock|URL|Autolink|ProcessingInstruction)$/;

/** 打完 `typed` 之後，游標前的文字（含 `typed`）要換成哪個符號；沒有就回傳 null。 */
export function matchSymbol(before: string): { from: string; to: string } | null {
  for (const [from, to] of AUTO_SYMBOLS) {
    if (!before.endsWith(from)) continue;
    const prev = before.slice(0, before.length - from.length).slice(-1);
    // `-->`（HTML 註解結尾）、`<--`、`==>` 這類連續符號不轉。
    if (prev && prev === from[0]) return null;
    return { from, to };
  }
  return null;
}

/**
 * 游標在還沒打完的行內程式碼 `` `… `` 或數學公式 `$…$` 裡：這一行游標前有奇數個（沒有跳脫的）`` ` `` 或 `$`。
 * 結尾還沒打出來時語法樹還不知道是程式碼，所以另外檢查。
 */
export function insideInlineSpan(lineBefore: string): boolean {
  const odd = (re: RegExp) => (lineBefore.match(re)?.length ?? 0) % 2 === 1;
  return odd(/(?<!\\)\$/g) || odd(/`/g);
}

function skipped(state: EditorState, pos: number): boolean {
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent!) {
    if (SKIP.test(node.name)) return true;
    if (!node.parent) break;
  }
  const line = state.doc.lineAt(pos);
  return insideInlineSpan(line.text.slice(0, pos - line.from));
}

const converted = Annotation.define<{ at: number; symbol: string; original: string }>();

/** 最近一次轉換（給 Backspace 還原用）；之後有其他變動就清掉。 */
const lastConversion = StateField.define<{ at: number; symbol: string; original: string } | null>({
  create: () => null,
  update(value, tr) {
    const mark = tr.annotation(converted);
    if (mark) return mark;
    return tr.docChanged || tr.selection ? null : value;
  },
});

export function autoSymbols(enabled: () => boolean): Extension {
  return [
    lastConversion,
    EditorView.inputHandler.of((view, from, to, text) => {
      if (text.length !== 1 || from !== to || view.composing || !enabled()) return false;
      const state = view.state;
      const before = state.sliceDoc(Math.max(0, from - 4), from) + text;
      const match = matchSymbol(before);
      if (!match || skipped(state, from)) return false;
      const start = from + 1 - match.from.length;
      // 先照常輸入，再換成符號（另一個復原步驟），Ctrl+Z 就能還原成原本打的字。
      view.dispatch({ changes: { from, insert: text }, selection: { anchor: from + 1 }, userEvent: "input.type" });
      view.dispatch({
        changes: { from: start, to: from + 1, insert: match.to },
        selection: { anchor: start + match.to.length },
        userEvent: "input.autosymbol",
        annotations: [isolateHistory.of("full"), converted.of({ at: start, symbol: match.to, original: match.from })],
      });
      return true;
    }),
    Prec.high(
      keymap.of([
        {
          key: "Backspace",
          run: (view) => {
            const last = view.state.field(lastConversion, false);
            const head = view.state.selection.main;
            if (!last || !head.empty || head.head !== last.at + last.symbol.length) return false;
            view.dispatch({
              changes: { from: last.at, to: head.head, insert: last.original },
              selection: { anchor: last.at + last.original.length },
              userEvent: "delete.autosymbol",
            });
            return true;
          },
        },
      ]),
    ),
  ];
}
