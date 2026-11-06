/**
 * 這台電腦有沒有安裝 Codex、Claude 桌面版（Windows 上看系統有沒有登記開啟 `codex://`、`claude://` 網址的程式，
 * 見 desktop/src/ai_apps.rs）。沒有安裝時不顯示「在 Codex 開啟這個專案」「在 Claude Code 開啟這個專案」：
 * 「☰」→「專案」、指令面板、專案切換器。
 *
 * 啟動時查一次；視窗重新拿到焦點時再查（最多 5 秒一次），在 oMarker 開著的時候裝好，切回來就會出現。
 */
import { type AiApp, desktop } from "../desktop.ts";

const NONE: Record<AiApp, boolean> = { codex: false, claude: false };

let present = NONE;
let checking: Promise<Record<AiApp, boolean>> = Promise.resolve(NONE);
let last = 0;

/** 最近一次檢查的結果（還沒查完、查不到時是 false）。 */
export function aiAppPresent(app: AiApp): boolean {
  return present[app];
}

/** 重新檢查（`force` 以外，5 秒內重複呼叫用上一次的結果）。 */
export function checkAiApps(force = false): Promise<Record<AiApp, boolean>> {
  if (!desktop) return Promise.resolve(NONE);
  const now = Date.now();
  if (!force && now - last < 5000) return checking;
  last = now;
  checking = desktop.aiAppsInstalled().then(
    (found) => (present = { codex: found?.codex === true, claude: found?.claude === true }),
    () => present,
  );
  return checking;
}

if (desktop) {
  void checkAiApps(true);
  window.addEventListener("focus", () => void checkAiApps());
}
