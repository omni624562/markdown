/**
 * Git 歷史（線圖）：在主要區域顯示提交線圖，選一個提交看改了哪些檔案。
 */
import { desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import type { GitHistory } from "../ui/history-view.ts";
import { SearchPanel } from "../ui/search-panel.ts";
import { app } from "./context.ts";


export let historyView: GitHistory | null = null;

/** Git 歷史第一次開啟時才載入。 */
async function gitHistory(): Promise<GitHistory | null> {
  if (!desktop || !app.gitPanel) return null;
  if (historyView) return historyView;
  const { GitHistory } = await import("../ui/history-view.ts");
  const panel = app.gitPanel;
  historyView = new GitHistory(app.$(".workspace"), desktop, {
    status: () => panel.status,
    hasUnsaved: () => app.docs.some((d) => d.dirty),
    async openFile(path) {
      historyView?.close();
      await app.openPath(path);
    },
    async compareWithCurrent(path, c) {
      await app.openPath(path);
      await app.compareWithCommit({ ...c, author: "", time: 0, path });
    },
    openUrl: (url) => void desktop!.openExternal(url).catch(app.reportError),
    resolveConflicts(conflicts) {
      app.showPanel("git");
      panel.resolveConflicts(conflicts);
    },
    async changed() {
      await panel.refresh();
      await app.fileTree?.refresh();
    },
    pull: () => panel.pull(),
    push: () => panel.push(),
    commit() {
      historyView?.close();
      app.showPanel("git");
      panel.focusMessage();
    },
    closed: () => {
      markHistoryButtons();
      app.editor.view.focus();
    },
  });
  return historyView;
}

/** 開啟 Git 歷史的指令：釘在圖示列上時，再按一次就關閉。 */
export const HISTORY_COMMANDS = ["git-history", "git-file-history"];

/** 圖示列上的 Git 歷史按鈕在歷史開著時顯示成按下的樣子。 */
export function markHistoryButtons(): void {
  const open = !!historyView?.isOpen;
  for (const id of HISTORY_COMMANDS) {
    for (const b of document.querySelectorAll<HTMLElement>(`.activity-cmd[data-command="${id}"]`)) {
      b.setAttribute("aria-pressed", String(open));
    }
  }
}

/** 開啟 Git 歷史；`path` 是檔案時只列出改過它的提交。 */
export async function openGitHistory(path: string | null = null): Promise<void> {
  const view = await gitHistory();
  if (!view) return;
  app.issueView.close();
  await view.open({ path });
  markHistoryButtons();
}

export // 在 init 時建立。
let searchPanel: SearchPanel | null;

export function initGitHistory(): void {
  searchPanel = desktop
    ? new SearchPanel(app.$("#search-host"), {
        search: (query, caseSensitive, regex) =>
          app.workspaceRoot
            ? desktop!.search(query, caseSensitive, regex, app.workspaceRoot.path)
            : Promise.reject(new Error(t("還沒有開啟資料夾"))),
        open: (path, line, column) => void app.openPath(path, line, column).catch(app.reportError),
        async replace(query, replacement, caseSensitive, regex) {
          if (!app.workspaceRoot) throw new Error(t("還沒有開啟資料夾"));
          app.stash();
          // 有未存檔變更的分頁不碰，避免蓋掉使用者還沒存的內容。
          const skip = app.docs.filter((d) => (d === app.active ? app.baseline !== app.hash(app.editor.text) : d.dirty)).flatMap((d) => app.docPath(d) ?? []);
          const r = await desktop!.replaceInFolder(query, replacement, caseSensitive, regex, skip, app.workspaceRoot.path);
          app.fileListCache = null;
          app.gitPanel?.refreshSoon(300);
          return r;
        },
      })
    : null;
}
