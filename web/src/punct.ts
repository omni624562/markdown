/**
 * 中文標點檢查：中文句子裡混進半形的 , . ; : ! ? ( ) 時建議改成全形（，。；：！？（））。
 * 只看緊接在中文字後面的標點，數字（3.5、10:00）、英文句子、網址與程式碼都不會動。
 */
import { t } from "./i18n.ts";
import type { Term, TermMatch } from "./terms.ts";
import { rangeChecker } from "./ranges.ts";

const CJK = "\\u3400-\\u9fff\\uf900-\\ufaff";
// i18n-ignore
const FULL: Record<string, string> = { ",": "，", ".": "。", ";": "；", ":": "：", "!": "！", "?": "？" };

/** 「不再提示」記下的名稱，例如「半形標點 ,」。存在設定裡，所以不翻譯。 */
export const punctKey = (mark: string) => `半形標點 ${mark}`; // i18n-ignore

function term(mark: string, to: string, note: string): Term {
  return { word: punctKey(mark), to: [to], kind: "punct", context: false, note, except: [] };
}

/**
 * 中文字後面的半形標點（後面的空白一起換掉，全形標點本身就有間隔）。
 * 句點只在後面是行尾、空白或中文字時才算（避免 3.5、網址、英文縮寫）。
 */
const MARK = new RegExp(`(?<=[${CJK}])([,;:!?]|\\.(?!\\.)(?=$|\\s|[${CJK}]))[ \\t]*(?=$|[^\\S\\n]|[^\\s])`, "gm");
/** 括號裡有中文、前面是中文字的半形括號（不含連結的 `](…)`）。 */
const PAREN = new RegExp(`(?<=[${CJK}])\\(([^()\\n]*[${CJK}][^()\\n]*)\\)`, "g");

export function findPunctuation(
  text: string,
  skip: readonly [number, number][] = [],
  ignore: ReadonlySet<string> = new Set(),
): TermMatch[] {
  const out: TermMatch[] = [];
  const skipped = rangeChecker([...skip]);
  for (const m of text.matchAll(MARK)) {
    const mark = m[1];
    const from = m.index;
    let to = from + m[0].length;
    // 行尾的空白留著（Markdown 的換行）；只換掉標點與後面接著文字的空白。
    if (/[ \t]$/.test(m[0]) && (to >= text.length || text[to] === "\n")) to = from + 1;
    if (ignore.has(punctKey(mark)) || skipped(from, to)) continue;
    out.push({ from, to, term: term(mark, FULL[mark], t("中文句子裡用全形標點")) });
  }
  for (const m of text.matchAll(PAREN)) {
    const from = m.index;
    const to = from + m[0].length;
    if (ignore.has(punctKey("()")) || skipped(from, to)) continue;
    // i18n-ignore（建議的全形括號是文件內容）
    out.push({ from, to, term: term("()", `（${m[1]}）`, t("括號裡是中文，用全形括號")) });
  }
  return out.sort((a, b) => a.from - b.from);
}
