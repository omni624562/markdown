/**
 * 這台電腦有沒有 COMET CLI（PATH 裡的 `comet`、`%COMET_HOME%\bin`、`%USERPROFILE%\Comet\bin`，
 * 見 desktop/src/new_project.rs 的 locate_comet）。沒有時新專案對話框不列「COMET 專案」，也沒有右邊的
 * 「② COMET 設定」。已經是 COMET 專案（有 .comet.json）的標籤不受影響。
 *
 * 啟動時查一次；視窗重新拿到焦點時再查（最多 5 秒一次），在 oMarker 開著的時候裝好 COMET，切回來就會出現。
 */
import { desktop } from "../desktop.ts";

let present = false;
let checking: Promise<boolean> = Promise.resolve(false);
let last = 0;

/** 最近一次檢查的結果（還沒查完時是 false）。 */
export function cometPresent(): boolean {
  return present;
}

/** 重新檢查（`force` 以外，5 秒內重複呼叫用上一次的結果）。 */
export function checkComet(force = false): Promise<boolean> {
  if (!desktop) return Promise.resolve(false);
  const now = Date.now();
  if (!force && now - last < 5000) return checking;
  last = now;
  checking = desktop.cometInstalled().then(
    (found) => (present = found === true),
    () => present,
  );
  return checking;
}

if (desktop) {
  void checkComet(true);
  window.addEventListener("focus", () => void checkComet());
}
