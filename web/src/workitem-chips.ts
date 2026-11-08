/** 文件裡工作項目連結旁的狀態標籤（不碰畫面，方便測試）；狀態的分類在 work-item-state.ts。 */

export { type StateTone, stateTone } from "./work-item-state.ts";

/** 一行文字裡的連結網址與結束位置（`[文字](網址)`、`(<網址>)`，或直接寫的網址），依出現順序。 */
export function linksInLine(line: string): { url: string; end: number }[] {
  const out: { url: string; end: number }[] = [];
  const re = /\[[^\]\n]*\]\((?:<([^>\n]+)>|([^)\s]+))[^)\n]*\)|<?(https?:\/\/[^\s<>)\]。，、；：！？「」（）]+)>?/g;
  for (const m of line.matchAll(re)) out.push({ url: m[1] ?? m[2] ?? m[3], end: m.index + m[0].length });
  return out;
}
