/**
 * 工作項目的修改紀錄整理成 Markdown（開在同一個分頁，按上一頁回到工作項目）：
 * 最上面是標題與「共幾次修改」，接著依日期分段（最新的在前），每次修改一項「誰・幾點」，
 * 下面列出改了的欄位（原本 → 之後）、加減的關聯與留言。
 *
 * 讓清單好讀：
 * - 同一個人 10 分鐘內連續的幾次修改合成一項（欄位的原本取最早那次、之後取最新那次）。
 * - 雜訊不列：看板的重複欄位（Kanban Column、Done、Lane）、ExtensionMarker，以及狀態改變時
 *   自動填上的啟用、解決、關閉者與時間；Backlog 順序只寫「調整 Backlog 順序」，不寫數字，
 *   只調整了 Backlog 順序的那幾次不列出，在最上面註明次數。
 * - 狀態和原因一起改時寫成一項：「狀態：New → Active（Implementation started）」。
 *
 * 畫面上的樣子（時間軸、頭像、欄位對齊）由 ui/work-item-history-look.ts 在畫好之後調整；
 * 「複製成 Markdown 文件」存下來的還是這份 Markdown。
 */
import type { AdoFieldChange, AdoRevisionLink, AdoWorkItem, AdoWorkItemRevision } from "./desktop.ts";
import { htmlToMarkdown } from "./html-paste.ts";
import { currentLang, t } from "./i18n.ts";
import { dateTime, inlineText } from "./issue-doc.ts";

/**
 * 常見欄位的名稱；沒列到的用參考名稱最後一段（例如 Custom.ReleaseNote → ReleaseNote）。
 * 標題、說明用「工作項目標題」「工作項目說明」：單獨的「標題」「說明」在英文介面是 Heading、Help。
 */
const FIELD_NAMES: Record<string, string> = {
  "System.Title": t("工作項目標題"),
  "System.State": t("狀態"),
  "System.Reason": t("原因"),
  "System.AssignedTo": t("指派給"),
  "System.IterationPath": t("Sprint"),
  "System.AreaPath": t("區域"),
  "System.Tags": t("標籤"),
  "System.WorkItemType": t("類型"),
  "System.CreatedBy": t("建立者"),
  "System.Description": t("工作項目說明"),
  "System.BoardColumn": t("看板欄"),
  "System.BoardLane": t("看板泳道"),
  "Microsoft.VSTS.Common.Priority": t("優先順序"),
  "Microsoft.VSTS.Common.Severity": t("嚴重性"),
  "Microsoft.VSTS.Common.ValueArea": t("價值類別"),
  "Microsoft.VSTS.Common.AcceptanceCriteria": t("驗收條件"),
  "Microsoft.VSTS.Common.ResolvedReason": t("解決原因"),
  "Microsoft.VSTS.Scheduling.RemainingWork": t("剩餘工時"),
  "Microsoft.VSTS.Scheduling.CompletedWork": t("已完成工時"),
  "Microsoft.VSTS.Scheduling.OriginalEstimate": t("原始估計"),
  "Microsoft.VSTS.Scheduling.StoryPoints": t("故事點數"),
  "Microsoft.VSTS.Scheduling.Effort": t("工作量"),
  "Microsoft.VSTS.Scheduling.StartDate": t("開始日期"),
  "Microsoft.VSTS.Scheduling.FinishDate": t("完成日期"),
  "Microsoft.VSTS.Scheduling.TargetDate": t("目標日期"),
  "Microsoft.VSTS.TCM.ReproSteps": t("重現步驟"),
  "Microsoft.VSTS.TCM.SystemInfo": t("系統資訊"),
};

export function fieldName(field: string): string {
  return FIELD_NAMES[field] ?? field.slice(field.lastIndexOf(".") + 1);
}

/** 不列出的欄位：狀態改變時自動填的人與時間、ExtensionMarker。 */
const HIDDEN_FIELDS = new Set([
  "System.ExtensionMarker",
  "Microsoft.VSTS.Common.ActivatedBy",
  "Microsoft.VSTS.Common.ActivatedDate",
  "Microsoft.VSTS.Common.ResolvedBy",
  "Microsoft.VSTS.Common.ResolvedDate",
  "Microsoft.VSTS.Common.ClosedBy",
  "Microsoft.VSTS.Common.ClosedDate",
]);

/** 看板自己的欄（`WEF_…_Kanban.Column`、`.Column.Done`、`.Lane`）：和看板欄（System.BoardColumn）重複。 */
const KANBAN_FIELD = /^WEF_[^.]*_Kanban\./;

/** Backlog 順序：數字沒有意義，只寫「調整 Backlog 順序」。 */
const RANK_FIELDS = new Set(["Microsoft.VSTS.Common.StackRank", "Microsoft.VSTS.Common.BacklogPriority"]);

function hiddenField(field: string): boolean {
  return HIDDEN_FIELDS.has(field) || KANBAN_FIELD.test(field);
}

/** 欄位的排列順序：常看的在前面（和桌面端一樣），其他照名稱。 */
const FIRST_FIELDS = [
  "System.Title",
  "System.State",
  "System.Reason",
  "System.AssignedTo",
  "System.IterationPath",
  "System.AreaPath",
  "Microsoft.VSTS.Common.Priority",
  "Microsoft.VSTS.Scheduling.RemainingWork",
  "Microsoft.VSTS.Scheduling.CompletedWork",
  "System.Tags",
];

function compareFields(a: string, b: string): number {
  const rank = (f: string) => {
    const i = FIRST_FIELDS.indexOf(f);
    return i < 0 ? FIRST_FIELDS.length : i;
  };
  return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** 數字去掉小數點後面多餘的 0（`4.0` → `4`、`2.50` → `2.5`）；不是數字的照原樣。 */
export function numberText(v: string): string {
  const m = /^(-?\d+)\.(\d*?)0+$/.exec(v);
  return m ? m[1] + (m[2] ? "." + m[2] : "") : v;
}

/** 文字欄位：看起來像數字也照原樣（標題「2.0」、組建編號「2026.10」不能改成「2」「2026.1」）。 */
const TEXT_FIELDS = new Set(["System.Title", "System.Tags", "Microsoft.VSTS.Build.FoundIn", "Microsoft.VSTS.Build.IntegrationBuild"]);

const plain = (field: string, v: string) => (TEXT_FIELDS.has(field) ? v : numberText(v));

/** 欄位值：日期轉成本機時間，數字去掉多餘的 0，其他照原樣（跳脫 Markdown 符號）。 */
function valueText(field: string, v: string | null): string {
  if (v === null) return t("（空白）");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return dateTime(v) || inlineText(v);
  return inlineText(plain(field, v));
}

const same = (field: string, a: string | null, b: string | null) => (a === null || b === null ? a === b : plain(field, a) === plain(field, b));

const LINK_LABELS: Record<AdoRevisionLink["kind"], string> = {
  parent: t("上層"),
  child: t("子項目"),
  related: t("相關"),
  predecessor: t("前置項目"),
  successor: t("後續項目"),
  attachment: t("附件"),
  hyperlink: t("超連結"),
  other: t("連結"),
};

/** 連到工作項目：網址和這個工作項目同一個專案（Azure DevOps 會自己導到對的專案）。 */
export function workItemUrl(base: AdoWorkItem, id: number): string {
  return base.webUrl.replace(/\/_workitems\/edit\/\d+/, `/_workitems/edit/${id}`);
}

function linkText(item: AdoWorkItem, l: AdoRevisionLink): string {
  const label = LINK_LABELS[l.kind] ?? LINK_LABELS.other;
  const target = l.id !== null ? `[#${l.id}](<${workItemUrl(item, l.id)}>)` : inlineText(l.name);
  return label + " " + target;
}

/** 同一個人連續修改，間隔小於這個時間（毫秒）就合成一項。 */
const MERGE_GAP = 10 * 60 * 1000;

/** 合併之後的一項修改。 */
export interface HistoryEntry {
  author: string;
  /** 最新那一次的時間。 */
  date: string | null;
  fields: AdoFieldChange[];
  added: AdoRevisionLink[];
  removed: AdoRevisionLink[];
  /** 留言（HTML），舊到新。 */
  comments: string[];
}

const timeOf = (date: string | null) => (date ? Date.parse(date) : NaN);
const linkKey = (l: AdoRevisionLink) => `${l.kind}\u0000${l.id ?? ""}\u0000${l.name}`;

function unionLinks(lists: AdoRevisionLink[][]): AdoRevisionLink[] {
  const seen = new Map<string, AdoRevisionLink>();
  for (const l of lists.flat()) if (!seen.has(linkKey(l))) seen.set(linkKey(l), l);
  return [...seen.values()];
}

/** 一組連續的修改（新到舊）合成一項：同一個欄位的原本取最早那次、之後取最新那次，結果沒變的不列。 */
function mergeGroup(group: AdoWorkItemRevision[]): HistoryEntry {
  const oldestFirst = [...group].reverse();
  const fields = new Map<string, AdoFieldChange>();
  for (const r of oldestFirst) {
    for (const f of r.fields) {
      const had = fields.get(f.field);
      if (had) fields.set(f.field, { ...had, new: f.new, long: had.long || f.long });
      else fields.set(f.field, { ...f });
    }
  }
  return {
    author: group[0].author,
    date: group[0].date,
    fields: [...fields.values()].filter((f) => f.long || !same(f.field, f.old, f.new)).sort((a, b) => compareFields(a.field, b.field)),
    added: unionLinks(oldestFirst.map((r) => r.added)),
    removed: unionLinks(oldestFirst.map((r) => r.removed)),
    comments: oldestFirst.flatMap((r) => (r.comment ? [r.comment] : [])),
  };
}

/** 同一個人、和前一次間隔不到 10 分鐘的連續修改合成一項（輸入與輸出都是新到舊）。 */
export function mergeRevisions(revisions: AdoWorkItemRevision[]): HistoryEntry[] {
  const groups: AdoWorkItemRevision[][] = [];
  for (const r of revisions) {
    const group = groups[groups.length - 1];
    const prev = group?.[group.length - 1];
    if (prev && prev.author === r.author && Math.abs(timeOf(prev.date) - timeOf(r.date)) < MERGE_GAP) group.push(r);
    else groups.push([r]);
  }
  return groups.map(mergeGroup);
}

/** 留言轉成 Markdown，放在引言裡（每一行前面加 `>`），第一行前面標「留言：」。 */
function commentLines(html: string): string[] {
  const md = htmlToMarkdown(html, { keepImages: true }).trim();
  if (!md) return [];
  const lines = md.split("\n");
  // 第一行是一般的文字：「留言：」接在前面；是標題、清單、程式碼等區塊：「留言：」自己一行。
  if (!/^(?:#{1,6}(?:\s|$)|>|[-*+](?:\s|$)|\d+[.)](?:\s|$)|```|~~~|\||<|\s{4}|\t)/.test(lines[0])) {
    lines[0] = t("留言：{text}", { text: lines[0] });
  } else lines.unshift(t("留言："), "");
  return lines;
}

/**
 * 一項修改裡要列出的內容（Markdown 清單項目，不含前面的 `- `）。
 * `onlyReorder`：除了不列出的欄位，只調整了 Backlog 順序。
 */
function changeLines(item: AdoWorkItem, e: HistoryEntry): { lines: string[]; onlyReorder: boolean } {
  const shown = e.fields.filter((f) => !hiddenField(f.field) && !RANK_FIELDS.has(f.field));
  const reason = shown.find((f) => f.field === "System.Reason");
  const state = shown.find((f) => f.field === "System.State");
  const lines: string[] = [];
  for (const f of shown) {
    // 狀態和原因一起改：原因寫在狀態後面的括號裡（和新的狀態同名時不寫，例如建立時的 New（New））。
    if (f === reason && state) continue;
    const field = "**" + inlineText(fieldName(f.field)) + "**";
    let value = f.long
      ? t("內容有修改")
      : f.old === null
        ? valueText(f.field, f.new)
        : t("{old} → {new}", { old: valueText(f.field, f.old), new: valueText(f.field, f.new) });
    if (f === state && reason && reason.new !== null && !same(reason.field, reason.new, state.new)) {
      value = t("{value}（{reason}）", { value, reason: valueText(reason.field, reason.new) });
    }
    lines.push(t("{field}：{value}", { field, value }));
  }
  const reordered = e.fields.some((f) => RANK_FIELDS.has(f.field));
  if (reordered) lines.push(t("調整 Backlog 順序"));
  for (const l of e.added) lines.push(t("加入{link}", { link: linkText(item, l) }));
  for (const l of e.removed) lines.push(t("移除{link}", { link: linkText(item, l) }));
  return { lines, onlyReorder: reordered && lines.length === 1 };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 分段用的日期（本地時間）：`2026-09-23`；沒有時間的是空字串。 */
function dayKey(date: string | null): string {
  const d = new Date(timeOf(date));
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 分段的標題：「2026年9月23日 週三」「Wed, Sep 23, 2026」。 */
export function dayLabel(date: string | null): string {
  const d = new Date(timeOf(date));
  if (Number.isNaN(d.getTime())) return t("（不明）");
  return new Intl.DateTimeFormat(currentLang(), { year: "numeric", month: "short", day: "numeric", weekday: "short" }).format(d);
}

/** 幾點幾分（24 小時制）。 */
function clock(date: string | null): string {
  const d = new Date(timeOf(date));
  return Number.isNaN(d.getTime()) ? "" : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function historyMarkdown(item: AdoWorkItem, revisions: AdoWorkItemRevision[]): string {
  const label = t("{kind} {id}：{title}", { kind: item.kind, id: item.id, title: item.title });
  const title = "# " + t("修改紀錄：{label}", { label: inlineText(label) });
  let reorders = 0;
  const entries: { entry: HistoryEntry; lines: string[]; comment: string[] }[] = [];
  for (const entry of mergeRevisions(revisions)) {
    const { lines, onlyReorder } = changeLines(item, entry);
    const comment = entry.comments.map(commentLines).filter((c) => c.length);
    if (comment.length) {
      entries.push({ entry, lines, comment: comment.flatMap((c, i) => (i ? ["", ...c] : c)) });
    } else if (onlyReorder) {
      // 只調整了 Backlog 順序：不列出，最上面註明次數。
      reorders++;
    } else if (lines.length) {
      entries.push({ entry, lines, comment: [] });
    }
    // 其他（改的都是不列出的欄位）：直接略過。
  }
  const note = reorders ? t("（另有 {n} 次只調整 Backlog 順序，沒有列出）", { n: reorders }) : "";
  if (!entries.length) return title + "\n\n" + t("還沒有修改紀錄。") + note + "\n";

  const days: { label: string; items: string[] }[] = [];
  let lastDay: string | null = null;
  for (const { entry, lines, comment } of entries) {
    const key = dayKey(entry.date);
    if (key !== lastDay) {
      days.push({ label: dayLabel(entry.date), items: [] });
      lastDay = key;
    }
    const who = "**" + inlineText(entry.author || t("（不明）")) + "**";
    const time = clock(entry.date);
    const out = ["- " + (time ? who + t("・") + time : who)];
    for (const l of lines) out.push("  - " + l);
    for (const l of comment) out.push(l ? "  > " + l : "  >");
    days[days.length - 1].items.push(out.join("\n"));
  }
  const summary = t("共 {n} 次修改", { n: entries.length }) + note;
  const body = days.map((d) => "## " + inlineText(d.label) + "\n\n" + d.items.join("\n"));
  return [title, summary, ...body].join("\n\n") + "\n";
}
