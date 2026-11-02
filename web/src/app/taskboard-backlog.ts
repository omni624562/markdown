/**
 * Backlog：團隊還沒排進 Sprint 的需求（User Story、PBI、Bug…），依 Backlog 的順序列出；
 * 每一項可以「移到」工作板上選的 Sprint。開在主要區域的分頁裡（和工作板一樣）。
 */
import { type AdoBoardItem, desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { icon } from "../ui/icons.ts";
import type { IssueSource } from "../ui/issue-view.ts";
import { toast } from "../ui/toast.ts";
import { kindKey } from "../work-item-colors.ts";
import { showIssue } from "./ado-files.ts";
import { app } from "./context.ts";
import { reportError } from "./git-actions.ts";
import { type Freshness, forgetListCopies, freshnessOf, withOfflineCopy } from "./offline-copies.ts";
import { type Selection, avatar, stateDot } from "./taskboard.ts";
import { copyTime } from "../ui/issues-panel.ts";
import { insertAtCursor } from "./image-paste.ts";
import { showWorkItem } from "./work-item-actions.ts";
import { workItemLoaded } from "./work-item-updates.ts";

export function openBacklog(s: Selection): void {
  void showIssue(backlogSource(s)).catch(reportError);
}

function backlogSource(s: Selection): IssueSource {
  let items: AdoBoardItem[] = [];
  let fresh: Freshness | null = null;
  const key = `backlog:${s.project}/${s.team.id}`;
  const title = t("Backlog（{team}）", { team: s.team.name });
  const base = app.ado?.account?.url ?? "";
  const url = `${base}/${encodeURIComponent(s.project)}/_backlogs/backlog/${encodeURIComponent(s.team.name)}`;
  return {
    key,
    copyFirst: false,
    origin: { kind: "ado", icon: "list-ordered", text: t("Azure DevOps Backlog") },
    label: t("Backlog"),
    title,
    webUrl: url,
    fileName: t("Backlog {team}.md", { team: s.team.name }),
    async load() {
      const update = () => {
        if (app.issueView.shownKey === key) void app.issueView.refresh(true);
      };
      items = await withOfflineCopy(`backlog:${key}`, () => desktop!.adoBacklog(s.project, s.team.name), update);
      fresh = freshnessOf(items);
      const lines = items.map((w, i) => t("{n}. #{id} {title}（{kind}・{state}）", { n: i + 1, id: w.id, title: w.title, kind: w.kind, state: w.state }));
      const empty = t("Backlog 是空的。");
      return ["# " + title, "", lines.join("\n") || empty, ""].join("\n");
    },
    insertLink: () => insertAtCursor(`[${title}](${url})`),
    decorate(body) {
      body.replaceChildren(renderList(items, s, key));
    },
    facts: () => [
      { text: t("{n} 個項目", { n: items.length }) },
      ...(fresh
        ? [
            {
              text:
                fresh.state === "updating"
                  ? t("{time} 的資料，更新中…", { time: copyTime(fresh.savedAt) })
                  : t("連不上伺服器，顯示 {time} 存下的資料", { time: copyTime(fresh.savedAt) }),
            },
          ]
        : []),
    ],
  };
}

function renderList(items: AdoBoardItem[], s: Selection, key: string): HTMLElement {
  const list = document.createElement("ol");
  list.className = "tb-backlog";
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "tb-empty";
    empty.textContent = t("Backlog 是空的。");
    return empty;
  }
  for (const w of items) {
    const li = document.createElement("li");
    li.className = "tb-backlog-item";
    li.dataset.id = String(w.id);
    li.dataset.wiKind = kindKey(w.kind);
    const main = document.createElement("button");
    main.type = "button";
    main.className = "tb-backlog-main";
    const meta = document.createElement("span");
    meta.className = "workitem-meta";
    const state = document.createElement("span");
    state.className = "workitem-state";
    state.append(stateDot(w.state), w.state);
    meta.append(Object.assign(document.createElement("span"), { className: "workitem-meta-text", textContent: `${w.kind} ${w.id}` }), state);
    const who = document.createElement("span");
    who.className = "tb-who";
    who.append(avatar(w.assignedTo), Object.assign(document.createElement("span"), { textContent: w.assignedTo ?? t("沒有指派") }));
    main.append(meta, Object.assign(document.createElement("span"), { className: "tb-title", textContent: w.title }), who);
    main.addEventListener("click", () => showWorkItem(w));
    const move = document.createElement("button");
    move.type = "button";
    move.className = "btn btn-small tb-move";
    move.append(icon("arrow-right"), t("移到 {sprint}", { sprint: s.iteration.name }));
    move.title = t("把 {id} 排進 {sprint}", { id: w.id, sprint: s.iteration.name });
    move.addEventListener("click", () => {
      move.disabled = true;
      void desktop!
        .adoWorkItemUpdate(w.id, { iteration: s.iteration.path, rev: w.rev ?? null })
        .then(() => {
          toast(t("已把 {id} 排進 {sprint}", { id: w.id, sprint: s.iteration.name }), { tone: "success" });
          // 自己改的不算「有更新」；Backlog 與工作板都重新讀。
          workItemLoaded({ ...w, changed: new Date().toISOString() });
          forgetListCopies("board");
          forgetListCopies(`backlog:${key}`);
          void app.issueView.refresh(true);
        })
        .catch((e) => {
          move.disabled = false;
          reportError(e);
        });
    });
    li.append(main, move);
    list.append(li);
  }
  return list;
}
