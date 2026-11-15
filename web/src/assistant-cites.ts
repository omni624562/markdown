/**
 * 助理回答的出處（純函式）：Claude API 回報每一段回答根據的是文件裡的哪一段原文（citations），
 * 這裡把它們編號、在回答裡加上 `[1]` 這樣的標記、在回答最後列出原文，並在目前的文件裡找出那一段的位置。
 * 畫面上的部分在 app/assistant-cites.ts。
 */

/** 一個出處：引用的原文，和它在哪裡（文字檔的名稱與大概的位置，或 PDF 的頁碼）。 */
export interface Cite {
  text: string;
  title: string | null;
  /** 原文從第幾個字開始（找原文時的提示；文件改過就不準）。 */
  start: number | null;
  /** PDF 的頁碼（從 1 開始）。 */
  page: number | null;
}

const sameCite = (a: Cite, b: Cite) => a.text === b.text && a.title === b.title && a.page === b.page;

/** 把這一段的出處記進 `list`（同一段原文只記一次），回傳要接在那一段回答後面的標記，例如 ` [1][3]`。 */
export function citeMarks(list: Cite[], cites: readonly Cite[]): string {
  const numbers: number[] = [];
  for (const c of cites) {
    let i = list.findIndex((x) => sameCite(x, c));
    if (i < 0) i = list.push(c) - 1;
    if (!numbers.includes(i + 1)) numbers.push(i + 1);
  }
  return numbers.length ? " " + numbers.map((n) => `[${n}]`).join("") : "";
}

/** 標記接在文字後面、結尾的空白與換行之前（不然會跑到下一段的開頭）。 */
export function appendMarks(text: string, marks: string): string {
  if (!marks) return text;
  const body = text.trimEnd();
  return body + marks + text.slice(body.length);
}

/** 原文縮成一行（太長就截斷），列在回答最後。 */
export function citeSnippet(text: string, max = 80): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max).trimEnd() + "…" : line;
}

/** 回答最後的出處清單（Markdown）。`label` 把一個出處寫成一行（名稱、頁碼的文字由畫面那邊翻譯）。 */
export function citeList(list: readonly Cite[], heading: string, label: (c: Cite) => string): string {
  if (!list.length) return "";
  const lines = list.map((c, i) => `- [${i + 1}] ${label(c).replace(/[[\]]/g, "")}`);
  return `**${heading}**\n\n${lines.join("\n")}`;
}

/**
 * 在文件裡找出引用的原文：回傳範圍；找不到（文件改過了）回傳 null。
 * 同一段文字出現好幾次時，挑離 `start` 最近的那一個。
 */
export function findCited(doc: string, cite: Pick<Cite, "text" | "start">): { from: number; to: number } | null {
  const text = cite.text.trim();
  if (!text) return null;
  let best = -1;
  for (let at = doc.indexOf(text); at >= 0; at = doc.indexOf(text, at + 1)) {
    if (best < 0 || Math.abs(at - (cite.start ?? 0)) < Math.abs(best - (cite.start ?? 0))) best = at;
  }
  return best < 0 ? null : { from: best, to: best + text.length };
}
