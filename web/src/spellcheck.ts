/**
 * 編輯器裡的英文拼字檢查：拼錯的英文字畫上紅色波浪底線，滑鼠移上去可以換成建議的拼法或加入字典。
 * 字典（Hunspell 格式，約 550 KB）在第一次需要時才讀；程式碼、網址、HTML、公式不檢查（和兩國用語檢查相同）。
 */
import { type Action, type Diagnostic, linter } from "@codemirror/lint";
import { type Extension, StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Speller } from "../pkg/md_wasm.js";
import { t } from "./i18n.ts";
import { skipRanges } from "./proofread.ts";
import { englishWords } from "./spell.ts";

/** 文件超過這個長度時，只檢查畫面看得到的地方（前後多留一些），捲動後再檢查。 */
const FULL_SCAN_LIMIT = 60_000;
const MARGIN = 5_000;
/** 每次檢查最多新算幾個字的拼字建議（每個要十幾毫秒），其他的下一次再算。 */
const SUGGEST_PER_PASS = 8;

let speller: Speller | null = null;
let loading: Promise<Speller | null> | null = null;
/** 拼字建議（同一個字只算一次）。 */
const suggestions = new Map<string, string[]>();
/** 檢查過的字是不是拼對（大文件每次檢查重複的字很多）。 */
const known = new Map<string, boolean>();

/** 讀字典（只讀一次）；讀不到時回傳 null，不再檢查。 */
function loadSpeller(): Promise<Speller | null> {
  loading ??= (async () => {
    try {
      const base = `${import.meta.env.BASE_URL}dict/en-US`;
      const [aff, dic] = await Promise.all([fetch(`${base}.aff`), fetch(`${base}.dic`)].map(async (r) => (await r).text()));
      speller = new Speller(aff, dic);
      return speller;
    } catch (e) {
      console.warn("無法讀取英文字典", e); // i18n-ignore（開發者主控台）
      return null;
    }
  })();
  return loading;
}

const recheck = StateEffect.define<null>();

/** 設定改了（開關、加入字典）：馬上重新檢查。 */
export function recheckSpelling(view: EditorView): void {
  view.dispatch({ effects: recheck.of(null) });
}

export interface SpellcheckOptions {
  enabled(): boolean;
  /** 個人字典（小寫）。 */
  ignored(): ReadonlySet<string>;
  /** 使用者按了「加入字典」。 */
  ignore(word: string): void;
}

/** 要檢查的範圍：小文件整份，大文件只看畫面附近（對齊到整行）。 */
function scanRange(view: EditorView): [number, number] {
  const doc = view.state.doc;
  if (doc.length <= FULL_SCAN_LIMIT) return [0, doc.length];
  const { from, to } = view.viewport;
  return [doc.lineAt(Math.max(0, from - MARGIN)).from, doc.lineAt(Math.min(doc.length, to + MARGIN)).to];
}

export function spellcheck(opts: SpellcheckOptions): Extension {
  return linter(
    async (view) => {
      if (!opts.enabled()) return [];
      const sp = speller ?? (await loadSpeller());
      if (!sp) return [];
      const [from, to] = scanRange(view);
      const text = view.state.doc.sliceString(from, to);
      const ignored = opts.ignored();
      const hits = englishWords(text, skipRanges(view.state, from, to)).filter((h) => !ignored.has(h.word.toLowerCase()));
      // 還沒檢查過的字一次問完。
      const unknown = [...new Set(hits.map((h) => h.word))].filter((w) => !known.has(w));
      if (unknown.length) {
        const bad = new Set(sp.misspelled(unknown));
        unknown.forEach((w, i) => known.set(w, !bad.has(i)));
      }
      let budget = SUGGEST_PER_PASS;
      let pending = false;
      const out: Diagnostic[] = [];
      for (const h of hits) {
        if (known.get(h.word)) continue;
        let list = suggestions.get(h.word);
        if (!list && budget > 0) {
          budget--;
          list = sp.suggest(h.word);
          suggestions.set(h.word, list);
        }
        if (!list) pending = true;
        const actions: Action[] = (list ?? []).slice(0, 3).map((s) => ({
          name: s,
          apply(v: EditorView, a: number, b: number) {
            v.dispatch({ changes: { from: a, to: b, insert: s }, userEvent: "input.spellcheck" });
          },
        }));
        actions.push({ name: t("加入字典"), apply: () => opts.ignore(h.word) });
        out.push({
          from: from + h.from,
          to: from + h.to,
          severity: "error",
          source: t("拼字"),
          message: list?.length ? t("「{word}」可能拼錯了", { word: h.word }) : t("「{word}」可能拼錯了（找不到建議的拼法）", { word: h.word }),
          actions,
        });
      }
      // 還有字的建議沒算完：等一下再檢查一次（不要一次卡住打字）。
      if (pending) setTimeout(() => recheckSpelling(view), 300);
      return out;
    },
    {
      delay: 600,
      needsRefresh: (u) =>
        u.transactions.some((tr) => tr.effects.some((e) => e.is(recheck))) ||
        (u.viewportChanged && u.state.doc.length > FULL_SCAN_LIMIT),
    },
  );
}
