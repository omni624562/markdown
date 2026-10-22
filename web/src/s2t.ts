/**
 * 簡體轉繁體（台灣用語）：用 OpenCC 的 cn → twp 詞庫，連詞彙一起轉（「软件」→「軟體」、「默认」→「預設」）。
 * 程式碼、網址與連結位址不轉換，以免連結失效。詞庫約 1 MB，第一次轉換時才載入。
 */

export type Convert = (text: string) => string;

let converter: Promise<Convert> | null = null;

export function loadConverter(): Promise<Convert> {
  converter ??= import("opencc-js/cn2t").then((m) => {
    const cn2tw = m.Converter({ from: "cn", to: "twp" });
    // 詞庫一律轉成「臺」；台灣日常文件多半寫「台」（台灣、台北、平台）。
    return (text: string) => cn2tw(text).replaceAll("臺", "台");
  });
  return converter;
}

/** 不轉換的範圍：程式碼區塊、行內程式碼、網址、連結與圖片的位址。 */
const PROTECTED =
  /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)|`[^`\n]+`|<https?:[^>\s]+>|https?:\/\/[^\s<>()（）「」]+|\]\([^)\n]*\)/g;

export interface Segment {
  from: number;
  to: number;
  convert: boolean;
}

/** 把文字切成要轉換與不轉換的片段。 */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(PROTECTED)) {
    const start = m.index + (m[1] ?? "").length;
    const end = m.index + m[0].length;
    if (start > last) out.push({ from: last, to: start, convert: true });
    out.push({ from: start, to: end, convert: false });
    last = end;
  }
  if (last < text.length) out.push({ from: last, to: text.length, convert: true });
  return out;
}

/** 轉換後有變動的片段（給編輯器套用，游標與復原記錄都比較精準）。 */
export function conversionChanges(text: string, convert: Convert, offset = 0): { from: number; to: number; insert: string }[] {
  const changes: { from: number; to: number; insert: string }[] = [];
  for (const s of segments(text)) {
    if (!s.convert) continue;
    const before = text.slice(s.from, s.to);
    const after = convert(before);
    if (after !== before) changes.push({ from: offset + s.from, to: offset + s.to, insert: after });
  }
  return changes;
}

/** 常見、只有簡體才會出現的字（繁體中文不會用到；「后」「里」這類兩邊都有的字不列）。 */
const SIMPLIFIED_ONLY = new Set(
  "们这个说为时国会对发经动现过还关进实开问应与学务长见东车门书页业电话认识让给级无么头样将区产报软数库设计视频质录类专传吗间请谢欢边击图标该没总从办还写读错误项码维护连链调试"
);

/** 看起來是簡體中文：出現至少 3 個不同的簡體字。 */
export function looksSimplified(text: string): boolean {
  const seen = new Set<string>();
  for (const ch of text) {
    if (SIMPLIFIED_ONLY.has(ch)) {
      seen.add(ch);
      if (seen.size >= 3) return true;
    }
  }
  return false;
}
