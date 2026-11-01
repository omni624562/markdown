/**
 * 工作項目：改狀態、指派給我、留言、編輯欄位（在內容上方的操作列）。
 */
import { render as renderMarkdown } from "../../pkg/md_wasm.js";
import { type AdoWorkItem, type AdoWorkItemChange, type AdoWorkItemDetail, desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { timeAgo } from "../history-label.ts";
import { issueFileName, stateTone, workItemMarkdown, workItemIdOf } from "../issue-doc.ts";
import type { IssueFact } from "../ui/issue-view.ts";
import { icon } from "../ui/icons.ts";
import { toast } from "../ui/toast.ts";
import { decorateAttachments } from "../ui/work-item-attachments.ts";
import { decorateWorkItem, type SectionKind } from "../ui/work-item-look.ts";
import { decorateMarks } from "../ui/work-item-marks.ts";
import * as storage from "../storage.ts";
import { isWorkItemShortcut } from "../wiki-shortcuts.ts";
import { type Iteration, iterationGroups, parseTags, sameTags } from "../work-item-fields.ts";
import { openAttachment, saveAttachment } from "./ado-files.ts";
import { insertIssueLink } from "./ado-links.ts";
import { offlineRefs } from "./offline-copies.ts";
import { workItemSeen } from "./work-item-updates.ts";
import { workItemsPanel, barShortcuts, toggleWorkItemShortcut } from "./work-items-panel.ts";
import { app } from "./context.ts";


/** 每種工作項目可以設定的狀態（同一個專案、類型只讀一次）。 */
const workItemStates = new Map<string, Promise<string[]>>();
/** 每個專案的 Sprint（只讀一次）。 */
const projectIterations = new Map<string, Promise<Iteration[]>>();

/** 標題最多幾個字（Azure DevOps 的限制）。 */
const MAX_TITLE = 255;

/** 編輯欄位表單的一個欄位：名稱在上、輸入在下。 */
function editField(label: string, input: HTMLElement, className = ""): HTMLLabelElement {
  const el = document.createElement("label");
  el.className = `issue-edit-field ${className}`.trim();
  const name = document.createElement("span");
  name.textContent = label;
  el.append(name, input);
  return el;
}

/** Sprint 選單的選項：分成進行中與之後、沒有日期、已結束；目前的 Sprint 標「（目前）」。 */
function fillIterations(select: HTMLSelectElement, list: Iteration[], value: string): void {
  const groups = iterationGroups(list, Date.now());
  const option = (o: { path: string; label: string; current: boolean }) =>
    new Option(
      o.label ? (o.current ? t("{name}（目前）", { name: o.label }) : o.label) : t("（不放在任何 Sprint）"),
      o.path,
      false,
      o.path === value,
    );
  const titles = { upcoming: t("目前與之後的 Sprint"), undated: t("沒有日期"), past: t("過去的 Sprint") };
  const nodes: HTMLElement[] =
    groups.length > 1
      ? groups.map((g) => {
          const og = document.createElement("optgroup");
          og.label = titles[g.kind];
          og.append(...g.items.map(option));
          return og;
        })
      : groups.flatMap((g) => g.items.map(option));
  select.replaceChildren(...nodes);
  // 伺服器上找不到目前的 Sprint（例如已刪除）：留著原本的值，不要默默換掉。
  if (value && !list.some((it) => it.path === value)) select.prepend(new Option(value, value, false, true));
  select.value = value;
}

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
  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "btn btn-small";
  editBtn.append(icon("pencil"), t("編輯欄位"));
  editBtn.title = t("改標題、優先順序、Sprint、標籤");
  editBtn.setAttribute("aria-expanded", "false");
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

  // 編輯欄位：標題、優先順序、Sprint、標籤，一次存回。
  const editForm = document.createElement("div");
  editForm.className = "issue-comment-form issue-edit-form";
  editForm.hidden = true;
  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.required = true;
  titleInput.maxLength = MAX_TITLE;
  const priority = document.createElement("select");
  priority.className = "issue-toolbar-select";
  priority.append(...[1, 2, 3, 4].map((n) => new Option(String(n), String(n))));
  const sprint = document.createElement("select");
  sprint.className = "issue-toolbar-select issue-edit-sprint";
  const tagsInput = document.createElement("input");
  tagsInput.type = "text";
  tagsInput.placeholder = t("用逗號隔開，例如 UAT, 前端");
  const priorityField = editField(t("優先順序"), priority);
  const editRow = document.createElement("div");
  editRow.className = "issue-edit-row";
  editRow.append(priorityField, editField("Sprint", sprint), editField(t("標籤"), tagsInput, "issue-edit-tags"));
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn btn-small btn-primary";
  save.textContent = t("儲存");
  const editCancel = document.createElement("button");
  editCancel.type = "button";
  editCancel.className = "btn btn-small";
  editCancel.textContent = t("取消");
  const editActions = document.createElement("div");
  editActions.className = "issue-comment-actions";
  editActions.append(save, editCancel);
  editForm.append(editField(t("標題（必填）"), titleInput, "issue-edit-title"), editRow, editActions);
  bar.append(stateLabel, assign, commentBtn, editBtn, form, editForm);

  const me = () => app.ado?.account?.name ?? "";
  const render = () => {
    const current = detail?.state ?? item.state;
    if (![...state.options].some((o) => o.value === current)) state.append(new Option(current, current));
    state.value = current;
    const mine = (detail?.assignedTo ?? item.assignedTo) === me();
    assign.hidden = mine;
    // 讀到內容（目前的欄位與修訂版本）之後才能編輯。
    editBtn.disabled = !detail;
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
  const apply = async (change: AdoWorkItemChange, done: string) => {
    const controls = [state, assign, commentBtn, send, editBtn, save];
    for (const el of controls) el.disabled = true;
    try {
      await desktop!.adoWorkItemUpdate(item.id, { ...change, rev: detail?.rev });
      toast(done, { tone: "success" });
      // 改了標題：重新開啟，分頁名稱也跟著換。
      if (change.title) showWorkItem({ ...item, title: change.title });
      else await app.issueView.refresh();
      void workItemsPanel?.refresh();
      return true;
    } catch (e) {
      app.reportError(e);
      return false;
    } finally {
      for (const el of controls) el.disabled = false;
      render();
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
    if (!form.hidden) {
      closeEdit();
      textarea.focus();
    }
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

  /** 打開編輯表單：填入目前的值；Sprint 清單第一次打開時才讀。 */
  const openEdit = () => {
    if (!detail) return;
    form.hidden = true;
    titleInput.value = detail.title;
    priorityField.hidden = detail.priority === null;
    if (detail.priority !== null) priority.value = String(detail.priority);
    const current = detail.iteration ?? "";
    sprint.replaceChildren(new Option(current || t("（不放在任何 Sprint）"), current, true, true));
    sprint.disabled = true;
    tagsInput.value = detail.tags.join(", ");
    editForm.hidden = false;
    editBtn.setAttribute("aria-expanded", "true");
    titleInput.focus();
    let p = projectIterations.get(item.project);
    if (!p) {
      p = desktop!.adoIterations(item.project);
      projectIterations.set(item.project, p);
      p.catch(() => projectIterations.delete(item.project));
    }
    void p
      .then((list) => {
        if (!editForm.hidden) fillIterations(sprint, list, sprint.value);
      })
      .catch(app.reportError)
      .finally(() => (sprint.disabled = false));
  };
  const closeEdit = () => {
    editForm.hidden = true;
    editBtn.setAttribute("aria-expanded", "false");
  };
  editBtn.addEventListener("click", () => (editForm.hidden ? openEdit() : closeEdit()));
  editCancel.addEventListener("click", closeEdit);
  /** 只送出有改的欄位；都沒改就直接收起來。 */
  const saveEdit = async () => {
    if (!detail) return;
    const title = titleInput.value.trim();
    if (!title) {
      titleInput.value = "";
      titleInput.reportValidity();
      return;
    }
    const change: AdoWorkItemChange = {};
    if (title !== detail.title) change.title = title;
    if (!priorityField.hidden && Number(priority.value) !== detail.priority) change.priority = Number(priority.value);
    if (sprint.value && sprint.value !== (detail.iteration ?? "")) change.iteration = sprint.value;
    const tags = parseTags(tagsInput.value);
    if (!sameTags(tags, detail.tags)) change.tags = tags;
    if (!Object.keys(change).length) return closeEdit();
    if (await apply(change, t("已更新工作項目"))) closeEdit();
  };
  save.addEventListener("click", () => void saveEdit());
  editForm.addEventListener("keydown", (e) => {
    // Enter（在輸入框裡）或 Ctrl+Enter 儲存；Esc 只收起表單，不要關掉整個檢視。
    if (e.key === "Enter" && !e.isComposing && (e.ctrlKey || e.metaKey || e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      void saveEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeEdit();
    }
  });
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
      detail = d;
      actions.update(d);
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
      });
    },
    insertLink: () => insertIssueLink(item),
    toolbar: actions.el,
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
