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
import { type SeenMap, trimSeen, remember, markSeen, markOf, markAllSeen } from "../workitem-seen.ts";
import { workItemFilterKey } from "../work-item-filter.ts";
import { openGitHistory, historyView } from "./git-history.ts";
import { createWorkItemDialog } from "./new-work-item.ts";
import { forgetListCopies, refreshKeptPages, withOfflineCopy } from "./offline-copies.ts";
import { workItemsPanel, wikiPanel, issuesPanel, renderUnseenLine } from "./work-items-panel.ts";
import { app } from "./context.ts";
import { setWikiRight, wikiRightWanted } from "./workspace-ui.ts";
import { initOfflineBanner } from "./offline-banner.ts";


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
  // 指派給你的項目一定留著（不然會被搜尋結果擠掉，又變成「新的」）。
  workItemSeen = trimSeen(next, undefined, new Set(app.pollItems.map((w) => w.id)));
  storage.save("workitem-seen", JSON.stringify(workItemSeen));
}

/** 記下讀到的工作項目；`mine` 是指派給你、還沒結束的清單。 */
export function noteWorkItems(items: AdoWorkItem[], mine: boolean): void {
  for (const w of items) setBounded(knownWorkItems, w.id, w, app.CACHE_MAX);
  // 先換成新的清單：存檔時要留住指派給你的項目。
  if (mine) app.pollItems = items;
  const { seen, changed } = remember(workItemSeen, items, mine);
  if (changed) saveSeen(seen);
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

/**
 * 開著的工作項目讀到內容（開啟、重新整理、自己改過之後）：用伺服器上最新的更新時間記成看過，
 * 自己在 oMarker 裡改狀態、留言，不會又被標成「有更新」。
 */
export function workItemLoaded(item: AdoWorkItem): void {
  setBounded(knownWorkItems, item.id, item, app.CACHE_MAX);
  const { seen, changed } = markSeen(workItemSeen, item);
  if (changed) saveSeen(seen);
  // 圖示上的數字用的清單也換成最新的更新時間。
  app.pollItems = app.pollItems.map((w) => (w.id === item.id ? { ...w, changed: item.changed } : w));
  if (!changed) return;
  workItemsPanel?.refreshMarks();
  renderAdoBadge();
}

/** 指派給你的工作項目全部標示為看過（圖示上的數字歸零）。 */
export function markAllWorkItemsSeen(): void {
  saveSeen(markAllSeen(workItemSeen, app.pollItems));
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
  // 數字算的是哪些：只有指派給你、還沒結束的（看別人的、已結束的不算），滑鼠移上去就看得到。
  badge.title = t("指派給你、還沒結束的工作項目裡，有 {n} 個是新的或看過之後有更新（別人的、已結束的不算）", { n });
  renderUnseenLine();
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
    // 和「指派給你」的清單同一份副本。剛啟動時先用副本（圖示上的數字馬上出來），背景讀完再檢查一次。
    const key = `wi-list::${workItemFilterKey(app.DEFAULT_WORK_ITEM_FILTER)}`;
    const fetch = () => desktop!.adoWorkItems("", app.DEFAULT_WORK_ITEM_FILTER);
    const first = !app.pollItems.length;
    noteWorkItems(await withOfflineCopy(key, fetch, first ? () => window.setTimeout(() => void pollWorkItems(), 0) : undefined, true), true);
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

/** 把目前開啟的本機資料夾上傳到 Azure DevOps，成功後更新原始碼控制面板。 */
export async function publishToAdo(): Promise<void> {
  const root = app.workspaceRoot;
  if (!app.ado || !root) return;
  if (await app.ado.publish(root.name)) await gitPanel?.refresh();
}

export function initWorkItemUpdates(): void {
  initOfflineBanner();
  app.commands.register({
    id: "workitems-mark-all-seen",
    title: t("工作項目：全部標示為看過"),
    group: "Azure DevOps",
    icon: "check",
    when: () => app.pollItems.some((w) => markOf(workItemSeen, w)),
    run: () => markAllWorkItemsSeen(),
  });
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
  // 按「重新整理」一定向伺服器讀（不用剛讀到的結果）。
  app.$("#workitems-refresh").addEventListener("click", () => {
    forgetListCopies("wi-");
    void workItemsPanel?.refresh();
  });
  app.$("#wiki-refresh").addEventListener("click", () => {
    forgetListCopies("wiki");
    void wikiPanel?.refresh();
  });
  app.$("#wiki-dock").addEventListener("click", () => setWikiRight(!wikiRightWanted));
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
    if (problem === "ado" && app.ado) return { label: t("開啟連線設定"), primary: true, run: () => app.settingsDialog.open("Azure DevOps") };
    return undefined;
  });
  gitPanel = desktop && app.fileTree && app.github
      ? new GitPanel(app.$("#git-host"), app.$("#git-head"), desktop, app.settings, app.fileTree, app.github, {
          root: () => app.workspaceRoot?.path ?? null,
          open: (path) => void app.openPath(path).catch(app.reportError),
          resolve: (path, theirs) => void app.resolveMergeConflict(path, theirs).catch(app.reportError),
          switchBranch: () => void app.switchBranch().catch(app.reportError),
          createPr: () => void app.createPullRequest().catch(app.reportError),
          history: () => void openGitHistory().catch(app.reportError),
          openAdo: app.ado ? () => void app.ado!.openRepo() : null,
          publishAdo: app.ado ? () => void publishToAdo() : null,
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
