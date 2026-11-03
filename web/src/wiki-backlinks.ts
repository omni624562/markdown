/**
 * 哪些 Wiki 頁面連到這一頁（不碰畫面，方便測試）：找出每一頁內文裡的連結，看指到哪一頁。
 * 改名、搬移或刪除前先知道會影響哪些頁面。
 */

/** 內文裡的一個連結：原始寫法、第幾行（從 1 算起）、那一行的文字（給清單顯示）。 */
export interface PageLink {
  href: string;
  line: number;
  text: string;
}

/** 連到某一頁的地方。 */
export interface Backlink {
  page: string;
  line: number;
  text: string;
}

/** 清單上那一行最多顯示幾個字。 */
const TEXT_MAX = 160;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** `[文字](網址 "標題")`、`[文字](<網址>)`；`!` 開頭的是圖片。 */
const INLINE = /(!?)\[(?:[^\]\\\n]|\\.)*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/dg;
/** 參考式連結的定義：`[名稱]: 網址`。 */
const REFERENCE = /^ {0,3}\[[^\]\n]+\]:\s*<?([^\s>]+)>?/d;
const ANCHOR = /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')/dgi;
/** `<https://…>` 或直接寫的網址（中文標點、括號不算在網址裡）。 */
const BARE_URL = /<?(https?:\/\/[^\s<>)\]"'。，、；：！？「」（）]+)>?/dg;

/** 那一行的行內程式碼換成空白（位置不變），裡面的連結不算。 */
function withoutCode(line: string): string {
  return line.replace(/(`+)[^`]*?\1/g, (m) => " ".repeat(m.length));
}

/** 去掉 HTML 註解（同一行裡的）。 */
function withoutComments(line: string): string {
  return line.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
}

/** 給清單顯示的那一行：去掉前後空白，太長時截斷。 */
function shown(line: string): string {
  const s = line.trim();
  return [...s].length > TEXT_MAX ? `${[...s].slice(0, TEXT_MAX).join("")}…` : s;
}

/** 內文裡一個連結的網址在哪裡：第幾行（從 0 算起）與那一行裡的起訖位置。 */
export interface LinkSpan {
  href: string;
  line: number;
  from: number;
  to: number;
  /** 直接寫的網址或 `<網址>`（不是 `[文字](網址)`、參考式定義或 `<a href>`）。 */
  bare: boolean;
}

/**
 * 內文裡所有連結網址的位置：行內連結、參考式連結的定義、`<a href>`、`<網址>` 與直接寫的網址。
 * 程式碼區塊、行內程式碼、HTML 註解裡的不算；圖片不算。依出現的順序。
 */
export function linkSpans(markdown: string): LinkSpan[] {
  const out: LinkSpan[] = [];
  let fence: string | null = null;
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const f = FENCE.exec(raw)?.[1];
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f;
      continue;
    }
    const line = withoutComments(withoutCode(raw));
    const found: LinkSpan[] = [];
    const add = (at: [number, number] | undefined, bare = false) => {
      if (!at) return;
      const href = raw.slice(at[0], at[1]);
      if (href.trim()) found.push({ href, line: i, from: at[0], to: at[1], bare });
    };
    // 算過的範圍蓋掉（行內連結的網址不要再當成直接寫的網址算一次）。
    let rest = line;
    const blank = (from: number, to: number) => (rest = rest.slice(0, from) + " ".repeat(to - from) + rest.slice(to));
    for (const m of line.matchAll(INLINE)) {
      if (!m[1]) add(m.indices![2] ?? m.indices![3]);
      blank(m.index, m.index + m[0].length);
    }
    const ref = REFERENCE.exec(rest);
    if (ref) {
      add(ref.indices![1]);
      blank(ref.index, ref.index + ref[0].length);
    }
    for (const m of rest.matchAll(ANCHOR)) {
      add(m.indices![1] ?? m.indices![2]);
      blank(m.index, m.index + m[0].length);
    }
    for (const m of rest.matchAll(BARE_URL)) {
      const [from, to] = m.indices![1];
      add([from, to - (m[1].length - m[1].replace(/[.,;:!?]+$/, "").length)], true);
    }
    out.push(...found.sort((a, b) => a.from - b.from));
  }
  return out;
}

/**
 * 內文裡的連結（給清單用）：同一行同一個網址只算一次，只有 `#` 的錨點不算。
 */
export function linksIn(markdown: string): PageLink[] {
  const lines = markdown.split(/\r?\n/);
  const out: PageLink[] = [];
  const seen = new Set<string>();
  for (const span of linkSpans(markdown)) {
    const href = span.href.trim();
    const key = `${span.line}\n${href}`;
    if (href.startsWith("#") || seen.has(key)) continue;
    seen.add(key);
    out.push({ href, line: span.line + 1, text: shown(lines[span.line]) });
  }
  return out;
}

/**
 * 連到 `targets`（頁面路徑，例如要刪除的頁面和它的子頁面）的地方：`sources` 是每一頁的內文（依頁面樹的順序），
 * `resolve(href, page)` 是 `page` 裡的連結指到哪一頁（找不到是 null）。
 * `targets` 自己的內文不算（自己連到自己、要一起刪的頁面互相連）；同一頁連好幾次都列出（依行號）。
 */
export function findBacklinks(
  targets: Iterable<string>,
  sources: Iterable<{ page: string; text: string }>,
  resolve: (href: string, page: string) => string | null,
): Backlink[] {
  const keys = new Set([...targets].map((p) => p.toLowerCase()));
  const out: Backlink[] = [];
  for (const { page, text } of sources) {
    if (keys.has(page.toLowerCase())) continue;
    for (const link of linksIn(text)) {
      const to = resolve(link.href, page);
      if (to && keys.has(to.toLowerCase())) out.push({ page, line: link.line, text: link.text });
    }
  }
  return out;
}
