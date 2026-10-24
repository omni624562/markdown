/**
 * 兩國用語、錯別字與中文標點檢查：找出中國用語（建議台灣的說法）、台灣常見的錯別字，
 * 以及中文句子裡混進的半形標點。只比對詞語，不猜文意；同一個詞在台灣也有別的意思時標成「依文意」，
 * 不會在整份修正時自動換掉。
 *
 * 詞表與比對在 Rust（`crates/md-text`），這裡只把結果轉成前端用的格式、產生提示文字。
 */
import { type Term, proofread, termList } from "../pkg/md_wasm.js";
import { t } from "./i18n.ts";

export type { Term, TermKind } from "../pkg/md_wasm.js";

export interface TermMatch {
  from: number;
  to: number;
  term: Term;
}

let terms: Term[] | null = null;

/**
 * 找出 `text` 中的中國用語、錯字與半形標點（標點和用語重疊時以用語為準），依位置排序。
 * `skip` 是不檢查的範圍（程式碼、網址等），`ignore` 是使用者選擇不再提示的詞。
 */
export function checkText(
  text: string,
  skip: readonly [number, number][] = [],
  ignore: ReadonlySet<string> = new Set(),
): TermMatch[] {
  terms ??= termList();
  const found = proofread(text, Uint32Array.from(skip.flat()), [...ignore]);
  const out: TermMatch[] = [];
  for (let i = 0; i < found.length; i += 3) {
    const from = found[i];
    const to = found[i + 1];
    let term = terms[found[i + 2]];
    // 半形括號：把括號換成全形，內容照舊。
    if (!term.to.length) term = { ...term, to: [`（${text.slice(from + 1, to - 1)}）`] }; // i18n-ignore
    out.push({ from, to, term });
  }
  return out;
}

/** 提示文字，例如「「視頻」是中國用語，台灣說「影片」」。 */
export function termMessage(term: Term): string {
  const to = term.to.map((w) => t("「{word}」", { word: w })).reduce((a, b) => t("{a}或{b}", { a, b }));
  const { word, note } = term;
  if (term.kind === "punct") {
    const why = term.to[0].length > 1 ? t("括號裡是中文，用全形括號") : t("中文句子裡用全形標點");
    return t("{note}：改成{to}", { note: why, to });
  }
  if (term.kind === "typo") {
    return note ? t("「{word}」可能是錯字，應該是{to}（{note}）", { word, to, note }) : t("「{word}」可能是錯字，應該是{to}", { word, to });
  }
  if (term.context) {
    return note ? t("「{word}」{note}，台灣說{to}", { word, note, to }) : t("「{word}」在這裡如果是中國用語，台灣說{to}", { word, to });
  }
  return t("「{word}」是中國用語，台灣說{to}", { word, to });
}

/** 整份修正：只換不需要判斷文意的詞，回傳修改清單（由後往前套用不會影響位置）。 */
export function sureFixes(matches: readonly TermMatch[]): { from: number; to: number; insert: string }[] {
  return matches.filter((m) => !m.term.context).map((m) => ({ from: m.from, to: m.to, insert: m.term.to[0] }));
}
