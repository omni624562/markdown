/**
 * 編輯器裡的兩國用語、錯字與中文標點檢查：畫上波浪底線，滑鼠移上去可以直接換成建議的寫法。
 * 程式碼、網址、HTML、數學公式與文件開頭的 YAML 設定不檢查。
 */
import { syntaxTree } from "@codemirror/language";
import { type Action, type Diagnostic, linter } from "@codemirror/lint";
import { type EditorState, type Extension, StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { t } from "./i18n.ts";
import { type TermMatch, checkText, termMessage } from "./terms.ts";

/** 這些語法節點裡不檢查。 */
const SKIP = /^(InlineCode|FencedCode|CodeBlock|HTMLTag|HTMLBlock|Comment|CommentBlock|URL|Autolink|ProcessingInstruction)$/;

/**
 * 不檢查的範圍：程式碼、網址、HTML，以及 `$…$`、`$$…$$` 數學公式。
 * 只看 `from`～`to` 這一段，位置相對於這一段的開頭。
 */
export function skipRanges(state: EditorState, from = 0, to = state.doc.length): [number, number][] {
  const out: [number, number][] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (!SKIP.test(node.name)) return;
      out.push([Math.max(node.from, from) - from, Math.min(node.to, to) - from]);
      return false;
    },
  });
  const text = state.doc.sliceString(from, to);
  // 文件開頭的 YAML 設定（front matter）：「標題: …」的冒號不能改。
  if (from === 0) {
    const front = /^---\n[\s\S]*?\n---(\n|$)/.exec(text);
    if (front) out.push([0, front[0].length]);
  }
  for (const m of text.matchAll(/\$\$[\s\S]*?\$\$|(?<![\\$])\$(?!\s)[^$\n]+?(?<!\s)\$/g)) {
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/** 檢查 `from`～`to`（預設整份文件）。回傳的位置是整份文件裡的位置。 */
export function scanDocument(
  state: EditorState,
  ignore: ReadonlySet<string>,
  from = 0,
  to = state.doc.length,
): TermMatch[] {
  const text = state.doc.sliceString(from, to);
  const skip = skipRanges(state, from, to);
  const all = checkText(text, skip, ignore);
  if (from) for (const m of all) Object.assign(m, { from: m.from + from, to: m.to + from });
  return all;
}

/** 文件超過這個長度時，只檢查畫面看得到的地方（前後多留一些），捲動後再檢查。 */
const FULL_SCAN_LIMIT = 60_000;
const MARGIN = 5_000;

/** 要檢查的範圍：小文件整份，大文件只看畫面附近（對齊到整行）。 */
function scanRange(view: EditorView): [number, number] {
  const doc = view.state.doc;
  if (doc.length <= FULL_SCAN_LIMIT) return [0, doc.length];
  const { from, to } = view.viewport;
  return [doc.lineAt(Math.max(0, from - MARGIN)).from, doc.lineAt(Math.min(doc.length, to + MARGIN)).to];
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
      const [from, to] = scanRange(view);
      return scanDocument(view.state, opts.ignored(), from, to).map((m): Diagnostic => {
        const actions: Action[] = m.term.to.map((to) => ({
          name: m.term.kind === "punct" && to.length > 2 ? t("改成全形括號") : t("改成「{to}」", { to }),
          apply(v: EditorView, from: number, end: number) {
            v.dispatch({ changes: { from, to: end, insert: to }, userEvent: "input.proofread" });
          },
        }));
        actions.push({ name: t("不再提示"), apply: () => opts.ignore(m.term.word) });
        return {
          from: m.from,
          to: m.to,
          severity: m.term.context ? "info" : "warning",
          source: m.term.kind === "typo" ? t("錯字") : m.term.kind === "punct" ? t("標點") : t("兩國用語"),
          message: termMessage(m.term),
          actions,
        };
      });
    },
    {
      delay: 500,
      needsRefresh: (u) =>
        u.transactions.some((tr) => tr.effects.some((e) => e.is(recheck))) ||
        // 大文件只檢查畫面附近：捲到別處時重新檢查。
        (u.viewportChanged && u.state.doc.length > FULL_SCAN_LIMIT),
    },
  );
}
