/**
 * 每日筆記（不碰畫面，方便測試）：檔名是日期（`2026-11-02.md`），放在開啟的資料夾裡指定的子資料夾；
 * 前一天、後一天是找最近一份「有寫」的筆記（中間沒寫的日子跳過）。
 */
import { workItemLink } from "./ado-text.ts";
import type { AdoWorkItem } from "./desktop.ts";
import { currentLang } from "./i18n.ts";
import { dayOf } from "./doc-stats-text.ts";

/** 每日筆記的檔名：`YYYY-MM-DD.md`（本機日期）。 */
export function dailyName(date: Date): string {
  return `${dayOf(date)}.md`;
}

/** 檔名是每日筆記時回傳日期（`YYYY-MM-DD`），不是時回傳 null。不存在的日期（2 月 30 日）不算。 */
export function dateOfDaily(name: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})\.(?:md|markdown)$/i.exec(name);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** 資料夾名稱裡不能用的字元（Windows 的限制，遠端資料夾也一樣擋，免得換台電腦打不開）。 */
const BAD_NAME = /[<>:"|?*\u0000-\u001f]/;

/**
 * 設定裡寫的資料夾（相對於開啟的資料夾）拆成一層一層：`/`、`\` 都可以，前後空白與多餘的分隔拿掉。
 * 空白代表放在最上層（回傳空陣列）；有 `..`、不能用的字元或名稱以句點、空白結尾時回傳 null。
 */
export function folderSegments(input: string): string[] | null {
  const parts = input
    .split(/[\\/]/)
    .map((s) => s.trim())
    .filter((s) => s && s !== ".");
  if (parts.some((s) => s === ".." || BAD_NAME.test(s) || /[. ]$/.test(s) || s.length > 100)) return null;
  return parts;
}

/** 設定值整理成一致的寫法（`筆記/每日`）；不合法時回傳 null。 */
export function cleanFolder(input: string): string | null {
  const parts = folderSegments(input);
  return parts ? parts.join("/") : null;
}

/**
 * 從 `from`（`YYYY-MM-DD`）往前（`step` = -1）或往後（1）找最近一份每日筆記的檔名；沒有時回傳 null。
 * `names` 是資料夾裡的檔名，不是每日筆記的會略過。
 */
export function neighborNote(names: readonly string[], from: string, step: -1 | 1): string | null {
  let best: { name: string; date: string } | null = null;
  for (const name of names) {
    const date = dateOfDaily(name);
    if (!date || (step < 0 ? date >= from : date <= from)) continue;
    if (!best || (step < 0 ? date > best.date : date < best.date)) best = { name, date };
  }
  return best?.name ?? null;
}

/** 內建的每日筆記範本（變數的寫法同文件範本，見 templates.ts）。`{{工作項目}}` 那一段只在連上 Azure DevOps 時加上。 */
// i18n-ignore（範本內容）
const ZH_DAILY = `# {{日期}}（星期{{星期}}）

## 今天要做

- [ ]
{{work}}
## 會議與討論

## 筆記
`;

const EN_DAILY = `# {{date}} ({{weekday}})

## To Do

- [ ]
{{work}}
## Meetings

## Notes
`;

// i18n-ignore（範本內容）
const ZH_WORK = "\n## 工作項目\n\n{{工作項目}}\n";
const EN_WORK = "\n## Work Items\n\n{{workitems}}\n";

/** 內建的每日筆記範本；`withWorkItems`：連上 Azure DevOps 時多一段指派給你的工作項目。 */
export function dailyTemplate(withWorkItems: boolean): string {
  const en = currentLang() === "en";
  return (en ? EN_DAILY : ZH_DAILY).replace("{{work}}", withWorkItems ? (en ? EN_WORK : ZH_WORK) : "");
}

/** 說明裡寫的變數名稱（兩種寫法都認得）。 */
// i18n-ignore（範本變數的名稱）
export const WORK_ITEMS_VAR = currentLang() === "en" ? "{{workitems}}" : "{{工作項目}}";

/** 範本裡單獨一行的 `{{工作項目}}`（或 `{{workitems}}`）。 */
const WORK_ITEMS_LINE = /^[ \t]*\{\{\s*(?:工作項目|workitems)\s*\}\}[ \t]*$/gm;

/** 範本裡有沒有工作項目的變數（有才去讀，免得沒用到也要等伺服器）。 */
export function hasWorkItemsVar(body: string): boolean {
  WORK_ITEMS_LINE.lastIndex = 0;
  return WORK_ITEMS_LINE.test(body);
}

/** 工作項目的待辦清單：優先順序高的在前，一樣時最近更新的在前；每一項是連到工作項目的連結。 */
export function workItemChecklist(items: readonly AdoWorkItem[]): string {
  const time = (w: AdoWorkItem) => (w.changed ? Date.parse(w.changed) || 0 : 0);
  return [...items]
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || time(b) - time(a))
    .map((w) => `- [ ] ${workItemLink(w)}`)
    .join("\n");
}

/**
 * 把範本裡的 `{{工作項目}}` 換成待辦清單。`items` 是 null（沒有連上、讀不到）時拿掉那一行；
 * 沒有工作項目時寫 `none`（例如「目前沒有指派給你的工作項目」）。
 */
export function fillWorkItems(body: string, items: readonly AdoWorkItem[] | null, none: string): string {
  return body.replace(WORK_ITEMS_LINE, () => (items === null ? "" : items.length ? workItemChecklist(items) : none));
}

/**
 * 建立後游標的位置：第一個空的待辦（`- [ ]`）後面，直接打字就是今天的第一件事（行尾補一個空白）；
 * 範本裡沒有空的待辦時放在最後。`line`、`column` 從 1 算起。
 */
export function withCursor(body: string): { text: string; line: number; column: number } {
  const lines = body.split("\n");
  const i = lines.findIndex((l) => /^\s*[-*+] \[ \]\s*$/.test(l));
  if (i < 0) return { text: body, line: lines.length, column: lines[lines.length - 1].length + 1 };
  lines[i] = `${lines[i].trimEnd()} `;
  return { text: lines.join("\n"), line: i + 1, column: lines[i].length + 1 };
}
