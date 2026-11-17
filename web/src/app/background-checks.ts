/**
 * 背景檢查（桌面版）：照設定的「背景檢查間隔」（最短 10 分鐘）檢查指派給你的工作項目與開著的 Wiki 分頁，
 * oMarker 的新版本照另一個設定（預設每天）。視窗縮小或藏到系統匣（設定「關閉視窗時縮到系統匣」）時也繼續，
 * 有消息就跳出系統通知。
 *
 * - 每台電腦的時間錯開一點（間隔的 ±10%），很多人一起用時不會同一刻一起問伺服器。
 * - 切回視窗時另外馬上檢查工作項目（見 work-item-updates.ts），不必等下一次。
 * - Wiki 分頁只問頁面的版本（不讀內容），被別人改了才通知；切到那一頁時才重讀。
 * - 系統匣選單的「立即檢查」：全部馬上檢查。
 */
import { nextDelay } from "../background-schedule.ts";
import { desktop } from "../desktop.ts";
import { app } from "./context.ts";
import { reportError } from "./git-actions.ts";
import { itemTabs, selectItem, shownItem } from "./item-tabs.ts";
import { forgetListCopies } from "./offline-copies.ts";
import { issueView } from "./wiki-edit.ts";
import { pollWorkItems } from "./work-item-updates.ts";

let timer = 0;

/** 通知過的 Wiki 頁面版本（`key@版本`）：同一次修改只通知一次。 */
const notifiedWiki = new Set<string>();
/** 上一次通知的那一頁（點通知時切過去）。 */
let lastWikiTab: string | null = null;

/** 開著的 Wiki 分頁（這次執行裡讀過的）有沒有被別人改了；oMarker 在背景時跳出通知。 */
export async function checkWikiTabs(): Promise<void> {
  if (!desktop || !app.ado?.account) return;
  const changed: { id: string; name: string }[] = [];
  for (const tab of itemTabs.filter((x) => x.origin === "wiki")) {
    const source = tab === shownItem ? issueView.source : tab.state?.source;
    if (!source?.newerVersion) continue;
    const version = await source.newerVersion().catch(() => null);
    if (!version || notifiedWiki.has(`${tab.key}@${version}`)) continue;
    notifiedWiki.add(`${tab.key}@${version}`);
    changed.push({ id: tab.id, name: tab.name });
  }
  if (!changed.length || !app.settings.value.adoNotify) return;
  // 正在用 oMarker 時不跳通知：切到那一頁就會讀到新的內容。
  if (!document.hidden && document.hasFocus()) return;
  lastWikiTab = changed[0].id;
  await desktop.notifyWikiPages(changed.map((c) => c.name)).catch(() => {});
}

function checkAll(now: boolean): void {
  // 「立即檢查」一定向伺服器讀（不用剛讀到的清單）。
  if (now) forgetListCopies("wi-");
  void pollWorkItems();
  void checkWikiTabs();
  void app.updater?.backgroundCheck(now);
}

function schedule(): void {
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    checkAll(false);
    schedule();
  }, nextDelay(Number(app.settings.value.backgroundCheck)));
}

export function initBackgroundChecks(): void {
  if (!desktop) return;
  schedule();
  app.settings.subscribe((s, changed) => {
    if (changed.includes("backgroundCheck")) schedule();
    // 開機時自動啟動：寫進（或拿掉）Windows 的「啟動」清單。
    if (changed.includes("launchAtLogin")) void desktop!.setLaunchAtLogin(s.launchAtLogin).catch(reportError);
  });
  void desktop.onTrayCheck(() => checkAll(true));
  void desktop.onNotificationUpdate(() => app.updater?.fromNotification());
  void desktop.onNotificationWiki(() => {
    if (lastWikiTab && itemTabs.some((x) => x.id === lastWikiTab)) selectItem(lastWikiTab);
  });
}
