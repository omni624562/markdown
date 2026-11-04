/**
 * 待辦事項、標籤與連結：型別與勾選、顯示用的小工具（待辦總覽、標籤面板與反向連結共用）。
 */

/** 解析在 Rust（`crates/md-text`），桌面版後端的資料夾索引用同一份程式。 */
export type { DocInfo, LinkRef, Task } from "../pkg/md_wasm.js";

const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s+)(.*)$/;
/** 標籤：前面是行首、空白或中文標點，`#` 後面接文字（可以用 `/` 分層，例如 `#專案/A`）。 */
export const TAG = /(?<=^|[\s，、。；：（「『【])#([\p{L}\p{N}_/-]+)/gu;

const pad = (n: number) => String(n).padStart(2, "0");

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

/**
 * 待辦裡的日期寫法，和截止日的解析（crates/md-text 的 parse_due）一樣：`2026-10-25`（也可以用 / 或 .）、
 * `10/25`、`10月25日`。`date` 換成 YYYY-MM-DD（沒寫年份的用截止日的年份）。
 */
const DUE_FORMS: { re: RegExp; date(m: RegExpExecArray, due: string): string }[] = [
  { re: /(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g, date: (m) => `${m[1]}-${pad(+m[2])}-${pad(+m[3])}` },
  { re: /(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g, date: (m, due) => `${due.slice(0, 4)}-${pad(+m[1])}-${pad(+m[2])}` },
  { re: /(?<!\d)(\d{1,2})月(\d{1,2})[日號]/g, date: (m, due) => `${due.slice(0, 4)}-${pad(+m[1])}-${pad(+m[2])}` },
];
/** 日期前後常見的說明（「📅」「截止：」「due:」「前」），和日期一起拿掉。 */
const DUE_BEFORE = /(?:\u{1F4C5}|\u{1F5D3})\u{FE0F}?\s*$|(?:截止(?:日期?)?|due)\s*[:：]?\s*$/iu;
const DUE_AFTER = /^\s*(?:之?前|截止)/u;

/**
 * 待辦總覽顯示的文字拿掉截止日那個日期：日期已經另外標在右邊，不用寫兩次（檔案內容不變）。
 * 找不到和 `due` 相同的日期、或拿掉後什麼都不剩時，照原樣回傳。
 */
export function withoutDue(text: string, due: string): string {
  for (const form of DUE_FORMS) {
    for (const m of text.matchAll(form.re)) {
      if (form.date(m as RegExpExecArray, due) !== due) continue;
      const head = text.slice(0, m.index).replace(DUE_BEFORE, "");
      const tail = text.slice(m.index + m[0].length).replace(DUE_AFTER, "");
      // 英文字之間留一個空白，中文直接接起來。
      const out = (head + (/\w$/.test(head) && /^\w/.test(tail) ? " " : "") + tail)
        .replace(/[（(]\s*[)）]/g, "")
        .replace(/\s{2,}/g, " ")
        .replace(/^[\s，、,;；:：\-—]+|[\s，、,;；:：\-—]+$/g, "");
      return out || text;
    }
  }
  return text;
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
