/**
 * 版本資訊：回報問題時附上，比較容易找到原因。「回報問題或建議」（關於頁與「☰」→「說明」）
 * 開 GitHub 的新問題時先放進內文。
 * 只有版本、更新管道、建置、作業系統與顯示核心，不含檔案、帳號或公司的資料。
 */
import { desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { versionTooltip } from "../updater.ts";
import { engineName, reportIssueUrl, systemName, versionInfoText } from "../version-text.ts";
import { openUrl } from "./activity-bar.ts";
import { reportError } from "./git-actions.ts";
import { app } from "./context.ts";

type ClientHints = { getHighEntropyValues(hints: string[]): Promise<{ platformVersion?: string }> };

async function platformVersion(): Promise<string | undefined> {
  const hints = (navigator as Navigator & { userAgentData?: ClientHints }).userAgentData;
  try {
    return (await hints?.getHighEntropyValues(["platformVersion"]))?.platformVersion;
  } catch {
    return undefined;
  }
}

/** 這台電腦上的 oMarker 版本資訊（見 `versionInfoText`）。 */
export async function versionInfo(): Promise<string> {
  const ua = navigator.userAgent;
  const v = app.updater ? await app.updater.version().catch(() => null) : null;
  const channel = !desktop ? t("網頁版") : !v?.build ? null : app.settings.value.updateChannel === "early" ? t("搶先版") : t("穩定版");
  return versionInfoText({
    version: v?.version ?? __APP_VERSION__,
    channel,
    build: v ? versionTooltip(v) : null,
    system: systemName(ua, await platformVersion()),
    engine: engineName(ua, !!desktop),
  });
}

/** 開 GitHub 的新問題，內文帶著版本資訊。 */
export function reportIssue(): void {
  void versionInfo()
    .then((info) => openUrl(reportIssueUrl(info)))
    .catch(reportError);
}
