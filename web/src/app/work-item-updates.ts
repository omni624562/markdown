/**
 * 工作項目：標出上次看過之後有更新的，定時在背景檢查（圖示上顯示數量）。
 */
import { authProblem } from "../auth-errors.ts";
import { setBounded } from "../bounded.ts";
import { type AdoWorkItem, desktop } from "../desktop.ts";
import { GitPanel } from "../git-ui.ts";
import { t } from "../i18n.ts";
import * as storage from "../storage.ts";
import { icon } from "../ui/icons.ts";
import { setErrorAction } from "../ui/toast.ts";
import { type SeenMap, trimSeen, remember, markSeen, markOf } from "../workitem-seen.ts";
import { openGitHistory, historyView } from "./git-history.ts";
import { createWorkItemDialog } from "./new-work-item.ts";
import { refreshKeptPages } from "./offline-copies.ts";
import { workItemsPanel, wikiPanel, issuesPanel } from "./work-items-panel.ts";
import { app } from "./context.ts";


export let workItemSeen: SeenMap | null = (() => {
  try {
    const v = JSON.parse(storage.load("workitem-seen") ?? "null") as unknown;
    return v && typeof v === "object" ? (v as SeenMap) : null;
  } catch {
    return null;
  }
})();
/** 讀過的工作項目（開啟時找得到最後更新時間）。 */
const knownWorkItems = new Map<number, AdoWorkItem>();

function saveSeen(next: SeenMap): void {
  workItemSeen = trimSeen(next);
  storage.save("workitem-seen", JSON.stringify(workItemSeen));
}

/** 記下讀到的工作項目；`mine` 是指派給你、還沒結束的清單。 */
export function noteWorkItems(items: AdoWorkItem[], mine: boolean): void {
  for (const w of items) setBounded(knownWorkItems, w.id, w, app.CACHE_MAX);
  const { seen, changed } = remember(workItemSeen, items, mine);
  if (changed) saveSeen(seen);
  if (mine) app.pollItems = items;
  renderAdoBadge();
}

/** 開啟工作項目時記下「看過了」，清掉清單上的小圓點。 */
export function workItemOpened(id: number): void {
  const item = knownWorkItems.get(id);
  if (!item) return;
  const { seen, changed } = markSeen(workItemSeen, item);
  if (!changed) return;
  saveSeen(seen);
  workItemsPanel?.refreshMarks();
  renderAdoBadge();
}

/** 圖示上的數字：指派給你的工作項目裡，新的或有更新的有幾個。 */
export function renderAdoBadge(): void {
  const badge = app.$("#ado-badge");
  const n = app.pollItems.filter((w) => markOf(workItemSeen, w)).length;
  badge.hidden = !n;
  badge.textContent = n > 99 ? "99+" : String(n);
  const tab = app.$("#side-tab-workitems");
  const label = t("工作項目（Azure DevOps）");
  tab.setAttribute("aria-label", n ? t("{label}：{n} 個工作項目有更新", { label, n }) : label);
}

let polling = false;
/** 在背景檢查指派給你的工作項目（視窗沒在看時略過）。 */
export async function pollWorkItems(): Promise<void> {
  // 縮小或在背景時，開了通知才檢查（要跳出通知）。
  if (polling || !desktop || !app.ado?.account || (document.hidden && !app.settings.value.adoNotify)) return;
  polling = true;
  try {
    const signature = () => app.pollItems.map((w) => `${w.id}@${w.changed}`).join();
    const before = signature();
    noteWorkItems(await desktop.adoWorkItems("", app.DEFAULT_WORK_ITEM_FILTER), true);
    notifyNewWorkItems();
    // 面板上是同一份清單時，有新的或更新的項目就一起更新清單。
    if (before && signature() !== before && app.isDefaultFilter() && workItemsPanel?.showingList) void workItemsPanel.refresh();
    else workItemsPanel?.refreshMarks();
  } catch {
    // 網路斷了就等下次再檢查。
  } finally {
    polling = false;
  }
}
/** 通知過的工作項目（同一個只通知一次）。 */
const notifiedWorkItems = new Set<number>(
  (() => {
    try {
      const v = JSON.parse(storage.load("wi-notified") ?? "[]") as unknown;
      return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
    } catch {
      return [];
    }
  })(),
);

/** 新指派給你、還沒看過也還沒通知過的工作項目：oMarker 在背景時跳出系統通知。 */
function notifyNewWorkItems(): void {
  if (!desktop || !app.settings.value.adoNotify) return;
  const fresh = app.pollItems.filter((w) => markOf(workItemSeen, w) === "new" && !notifiedWorkItems.has(w.id));
  if (!fresh.length) return;
  for (const w of fresh) notifiedWorkItems.add(w.id);
  storage.save("wi-notified", JSON.stringify([...notifiedWorkItems].slice(-300)));
  // 正在用 oMarker 時，側邊欄圖示上的數字就夠了。
  if (!document.hidden && document.hasFocus()) return;
  void desktop.notifyWorkItems(fresh.map((w) => ({ id: w.id, title: w.title, kind: w.kind }))).catch(() => {});
}

/** 打開「工作項目」或「Wiki」面板。 */
export function showAdo(panel: "workitems" | "wiki"): void {
  app.showPanel(panel);
}
// 工作項目清單上方的「建立工作項目」。
const adoNew = document.createElement("button");

/**
 * 網路恢復或切回視窗時，重新讀取上次失敗的工作項目、Wiki、Issues 與開著的內容
 * （面板沒開著的，下次打開時本來就會重讀）。
 */
let lastAutoRetry = 0;
function retryRemoteLoads(force = false): void {
  const now = Date.now();
  if (!force && now - lastAutoRetry < 10_000) return;
  lastAutoRetry = now;
  if (app.sidePanel === "workitems") workItemsPanel?.retryFailed();
  if (app.sidePanel === "wiki") wikiPanel?.retryFailed();
  if (app.sidePanel === "issues") issuesPanel?.retryFailed();
  app.issueView.retryFailed();
}

export // 在 init 時建立。
let gitPanel: GitPanel | null;

export function initWorkItemUpdates(): void {
  if (desktop) {
    void desktop.onNotificationOpen((id) => {
      if (id) void app.openWorkItemById(id);
      else showAdo("workitems");
    });
  }
  window.setInterval(() => void pollWorkItems(), 5 * 60_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void pollWorkItems();
  });
  app.$("#workitems-refresh").addEventListener("click", () => void workItemsPanel?.refresh());
  app.$("#wiki-refresh").addEventListener("click", () => void wikiPanel?.refresh());
  adoNew.type = "button";
  adoNew.className = "btn icon-only";
  adoNew.id = "ado-new";
  adoNew.title = t("建立工作項目");
  adoNew.setAttribute("aria-label", t("建立工作項目"));
  adoNew.append(icon("plus"));
  adoNew.addEventListener("click", () => createWorkItemDialog());
  app.$("#workitems-refresh").before(adoNew);
  window.addEventListener("online", () => {
    retryRemoteLoads(true);
    void refreshKeptPages();
  });
  window.setTimeout(() => void refreshKeptPages(), 60_000);
  window.addEventListener("focus", () => retryRemoteLoads());
  // 登入過期、權杖失效的錯誤通知：直接附上重新登入的按鈕。
  setErrorAction((message) => {
    const problem = authProblem(message);
    const github = app.github;
    if (problem === "github" && github) return { label: t("重新登入 GitHub"), primary: true, run: () => void github.login() };
    if (problem === "ado" && app.ado) return { label: t("開啟連線設定"), primary: true, run: () => app.settingsDialog.open(t("Azure DevOps／TFS")) };
    return undefined;
  });
  gitPanel = desktop && app.fileTree && app.github
      ? new GitPanel(app.$("#git-host"), desktop, app.settings, app.fileTree, app.github, {
          root: () => app.workspaceRoot?.path ?? null,
          open: (path) => void app.openPath(path).catch(app.reportError),
          resolve: (path, theirs) => void app.resolveMergeConflict(path, theirs).catch(app.reportError),
          switchBranch: () => void app.switchBranch().catch(app.reportError),
          createPr: () => void app.createPullRequest().catch(app.reportError),
          history: () => void openGitHistory().catch(app.reportError),
          openAdo: app.ado ? () => void app.ado!.openRepo() : null,
          changed: (status) => {
            // 提交、切換分支、拉取之後，開著的 Git 歷史跟著更新。
            const b = status?.branch;
            const key = status?.repo ? `${b?.name}|${b?.ahead}|${b?.behind}|${status.changes.length}|${status.merging}` : "";
            if (key !== app.gitHistoryKey) {
              app.gitHistoryKey = key;
              historyView?.refresh();
            }
            app.refreshActivityCommands();
            app.renderFolderBranch(status);
            // Git 內建在程式裡：圖示一直顯示，還沒同步的資料夾點進去會引導上傳到 GitHub。
            const tab = app.$("#side-tab-git");
            tab.hidden = false;
            app.panelAvailable("git");
            const count = status?.repo ? status.changes.length : 0;
            const badge = app.$("#git-badge");
            badge.hidden = !count;
            badge.textContent = count > 99 ? "99+" : String(count);
            tab.setAttribute("aria-label", count ? t("原始碼控制（Git），{n} 個變更", { n: count }) : t("原始碼控制（Git）"));
            const label = tab.getAttribute("aria-label")!;
            tab.title = tab.dataset.keys ? t("{label}（{keys}）", { label, keys: tab.dataset.keys }) : label;
          },
        })
      : null;
}
