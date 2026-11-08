/**
 * 狀態列：開著 Wiki、工作項目、Git 歷史時，顯示正在看什麼（唯讀、回到文件、狀態與留言數等摘要），
 * 藏起只跟本機文件有關的項目。從 main.ts 拆出來，透過 `app` 取用版面與編輯器。
 */
import { t } from "../i18n.ts";
import { icon } from "../ui/icons.ts";
import type { IssueFact } from "../ui/issue-view.ts";
import { app } from "./context.ts";
import { historyView } from "./git-history.ts";
import { hideItem } from "./item-tabs.ts";

/** 正在看的工作項目等內容的摘要（狀態、留言數…），顯示在狀態列右邊。 */
let issueFacts: IssueFact[] = [];

export function setIssueFacts(list: IssueFact[]): void {
  issueFacts = list;
  renderStatusView();
}

function renderStatusView(): void {
  const statusView = app.$("#status-view");
  const issuePane = app.$(".issue-pane:not(.history-pane)");
  // 並排顯示時編輯區還在，狀態列照常顯示文件的資訊。
  const issueOpen = app.workspace.classList.contains("issue-open") && !app.workspace.classList.contains("issue-side");
  const historyOpen = app.workspace.classList.contains("history-open");
  const viewing = issueOpen || historyOpen;
  app.$(".statusbar").classList.toggle("viewing", viewing);
  statusView.hidden = !viewing;
  if (!viewing) return;
  const source = historyOpen ? "git" : (issuePane.dataset.source ?? "");
  const names: Record<string, string> = {
    wiki: "Azure DevOps Wiki",
    ado: t("Azure DevOps 工作項目"),
    github: "GitHub Issue",
    git: t("Git 歷史"),
  };
  const label = document.createElement("span");
  label.className = "status-view-label";
  label.append(
    icon(source === "git" ? "git-branch" : "lock"),
    source === "git" ? names.git : t("{name}・唯讀", { name: names[source] ?? issuePane.dataset.sourceName ?? "" }),
  );
  const back = document.createElement("button");
  back.type = "button";
  back.className = "status-btn";
  back.append(icon("arrow-left"), t("回到文件"));
  back.title = t("回到編輯中的文件（Esc）；工作項目等的分頁留著，點分頁就切換回來");
  back.addEventListener("click", () => {
    hideItem();
    historyView?.close();
    app.editor.view.focus();
  });
  const facts = document.createElement("span");
  facts.className = "status-facts";
  if (issueOpen && !historyOpen) {
    for (const f of issueFacts) {
      const item = document.createElement("span");
      if (f.dot) {
        const dot = document.createElement("span");
        dot.className = `ado-state-dot ${f.dot}`;
        dot.setAttribute("aria-hidden", "true");
        item.append(dot);
      }
      item.append(f.text);
      if (f.title) item.title = f.title;
      facts.append(item);
    }
  }
  statusView.replaceChildren(label, back, facts);
}

/** 開始跟著版面（打開或關上工作項目、Git 歷史）與正在看的內容更新狀態列。 */
export function initStatusView(): void {
  new MutationObserver(renderStatusView).observe(app.workspace, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(renderStatusView).observe(app.$(".issue-pane:not(.history-pane)"), { attributes: true, attributeFilter: ["data-source", "data-source-name"] });
}
