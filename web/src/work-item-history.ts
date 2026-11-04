/**
 * 工作項目的修改記錄整理成 Markdown（開在同一個分頁，按上一頁回到工作項目）：
 * 每次修改一段，標題是誰、什麼時候，下面列出改了的欄位（原本 → 之後）、加減的關聯與留言。
 */
import type { AdoRevisionLink, AdoWorkItem, AdoWorkItemRevision } from "./desktop.ts";
import { htmlToMarkdown } from "./html-paste.ts";
import { t } from "./i18n.ts";
import { dateTime, inlineText } from "./issue-doc.ts";

/** 常見欄位的名稱；沒列到的用參考名稱最後一段（例如 Custom.ReleaseNote → ReleaseNote）。 */
const FIELD_NAMES: Record<string, string> = {
  "System.Title": t("標題"),
  "System.State": t("狀態"),
  "System.Reason": t("原因"),
  "System.AssignedTo": t("指派給"),
  "System.IterationPath": t("Sprint"),
  "System.AreaPath": t("區域"),
  "System.Tags": t("標籤"),
  "System.WorkItemType": t("類型"),
  "System.CreatedBy": t("建立者"),
  "System.Description": t("說明"),
  "System.BoardColumn": t("看板欄"),
  "System.BoardLane": t("看板泳道"),
  "Microsoft.VSTS.Common.Priority": t("優先順序"),
  "Microsoft.VSTS.Common.Severity": t("嚴重性"),
  "Microsoft.VSTS.Common.ValueArea": t("價值類別"),
  "Microsoft.VSTS.Common.AcceptanceCriteria": t("驗收條件"),
  "Microsoft.VSTS.Common.ActivatedBy": t("啟用者"),
  "Microsoft.VSTS.Common.ActivatedDate": t("啟用時間"),
  "Microsoft.VSTS.Common.ResolvedBy": t("解決者"),
  "Microsoft.VSTS.Common.ResolvedDate": t("解決時間"),
  "Microsoft.VSTS.Common.ResolvedReason": t("解決原因"),
  "Microsoft.VSTS.Common.ClosedBy": t("關閉者"),
  "Microsoft.VSTS.Common.ClosedDate": t("關閉時間"),
  "Microsoft.VSTS.Common.StackRank": t("Backlog 順序"),
  "Microsoft.VSTS.Common.BacklogPriority": t("Backlog 順序"),
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

/** 欄位值：日期轉成本機時間，其他照原樣（跳脫 Markdown 符號）。 */
function valueText(v: string | null): string {
  if (v === null) return t("（空白）");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return dateTime(v) || inlineText(v);
  return inlineText(v);
}

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

export function historyMarkdown(item: AdoWorkItem, revisions: AdoWorkItemRevision[]): string {
  const label = t("{kind} {id}：{title}", { kind: item.kind, id: item.id, title: item.title });
  const title = "# " + t("修改紀錄：{label}", { label: inlineText(label) });
  if (!revisions.length) return title + "\n\n" + t("還沒有修改紀錄。") + "\n";
  const blocks = revisions.map((r) => {
    const who = inlineText(r.author || t("（不明）"));
    const head = "### " + [who, dateTime(r.date)].filter(Boolean).join(t("・"));
    const lines: string[] = [];
    for (const f of r.fields) {
      const field = "**" + inlineText(fieldName(f.field)) + "**";
      if (f.long) lines.push("- " + t("{field}：內容有修改", { field }));
      else if (f.old === null) lines.push("- " + t("{field}：{value}", { field, value: valueText(f.new) }));
      else lines.push("- " + t("{field}：{old} → {new}", { field, old: valueText(f.old), new: valueText(f.new) }));
    }
    for (const l of r.added) lines.push("- " + t("加入{link}", { link: linkText(item, l) }));
    for (const l of r.removed) lines.push("- " + t("移除{link}", { link: linkText(item, l) }));
    const parts = [head];
    if (lines.length) parts.push(lines.join("\n"));
    if (r.comment) {
      const md = htmlToMarkdown(r.comment, { keepImages: true }).trim();
      if (md) parts.push(t("留言：") + "\n\n" + md.split("\n").map((l) => "> " + l).join("\n"));
    }
    return parts.join("\n\n");
  });
  return title + "\n\n" + blocks.join("\n\n") + "\n";
}
