/**
 * 編輯器裡的兩國用語與錯字檢查：中國用語與錯字畫上波浪底線，滑鼠移上去可以直接換成建議的寫法。
 * 程式碼、網址、HTML 與數學公式不檢查。
 */
import { syntaxTree } from "@codemirror/language";
import { type Action, type Diagnostic, linter } from "@codemirror/lint";
import { type EditorState, type Extension, StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { type TermMatch, findTerms, termMessage } from "./terms.ts";

/** 這些語法節點裡不檢查。 */
const SKIP = /^(InlineCode|FencedCode|CodeBlock|HTMLTag|HTMLBlock|Comment|CommentBlock|URL|Autolink|ProcessingInstruction)$/;

/** 不檢查的範圍：程式碼、網址、HTML，以及 `$…$`、`$$…$$` 數學公式。 */
export function skipRanges(state: EditorState): [number, number][] {
  const out: [number, number][] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (!SKIP.test(node.name)) return;
      out.push([node.from, node.to]);
      return false;
    },
  });
  const text = state.doc.toString();
  for (const m of text.matchAll(/\$\$[\s\S]*?\$\$|(?<![\\$])\$(?!\s)[^$\n]+?(?<!\s)\$/g)) {
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

export function scanDocument(state: EditorState, ignore: ReadonlySet<string>): TermMatch[] {
  return findTerms(state.doc.toString(), skipRanges(state), ignore);
}

const recheck = StateEffect.define<null>();

/** 設定改了（開關、不再提示的詞）：馬上重新檢查。 */
export function recheckTerms(view: EditorView): void {
  view.dispatch({ effects: recheck.of(null) });
}

export interface ProofreadOptions {
  enabled(): boolean;
  ignored(): ReadonlySet<string>;
  /** 使用者按了「不再提示」。 */
  ignore(word: string): void;
}

export function proofread(opts: ProofreadOptions): Extension {
  return linter(
    (view) => {
      if (!opts.enabled()) return [];
      return scanDocument(view.state, opts.ignored()).map((m): Diagnostic => {
        const actions: Action[] = m.term.to.map((to) => ({
          name: `改成「${to}」`,
          apply(v: EditorView, from: number, end: number) {
            v.dispatch({ changes: { from, to: end, insert: to }, userEvent: "input.proofread" });
          },
        }));
        actions.push({ name: "不再提示", apply: () => opts.ignore(m.term.word) });
        return {
          from: m.from,
          to: m.to,
          severity: m.term.context ? "info" : "warning",
          source: m.term.kind === "typo" ? "錯字" : "兩國用語",
          message: termMessage(m.term),
          actions,
        };
      });
    },
    { delay: 500, needsRefresh: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(recheck))) },
  );
}
