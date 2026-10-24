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
