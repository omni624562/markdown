/**
 * 工作項目：改狀態、指派給我、留言（在內容上方的操作列）。
 */
import { render as renderMarkdown } from "../../pkg/md_wasm.js";
import { type AdoWorkItem, type AdoWorkItemDetail, desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { issueFileName, workItemMarkdown, workItemIdOf } from "../issue-doc.ts";
import { icon } from "../ui/icons.ts";
import { toast } from "../ui/toast.ts";
import { decorateWorkItem, type SectionKind } from "../ui/work-item-look.ts";
import * as storage from "../storage.ts";
import { isWorkItemShortcut } from "../wiki-shortcuts.ts";
import { insertIssueLink } from "./ado-links.ts";
import { offlineRefs } from "./offline-copies.ts";
import { workItemSeen } from "./work-item-updates.ts";
import { workItemsPanel, barShortcuts, toggleWorkItemShortcut } from "./work-items-panel.ts";
import { app } from "./context.ts";


/** 每種工作項目可以設定的狀態（同一個專案、類型只讀一次）。 */
const workItemStates = new Map<string, Promise<string[]>>();

/** 工作項目內容上方的操作列；`update` 在讀到最新內容時呼叫（狀態、指派、修訂版本）。 */
function workItemActions(item: AdoWorkItem): { el: HTMLElement; update(d: AdoWorkItemDetail): void } {
  let detail: AdoWorkItemDetail | null = null;
  const bar = document.createElement("div");
  bar.className = "issue-toolbar";
  const stateLabel = document.createElement("label");
  stateLabel.className = "issue-toolbar-field";
  stateLabel.append(t("狀態"));
  const state = document.createElement("select");
  state.className = "issue-toolbar-select";
  state.append(new Option(item.state, item.state, true, true));
  stateLabel.append(state);
  const assign = document.createElement("button");
  assign.type = "button";
  assign.className = "btn btn-small";
  assign.append(icon("user-check"), t("改成指派給我"));
  const commentBtn = document.createElement("button");
  commentBtn.type = "button";
  commentBtn.className = "btn btn-small";
  commentBtn.append(icon("message-square-plus"), t("新增留言"));
  const form = document.createElement("div");
  form.className = "issue-comment-form";
  form.hidden = true;
  const textarea = document.createElement("textarea");
  textarea.rows = 3;
  textarea.placeholder = t("輸入留言（可以用 Markdown）");
  textarea.setAttribute("aria-label", t("留言"));
  const send = document.createElement("button");
  send.type = "button";
  send.className = "btn btn-small btn-primary";
  send.textContent = t("送出留言");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn-small";
  cancel.textContent = t("取消");
  const formActions = document.createElement("div");
  formActions.className = "issue-comment-actions";
  formActions.append(send, cancel);
  form.append(textarea, formActions);
  bar.append(stateLabel, assign, commentBtn, form);

  const me = () => app.ado?.account?.name ?? "";
  const render = () => {
    const current = detail?.state ?? item.state;
    if (![...state.options].some((o) => o.value === current)) state.append(new Option(current, current));
    state.value = current;
    const mine = (detail?.assignedTo ?? item.assignedTo) === me();
    assign.hidden = mine;
  };
  // 第一次點選狀態時才讀取可以設定的狀態。
  const loadStates = () => {
    const key = `${item.project}|${item.kind}`;
    let p = workItemStates.get(key);
    if (!p) {
      p = desktop!.adoWorkItemStates(item.project, item.kind);
      workItemStates.set(key, p);
      p.catch(() => workItemStates.delete(key));
    }
    void p
      .then((list) => {
        const current = state.value;
        state.replaceChildren(...list.map((s) => new Option(s, s, false, s === current)));
        render();
      })
      .catch(app.reportError);
  };
  state.addEventListener("focus", loadStates, { once: true });
  state.addEventListener("pointerdown", loadStates, { once: true });

  /** 送出變更；成功後重新讀取內容與清單。 */
  const apply = async (change: { state?: string; assignToMe?: boolean; comment?: string }, done: string) => {
    for (const el of [state, assign, commentBtn, send]) el.disabled = true;
    try {
      await desktop!.adoWorkItemUpdate(item.id, { ...change, rev: detail?.rev });
      toast(done, { tone: "success" });
      await app.issueView.refresh();
      void workItemsPanel?.refresh();
      return true;
    } catch (e) {
      app.reportError(e);
      render();
      return false;
    } finally {
      for (const el of [state, assign, commentBtn, send]) el.disabled = false;
    }
  };
  state.addEventListener("change", () => {
    const next = state.value;
    if (next === (detail?.state ?? item.state)) return;
    void apply({ state: next }, t("已把狀態改成「{state}」", { state: next }));
  });
  assign.addEventListener("click", () => void apply({ assignToMe: true }, t("已指派給你")));
  commentBtn.addEventListener("click", () => {
    form.hidden = !form.hidden;
    if (!form.hidden) textarea.focus();
  });
  cancel.addEventListener("click", () => {
    form.hidden = true;
    textarea.value = "";
  });
  const submit = async () => {
    const text = textarea.value.trim();
    if (!text) return textarea.focus();
    const html = renderMarkdown(text, { kind: "markdown" }).html;
    if (await apply({ comment: html }, t("已新增留言"))) {
      textarea.value = "";
      form.hidden = true;
    }
  };
  send.addEventListener("click", () => void submit());
  textarea.addEventListener("keydown", (e) => {
    // Ctrl+Enter 送出；Esc 只收起表單，不要關掉整個檢視。
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel.click();
    }
  });
  render();
  return {
    el: bar,
    update(d) {
      detail = d;
      render();
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
export function showWorkItem(item: AdoWorkItem): void {
  let related = new Map<number, AdoWorkItem>();
  // 開啟之前記下「上次看過」的時間（開啟後會更新），之後的留言標「新」。
  const seenAt = workItemSeen?.[item.id] ?? null;
  offlineRefs.set(`ado:${item.id}`, { type: "ado", item });
  const actions = workItemActions(item);
  void app.showIssue({
    key: `ado:${item.id}`,
    origin: { kind: "ado", icon: "square-kanban", text: t("Azure DevOps 工作項目") },
    label: `${item.kind} ${item.id}`,
    title: item.title,
    webUrl: item.webUrl,
    fileName: issueFileName(`${item.kind} ${item.id}`, item.title),
    load: async () => {
      const d = await desktop!.adoWorkItem(item.id);
      related = new Map(d.relations.map((r) => [r.id, r]));
      actions.update(d);
      return workItemMarkdown(d);
    },
    decorate: (body) =>
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
      }),
    insertLink: () => insertIssueLink(item),
    toolbar: actions.el,
    shortcut: {
      has: () => barShortcuts.some((s) => isWorkItemShortcut(s) && s.workItem === item.id),
      toggle: () => toggleWorkItemShortcut(item),
    },
    link: (href) => {
      const id = workItemIdOf(href);
      const target = id === null ? undefined : related.get(id);
      if (!target) return false;
      showWorkItem(target);
      return true;
    },
  });
}
