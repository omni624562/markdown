/**
 * 背景檢查（桌面版）：照設定的「背景檢查間隔」（最短 10 分鐘）檢查指派給你的工作項目與 oMarker 的新版本，
 * 視窗縮小或藏到系統匣（設定「關閉視窗時縮到系統匣」）時也繼續，有消息就跳出系統通知。
 *
 * - 每台電腦的時間錯開一點（間隔的 ±10%），很多人一起用時不會同一刻一起問伺服器。
 * - 切回視窗時另外馬上檢查工作項目（見 work-item-updates.ts），不必等下一次。
 * - 系統匣選單的「立即檢查」：兩樣都馬上檢查。
 */
import { nextDelay } from "../background-schedule.ts";
import { desktop } from "../desktop.ts";
import { app } from "./context.ts";
import { forgetListCopies } from "./offline-copies.ts";
import { pollWorkItems } from "./work-item-updates.ts";

let timer = 0;

function checkAll(now: boolean): void {
  // 「立即檢查」一定向伺服器讀（不用剛讀到的清單）。
  if (now) forgetListCopies("wi-");
  void pollWorkItems();
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
  app.settings.subscribe((_s, changed) => {
    if (changed.includes("backgroundCheck")) schedule();
  });
  void desktop.onTrayCheck(() => checkAll(true));
  void desktop.onNotificationUpdate(() => app.updater?.fromNotification());
}
