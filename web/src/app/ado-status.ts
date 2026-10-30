/**
 * 狀態列：Azure DevOps 的連線狀態（連得到、連不到、權杖過期），定時檢查。
 */
import { desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { app } from "./context.ts";


// 在 init 時建立。
let adoStatus: HTMLElement;
let adoPing: { status: string; name: string | null; message: string; at: number } | null = null;
let pinging = false;
let lastPing = 0;

export async function pingAdo(): Promise<void> {
  if (!desktop || !app.ado?.account) {
    adoPing = null;
    renderAdoStatus();
    return;
  }
  if (pinging) return;
  pinging = true;
  lastPing = Date.now();
  adoStatus.classList.add("checking");
  try {
    adoPing = { ...(await desktop.adoPing()), at: Date.now() };
  } catch (e) {
    adoPing = { status: "error", name: null, message: e instanceof Error ? e.message : String(e), at: Date.now() };
  } finally {
    pinging = false;
    adoStatus.classList.remove("checking");
    renderAdoStatus();
  }
}

function renderAdoStatus(): void {
  adoStatus.hidden = !app.ado?.account;
  if (adoStatus.hidden) return;
  const state = adoPing?.status ?? "unknown";
  adoStatus.dataset.state = state;
  const summary: Record<string, string> = {
    ok: adoPing?.name ? t("已連線（{name}）", { name: adoPing.name }) : t("已連線"),
    offline: t("連不到伺服器"),
    auth: t("權杖無效或已過期"),
    error: t("連線有問題"),
    unknown: t("檢查中…"),
  };
  // 連線正常時只顯示圖示和綠點；有問題時加上文字，比較容易注意到。
  adoStatus.querySelector<HTMLElement>(".ado-state-label")!.textContent = state === "ok" || state === "unknown" ? "" : summary[state];
  const time = adoPing ? new Date(adoPing.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
  adoStatus.title = [
    t("Azure DevOps：{state}", { state: summary[state] ?? "" }) + (time ? t("（最後檢查 {time}）", { time }) : ""),
    adoPing?.message ?? "",
    state === "auth" ? t("按一下開啟設定，更新權杖") : t("按一下重新檢查"),
  ]
    .filter(Boolean)
    .join("\n");
  adoStatus.setAttribute("aria-label", adoStatus.title);
}

export function initAdoStatus(): void {
  adoStatus = app.$("#status-ado");
  adoStatus.addEventListener("click", () => {
    if (adoPing?.status === "auth") app.settingsDialog.open(t("Azure DevOps／TFS"));
    else void pingAdo();
  });
  window.setInterval(() => {
    if (!document.hidden) void pingAdo();
  }, 5 * 60_000);
  window.addEventListener("online", () => void pingAdo());
  // 切回視窗時：上次檢查超過一分鐘才再檢查。
  window.addEventListener("focus", () => {
    if (Date.now() - lastPing > 60_000) void pingAdo();
  });
}
