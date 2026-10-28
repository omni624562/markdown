/** 文件裡工作項目連結旁的狀態標籤：依狀態名稱分成幾種顏色（不碰畫面，方便測試）。 */

export type StateTone = "new" | "active" | "resolved" | "done" | "removed";

const TONES: [StateTone, RegExp][] = [
  // 中文的流程範本也一起認（是伺服器上的狀態名稱，不是介面文字）。
  ["removed", /^(removed|cut|已移除|已刪除|移除)$/i], // i18n-ignore
  ["done", /^(closed|done|completed|inactive|已關閉|已完成|關閉|完成)$/i], // i18n-ignore
  ["resolved", /^(resolved|已解決|解決)$/i], // i18n-ignore
  ["new", /^(new|to do|proposed|open|design|新增|新的|待辦)$/i], // i18n-ignore
];

/** 狀態名稱對應的顏色；認不得的當成進行中（Active、In Progress、Committed…）。 */
export function stateTone(state: string): StateTone {
  const s = state.trim();
  return TONES.find(([, re]) => re.test(s))?.[0] ?? "active";
}

/** 一行文字裡的連結網址與結束位置（`[文字](網址)`、`(<網址>)`，或直接寫的網址），依出現順序。 */
export function linksInLine(line: string): { url: string; end: number }[] {
  const out: { url: string; end: number }[] = [];
  const re = /\[[^\]\n]*\]\((?:<([^>\n]+)>|([^)\s]+))[^)\n]*\)|<?(https?:\/\/[^\s<>)\]。，、；：！？「」（）]+)>?/g;
  for (const m of line.matchAll(re)) out.push({ url: m[1] ?? m[2] ?? m[3], end: m.index + m[0].length });
  return out;
}
