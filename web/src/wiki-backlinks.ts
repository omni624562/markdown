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
const INLINE = /(!?)\[(?:[^\]\\\n]|\\.)*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g;
/** 參考式連結的定義：`[名稱]: 網址`。 */
const REFERENCE = /^ {0,3}\[[^\]\n]+\]:\s*<?([^\s>]+)>?/;
const ANCHOR = /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
/** `<https://…>` 或直接寫的網址（中文標點、括號不算在網址裡）。 */
const BARE_URL = /<?(https?:\/\/[^\s<>)\]"'。，、；：！？「」（）]+)>?/g;

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

/**
 * 內文裡的連結：行內連結、參考式連結的定義、`<a href>`、`<網址>` 與直接寫的網址。
 * 程式碼區塊、行內程式碼、HTML 註解裡的不算；圖片不算。同一行同一個網址只算一次。
 */
export function linksIn(markdown: string): PageLink[] {
  const out: PageLink[] = [];
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
    const seen = new Set<string>();
    const add = (href: string | undefined) => {
      const h = href?.trim();
      if (!h || h.startsWith("#") || seen.has(h)) return;
      seen.add(h);
      out.push({ href: h, line: i + 1, text: shown(raw) });
    };
    // 已經算過的範圍（行內連結的網址不要再當成直接寫的網址算一次）。
    let rest = line;
    for (const m of line.matchAll(INLINE)) {
      if (!m[1]) add(m[2] ?? m[3]);
      rest = rest.slice(0, m.index) + " ".repeat(m[0].length) + rest.slice(m.index + m[0].length);
    }
    add(REFERENCE.exec(rest)?.[1]);
    for (const m of rest.matchAll(ANCHOR)) {
      add(m[1] ?? m[2]);
      rest = rest.slice(0, m.index) + " ".repeat(m[0].length) + rest.slice(m.index + m[0].length);
    }
    for (const m of rest.matchAll(BARE_URL)) add(m[1].replace(/[.,;:!?]+$/, ""));
  }
  return out;
}

/**
 * 連到 `target` 的地方：`sources` 是每一頁的內文（依頁面樹的順序），`resolve(href, page)` 是 `page` 裡的連結
 * 指到哪一頁（找不到是 null）。自己連到自己的不算；同一頁連好幾次都列出（依行號）。
 */
export function findBacklinks(
  target: string,
  sources: Iterable<{ page: string; text: string }>,
  resolve: (href: string, page: string) => string | null,
): Backlink[] {
  const key = target.toLowerCase();
  const out: Backlink[] = [];
  for (const { page, text } of sources) {
    if (page.toLowerCase() === key) continue;
    for (const link of linksIn(text)) {
      if (resolve(link.href, page)?.toLowerCase() === key) out.push({ page, line: link.line, text: link.text });
    }
  }
  return out;
}
