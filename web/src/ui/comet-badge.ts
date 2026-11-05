import { t } from "../i18n.ts";

/** 專案名稱後面的「COMET」小標籤：資料夾裡有 `.comet.json`（做過 comet setup）的專案。 */
export function cometBadge(): HTMLElement {
  const el = document.createElement("span");
  el.className = "comet-badge";
  el.textContent = "COMET";
  el.title = t("COMET 專案");
  return el;
}
