/**
 * 離線提示：連線檢查判斷連不到 Azure DevOps 時，工作項目、工作板、Wiki 面板上方顯示一條提示與「重試」；
 * 恢復連線時忘掉剛讀到的副本，重新讀取畫面上的內容。
 */
import { adoOnline } from "../ado-online.ts";
import { t } from "../i18n.ts";
import { icon } from "../ui/icons.ts";
import { pingAdo, adoPingOffline } from "./ado-status.ts";
import { app } from "./context.ts";
import { forgetListCopies } from "./offline-copies.ts";
import { wikiPanel, workItemsPanel } from "./work-items-panel.ts";

const banners: HTMLElement[] = [];

function render(): void {
  const offline = adoOnline.offline && !!app.ado?.account;
  document.body.classList.toggle("ado-offline", offline);
  for (const b of banners) {
    b.hidden = !offline;
    if (!offline) continue;
    const text = document.createElement("span");
    text.textContent = t("離線中：連不到 Azure DevOps，顯示的是之前存下的資料；改狀態、留言、編輯 Wiki 等要等連上之後。");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn btn-small load-retry";
    retry.append(icon("refresh-cw"), t("重試"));
    retry.addEventListener("click", () => {
      retry.disabled = true;
      void pingAdo().finally(() => (retry.disabled = false));
    });
    b.replaceChildren(icon("cloud-off"), text, retry);
  }
}

/** 恢復連線：畫面上顯示的副本都重新讀一次。 */
function reload(): void {
  forgetListCopies();
  if (app.sidePanel === "workitems") void workItemsPanel?.refresh(true);
  if (app.sidePanel === "wiki" || app.rightOutlineShown) void wikiPanel?.refresh(true);
  if (app.issueView.isOpen) void app.issueView.refresh(true);
}

export function initOfflineBanner(): void {
  for (const id of ["panel-workitems", "panel-board", "panel-wiki"]) {
    const b = document.createElement("div");
    b.className = "offline-banner";
    b.setAttribute("role", "status");
    b.hidden = true;
    app.$(`#${id} .side-head`).after(b);
    banners.push(b);
  }
  // 判斷是否離線的方法：連線檢查（幾秒內就有結果）。
  adoOnline.setRecheck(async () => {
    await pingAdo();
    return adoPingOffline();
  });
  adoOnline.listen((offline) => {
    render();
    if (!offline) reload();
  });
  render();
}
