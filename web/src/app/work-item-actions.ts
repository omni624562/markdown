/**
 * 工作項目：在主要區域開啟，內容上方的欄位直接改（狀態、指派、優先順序、Sprint、標題、標籤），留言框在留言段落。
 */
import { type AdoWorkItem, type AdoWorkItemChange, type AdoWorkItemDetail, desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { timeAgo } from "../history-label.ts";
import { issueFileName, stateTone, workItemMarkdown, workItemIdOf } from "../issue-doc.ts";
import type { IssueFact } from "../ui/issue-view.ts";
import { toast } from "../ui/toast.ts";
import { decorateAttachments } from "../ui/work-item-attachments.ts";
import { decorateWorkItem, type SectionKind } from "../ui/work-item-look.ts";
import { decorateMarks } from "../ui/work-item-marks.ts";
import * as storage from "../storage.ts";
import { isWorkItemShortcut } from "../wiki-shortcuts.ts";
import { type Iteration, longFields } from "../work-item-fields.ts";
import { openAttachment, saveAttachment } from "./ado-files.ts";
import { insertIssueLink } from "./ado-links.ts";
import { forgetListCopies, offlineRefs } from "./offline-copies.ts";
import { workItemSeen } from "./work-item-updates.ts";
import { workItemsPanel, barShortcuts, toggleWorkItemShortcut } from "./work-items-panel.ts";
import { enhanceWorkItem, lazy, type Loaded } from "./work-item-edit.ts";
import { app } from "./context.ts";
import { workItemLoaded } from "./work-item-updates.ts";


/** 每種工作項目可以設定的狀態（同一個專案、類型只讀一次）。 */
const workItemStates = new Map<string, Loaded<string[]>>();
/** 每個專案的 Sprint（只讀一次）。 */
const projectIterations = new Map<string, Loaded<Iteration[]>>();

/** 工作項目的修改：送出變更、讀到最新內容時記下來（狀態、指派、修訂版本），內容畫好之後加上修改的方式。 */
function workItemEditing(item: AdoWorkItem): { update(d: AdoWorkItemDetail): void; enhance(body: HTMLElement): void } {
  let detail: AdoWorkItemDetail | null = null;
  let busy = false;
  const statesKey = `${item.project}|${item.kind}`;
  let states = workItemStates.get(statesKey);
  if (!states) workItemStates.set(statesKey, (states = lazy(() => desktop!.adoWorkItemStates(item.project, item.kind))));
  let iterations = projectIterations.get(item.project);
  if (!iterations) projectIterations.set(item.project, (iterations = lazy(() => desktop!.adoIterations(item.project))));

  /** 送出變更；成功後重新讀取內容與清單。 */
  const apply = async (change: AdoWorkItemChange, done: string): Promise<boolean> => {
    if (busy || !detail) return false;
    busy = true;
    document.querySelector(".issue-body .ado-hero")?.classList.add("busy");
    try {
      await desktop!.adoWorkItemUpdate(item.id, { ...change, rev: detail.rev });
      toast(done, { tone: "success" });
      // 改了標題：重新開啟，分頁名稱也跟著換。
      if (change.title) showWorkItem({ ...item, title: change.title });
      else await app.issueView.refresh();
      forgetListCopies("wi-");
      void workItemsPanel?.refresh();
      return true;
    } catch (e) {
      app.reportError(e);
      return false;
    } finally {
      busy = false;
      document.querySelector(".issue-body .ado-hero")?.classList.remove("busy");
    }
  };
  /** 改或刪除一則留言（`html` 為 null 時刪除）；成功後重新讀取內容。 */
  const editComment = async (commentId: number, html: string | null, done: string): Promise<boolean> => {
    if (busy || !detail) return false;
    busy = true;
    try {
      if (html === null) await desktop!.adoCommentDelete(item.project, item.id, commentId);
      else await desktop!.adoCommentUpdate(item.project, item.id, commentId, html);
      toast(done, { tone: "success" });
      await app.issueView.refresh();
      return true;
    } catch (e) {
      app.reportError(e);
      return false;
    } finally {
      busy = false;
    }
  };
  return {
    update(d) {
      detail = d;
    },
    enhance(body) {
      enhanceWorkItem(
        body,
        {
          detail: () => detail,
          apply,
          editComment,
          states: () => states.load(),
          iterations: () => iterations.load(),
          me: () => app.ado?.account?.name ?? "",
          id: item.id,
          kind: item.kind,
        },
        { states, iterations },
      );
    },
  };
}

/** 依 `key` 分組（組的順序依第一次出現；組裡維持原本的順序）。 */
export function groupItems<T>(items: T[], key: (item: T) => string): { title: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  return [...groups].map(([title, list]) => ({ title, items: list }));
}

/** 工作項目內容裡收起來的段落（記住，開別的項目也一樣）。 */
function foldedSections(): Set<SectionKind> {
  try {
    const v = JSON.parse(storage.load("workitem-folded") ?? "[]") as unknown;
    return new Set(Array.isArray(v) ? v.filter((k): k is SectionKind => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

/** 在主要區域開啟工作項目；內容裡的相關工作項目點一下在這裡切換。 */
/** 狀態列上的摘要：狀態、留言、附件、相關項目的數目，最後更新時間。 */
function workItemFacts(d: AdoWorkItemDetail): IssueFact[] {
  const facts: IssueFact[] = [{ text: d.state, title: t("狀態"), dot: stateTone(d.state) }];
  const count = (n: number, text: string) => {
    if (n) facts.push({ text });
  };
  count(d.comments.length, t("留言 {n}", { n: d.comments.length }));
  count(d.attachments?.length ?? 0, t("附件 {n}", { n: d.attachments?.length ?? 0 }));
  count(d.relations.length, t("相關 {n}", { n: d.relations.length }));
  const changed = d.changed ? Date.parse(d.changed) : NaN;
  if (Number.isFinite(changed)) {
    facts.push({ text: t("更新於 {ago}", { ago: timeAgo(changed) }), title: new Date(changed).toLocaleString() });
  }
  return facts;
}

export function showWorkItem(item: AdoWorkItem): void {
  let related = new Map<number, AdoWorkItem>();
  /** 讀到的內容（狀態列上的摘要用）。 */
  let detail: AdoWorkItemDetail | null = null;
  // 開啟之前記下「上次看過」的時間（開啟後會更新），之後的留言標「新」。
  const seenAt = workItemSeen?.[item.id] ?? null;
  offlineRefs.set(`ado:${item.id}`, { type: "ado", item });
  const editing = workItemEditing(item);
  void app.showIssue({
    key: `ado:${item.id}`,
    origin: { kind: "ado", icon: "square-kanban", text: t("Azure DevOps 工作項目") },
    label: `${item.kind} ${item.id}`,
    title: item.title,
    webUrl: item.webUrl,
    fileName: issueFileName(`${item.kind} ${item.id}`, item.title),
    load: async () => {
      const d = await desktop!.adoWorkItem(item.id);
      workItemLoaded(d);
      related = new Map(d.relations.map((r) => [r.id, r]));
      detail = d;
      editing.update(d);
      return workItemMarkdown(d);
    },
    facts: () => (detail ? workItemFacts(detail) : []),
    decorate: (body) => {
      // 標籤與檔案方塊先做：附件段落還是原本的連結清單，找得到同名附件。
      decorateMarks(body);
      decorateAttachments(body, {
        open: (href) => void openAttachment(href),
        save: (href) => saveAttachment(href),
        thumb: (href) => desktop!.adoImage(href),
      });
      decorateWorkItem(body, {
        seenAt,
        folded: foldedSections(),
        onFold: (kind, folded) => {
          const set = foldedSections();
          if (folded) set.add(kind);
          else set.delete(kind);
          storage.save("workitem-folded", JSON.stringify([...set]));
        },
        newestFirst: storage.load("workitem-comment-order") !== "oldest",
        onOrder: (newest) => storage.save("workitem-comment-order", newest ? "newest" : "oldest"),
        // 沒有內容也要有的段落：可以新增說明、驗收條件或重現步驟；留言框在留言段落裡。
        ensureSections: [
          ...longFields(item.kind, { desc: false, details: false }).always.map((f) => ({
            kind: f.section,
            title: f.section === "desc" ? t("工作項目說明") : f.field === "reproSteps" ? t("重現步驟") : t("驗收條件"),
          })),
          { kind: "comments" as const, title: t("留言（{n}）", { n: 0 }) },
        ],
      });
      editing.enhance(body);
    },
    insertLink: () => insertIssueLink(item),
    shortcut: {
      has: () => barShortcuts.some((s) => isWorkItemShortcut(s) && s.workItem === item.id),
      toggle: () => toggleWorkItemShortcut(item),
    },
    link: (href) => {
      // 附件：文字檔、圖片在 oMarker 裡看，其他用預設的程式開啟。
      if (openAttachment(href)) return true;
      const id = workItemIdOf(href);
      const target = id === null ? undefined : related.get(id);
      if (!target) return false;
      showWorkItem(target);
      return true;
    },
  });
}
