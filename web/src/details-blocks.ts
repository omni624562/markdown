/**
 * 即時預覽的可收合區塊（`<details>`／`<summary>`）：從 HTML 區塊的行找出每個區塊的標題列與結尾列
 * （不碰畫面，方便測試）。寫法和預覽一樣寬鬆：標籤可以寫在同一行、標題裡可以有 `<b>` 之類的標籤。
 */

export interface DetailsRegion {
  /** `<details>` 所在的行（從 1 開始）。 */
  headStart: number;
  /** 標題列的最後一行（`<summary>` 所在的行；沒有標題時和 headStart 相同）。 */
  headEnd: number;
  /** `</details>` 所在的行。 */
  close: number;
  title: string;
  /** 寫了 `<details open>`。 */
  open: boolean;
}

type Token = { kind: "open"; open: boolean } | { kind: "summary"; title: string } | { kind: "close" };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[name.toLowerCase()] ?? m;
  });
}

/** 一行裡全是可收合區塊的標籤時，依序回傳；有其他內容時回傳 null。 */
export function lineTokens(line: string): Token[] | null {
  const out: Token[] = [];
  let rest = line.trim();
  while (rest) {
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^<\/details\s*>/i))) {
      out.push({ kind: "close" });
    } else if ((m = rest.match(/^<details(?=[\s>/])([^<>]*)>/i))) {
      out.push({ kind: "open", open: /(^|[\s/])open(\s*=|[\s/]|$)/i.test(m[1]) });
    } else if ((m = rest.match(/^<summary(?=[\s>/])[^<>]*>([\s\S]*?)<\/summary\s*>/i))) {
      out.push({ kind: "summary", title: decode(m[1].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim() });
    } else {
      return null;
    }
    rest = rest.slice(m[0].length).trim();
  }
  return out.length ? out : null;
}

/** 依文件順序的 HTML 區塊行（行號、內容），找出成對的可收合區塊（巢狀也可以；沒有結尾的略過）。 */
export function detailsRegions(lines: readonly { number: number; text: string }[]): DetailsRegion[] {
  const stack: Omit<DetailsRegion, "close">[] = [];
  const out: DetailsRegion[] = [];
  for (const { number, text } of lines) {
    const tokens = lineTokens(text);
    if (!tokens) continue;
    for (const tok of tokens) {
      if (tok.kind === "open") {
        stack.push({ headStart: number, headEnd: number, title: "", open: tok.open });
      } else if (tok.kind === "summary") {
        const top = stack[stack.length - 1];
        // 標題要緊接在 <details> 後面（同一行或下一行）。
        if (top && !top.title && number - top.headEnd <= 1) {
          top.title = tok.title;
          top.headEnd = number;
        }
      } else {
        const top = stack.pop();
        if (top && number > top.headEnd) out.push({ ...top, close: number });
      }
    }
  }
  return out.sort((a, b) => a.headStart - b.headStart);
}
