/**
 * 從 Markdown 文件中找出待辦事項、標籤與連結（待辦總覽、標籤面板與反向連結共用）。
 * 程式碼區塊、行內程式碼與 HTML 註解裡的內容不算。
 */

export interface Task {
  /** 第幾行（從 1 開始）。 */
  line: number;
  done: boolean;
  /** 勾選框後面的文字（原始 Markdown）。 */
  text: string;
  /** `@名字` 標記的負責人。 */
  owners: string[];
  /** 截止日（YYYY-MM-DD），沒寫就是 null。 */
  due: string | null;
}

export interface LinkRef {
  line: number;
  /** `[[週報]]` 的「週報」，或 `[說明](筆記/會議.md#標題)` 的「筆記/會議.md」（已解碼）。 */
  target: string;
  kind: "wiki" | "markdown";
}

export interface DocInfo {
  tasks: Task[];
  tags: string[];
  links: LinkRef[];
}

const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s+)(.*)$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
export const WIKI = /\[\[([^[\]|#\n]+)(?:#[^[\]|\n]*)?(?:\|[^[\]\n]*)?\]\]/g;
const MD_LINK = /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;
/** 標籤：前面是行首、空白或中文標點，`#` 後面接文字（可以用 `/` 分層，例如 `#專案/A`）。 */
export const TAG = /(?<=^|[\s，、。；：（「『【])#([\p{L}\p{N}_/-]+)/gu;
const OWNER = /(?<=^|[\s，、：:（(])@([\p{L}\p{N}_-]+)/gu;

/** 把行內程式碼換成空白（長度不變，位置才對得上）。 */
function blankCode(line: string): string {
  return line.replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, (m) => " ".repeat(m.length));
}

export function parseDoc(text: string, today = new Date()): DocInfo {
  const tasks: Task[] = [];
  const tags = new Set<string>();
  const links: LinkRef[] = [];
  let fence: string | null = null;
  let comment = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const f = raw.match(FENCE);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !raw.trim().slice(f[1].length)) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    let line = blankCode(raw);
    // HTML 註解（可以跨行）
    if (comment) {
      const end = line.indexOf("-->");
      if (end < 0) continue;
      comment = false;
      line = " ".repeat(end + 3) + line.slice(end + 3);
    }
    line = line.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
    const open = line.indexOf("<!--");
    if (open >= 0) {
      comment = true;
      line = line.slice(0, open);
    }
    const t = line.match(TASK);
    if (t) {
      const body = raw.slice(raw.length - t[4].length);
      tasks.push({
        line: i + 1,
        done: t[2] !== " ",
        text: body,
        owners: owners(blankCode(body)),
        due: parseDue(blankCode(body), today),
      });
    }
    for (const m of line.matchAll(TAG)) {
      const tag = m[1].replace(/[/-]+$/, "");
      if (tag && !/^\d+$/.test(tag)) tags.add(tag);
    }
    for (const m of line.matchAll(WIKI)) links.push({ line: i + 1, target: m[1].trim(), kind: "wiki" });
    for (const m of line.matchAll(MD_LINK)) {
      const href = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) continue;
      let target = href.split("#")[0];
      try {
        target = decodeURIComponent(target);
      } catch {
        // 不是合法的 %XX 編碼：照原樣
      }
      if (target) links.push({ line: i + 1, target, kind: "markdown" });
    }
  }
  return { tasks, tags: [...tags], links };
}

export function owners(text: string): string[] {
  return [...new Set([...text.matchAll(OWNER)].map((m) => m[1].replace(/[-_]+$/, "")))].filter(Boolean);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 待辦的截止日：`2026-10-25`、`2026/10/25`、`10/25`、`10月25日`（沒寫年份就是今年）。 */
export function parseDue(text: string, today = new Date()): string | null {
  const valid = (y: number, m: number, d: number) => {
    const date = new Date(y, m - 1, d);
    return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
  };
  const full = text.match(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/);
  if (full) return valid(+full[1], +full[2], +full[3]);
  const short = text.match(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/) ?? text.match(/(?<!\d)(\d{1,2})月(\d{1,2})[日號]/);
  if (short) return valid(today.getFullYear(), +short[1], +short[2]);
  return null;
}

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 勾選或取消勾選一行待辦；不是待辦時回傳 null。 */
export function setTaskLine(line: string, done: boolean): string | null {
  const m = line.match(TASK);
  return m ? m[1] + (done ? "x" : " ") + m[3] + m[4] : null;
}

/** 勾選或取消勾選第 `line` 行的待辦；那一行不是待辦時回傳 null。 */
export function setTaskDone(text: string, line: number, done: boolean): string | null {
  const lines = text.split("\n");
  const next = setTaskLine(lines[line - 1] ?? "", done);
  if (next === null) return null;
  lines[line - 1] = next;
  return lines.join("\n");
}

/** 待辦清單中顯示的文字：去掉 Markdown 符號（連結只留文字）。 */
export function plainTaskText(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/(\*\*|__|~~|==)(.+?)\1/g, "$2")
    .replace(/(?<![\w*])[*_](?!\s)(.+?)(?<!\s)[*_](?![\w*])/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<\/?(?:u|mark|sup|sub|ins)>/g, "")
    .trim();
}
