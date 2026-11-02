/**
 * 錯誤看得到：沒有被接住的錯誤（含沒有等結果的非同步動作）記進錯誤紀錄並提示一次；
 * 「說明：複製錯誤紀錄」把最近的錯誤整理好放到剪貼簿，方便回報問題。
 */
import { OfflineError } from "../ado-online.ts";
import { errorEntries, errorLogText, isNoise, logError } from "../error-log.ts";
import { t } from "../i18n.ts";
import { toast } from "../ui/toast.ts";
import { app } from "./context.ts";

/** 同一段時間只提示一次（一個錯誤常常連續發生好幾次）。 */
const NOTICE_GAP = 10_000;
let noticeAt = 0;

function unexpected(where: string, e: unknown): void {
  // 離線時的失敗已經有離線提示；瀏覽器的雜訊不用讓使用者知道。
  if (e instanceof OfflineError || isNoise(e)) return;
  const entry = logError(where, e);
  console.error(e);
  if (Date.now() - noticeAt < NOTICE_GAP) return;
  noticeAt = Date.now();
  toast(t("發生錯誤：{error}。可以用「說明：複製錯誤紀錄」把細節貼給開發者。", { error: entry.message }), { tone: "error", duration: 10_000 });
}

async function copyErrorLog(): Promise<void> {
  const list = errorEntries();
  if (!list.length) {
    toast(t("目前沒有錯誤紀錄"));
    return;
  }
  const text = errorLogText([`oMarker ${__APP_VERSION__}`, navigator.userAgent]);
  try {
    await navigator.clipboard.writeText(text);
    toast(t("已複製 {n} 筆錯誤紀錄", { n: list.length }), { tone: "success" });
  } catch (e) {
    toast(t("無法複製到剪貼簿：{error}", { error: e instanceof Error ? e.message : String(e) }), { tone: "error" });
  }
}

// 載入這個模組時就開始接（main.ts 一開始就載入），啟動過程中的錯誤也記得到。
window.addEventListener("error", (e) => unexpected(t("未處理的錯誤"), e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => unexpected(t("未處理的錯誤"), e.reason));

export function initErrorHandling(): void {
  app.commands.register({
    id: "copy-error-log",
    title: t("說明：複製錯誤紀錄"),
    group: t("說明"),
    icon: "bug",
    run: () => void copyErrorLog(),
  });
}
