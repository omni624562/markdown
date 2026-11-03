/**
 * Wiki 頁面改名、搬移後，更新內文裡的連結（不碰畫面，方便測試）。
 * 連到搬移的頁面（或它底下的子頁面）的連結改成新位置；搬移的頁面自己裡面的相對連結，搬過去之後
 * 不再指到原本那一頁的，也改成那一頁的絕對路徑。
 */
import { linkSpans } from "./wiki-backlinks.ts";

/** 搬移的頁面與底下的子頁面：舊路徑 → 新路徑。 */
export function movedPaths(pages: Iterable<string>, from: string, to: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of pages) if (p === from || p.startsWith(`${from}/`)) out.set(p, to + p.slice(from.length));
  return out;
}

/**
 * 頁面的連結寫法（和 Azure DevOps 一樣）：每一段的 `-` 寫成 `%2D`、空白寫成 `-`，
 * 會讓 Markdown 連結斷掉的字元（括號、`#`、`?` 等）編碼；中文照原樣。
 */
export function wikiHref(path: string): string {
  const segment = (s: string) =>
    s
      .replace(/%/g, "%25")
      .replace(/-/g, "%2D")
      .replace(/ /g, "-")
      .replace(/[()[\]<>#?"]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `/${path.split("/").filter(Boolean).map(segment).join("/")}`;
}

/** 網址（`https:`、`mailto:`、`//主機`）：不是 Wiki 裡的路徑。 */
const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * 搬移後 `page`（搬移前的路徑）這一頁要改成的內文；沒有要改的回傳 null。
 * `moved` 是搬移的對照（`movedPaths`），`before`／`after` 是搬移前後解析連結的方法（例如 `pageLinkResolver`）。
 * 完整網址、`<網址>` 不改（用頁面編號的網址搬移後還是對的）；改的連結寫成新位置的絕對路徑，保留 `#錨點`。
 */
export function relinkText(
  text: string,
  page: string,
  moved: Map<string, string>,
  before: (href: string, page: string) => string | null,
  after: (href: string, page: string) => string | null,
): string | null {
  const now = moved.get(page) ?? page;
  const edits: { line: number; from: number; to: number; text: string }[] = [];
  for (const span of linkSpans(text)) {
    const href = span.href.trim();
    if (span.bare || !href || href.startsWith("#") || EXTERNAL.test(href)) continue;
    const old = before(href, page);
    if (!old) continue;
    const target = moved.get(old) ?? old;
    if (after(href, now) === target) continue;
    const suffix = /[?#].*$/.exec(href)?.[0] ?? "";
    edits.push({ line: span.line, from: span.from, to: span.to, text: wikiHref(target) + suffix });
  }
  if (!edits.length) return null;
  const lines = text.split("\n");
  // 從後面改回來，前面的位置才不會跑掉。
  for (const e of edits.reverse()) {
    const l = lines[e.line];
    lines[e.line] = l.slice(0, e.from) + e.text + l.slice(e.to);
  }
  return lines.join("\n");
}
