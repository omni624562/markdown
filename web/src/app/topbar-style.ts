/**
 * 頂端列樣式（設定 → 外觀 → 版面的「頂端列樣式」）：
 * - 專案列（`project`）：側邊欄開著時，左上放專案名稱與分支（從檔案面板最上面搬上來，檔案樹多一點空間）；
 *   分頁（含 ＋）和右邊的按鈕之間畫一條分隔線。
 * - 版面切換鈕組（`layout`）：左上放「快速開啟」「最近開啟」；左側欄開關從左上角移到右邊，
 *   和右側欄開關、「⋯」收成一個有底色的鈕組，開著的那一側白底強調色。
 * 窄視窗（手機）兩種都不搬：專案與分支留在檔案面板，側邊欄按鈕留在左上角。樣子由 styles.css 的
 * `[data-topbar-style]` 決定，這裡只搬元素。
 */
import { desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import type { Settings } from "../settings.ts";

const narrow = matchMedia("(max-width: 720px)");
let style: Settings["topbarStyle"] = "project";
let label: HTMLElement | null = null;

export function applyTopbarStyle(next: Settings["topbarStyle"]): void {
  style = next;
  document.documentElement.dataset.topbarStyle = next;
  place();
}

/** 把 `el` 放進 `parent`（`first` 是放在最前面）；已經在那裡就不動，免得焦點跑掉。 */
function put(parent: Element, el: Element, first = false): void {
  if (el.parentElement === parent && (first ? parent.firstElementChild === el : parent.lastElementChild === el)) return;
  if (first) parent.prepend(el);
  else parent.append(el);
}

function place(): void {
  const wide = !narrow.matches;
  const topbar = document.querySelector(".topbar");
  const switcher = document.querySelector(".project-switch");
  const branch = document.querySelector("#folder-branch");
  const head = document.querySelector("#panel-files .project-head");
  const up = document.querySelector(".topbar-project");
  const nav = document.querySelector(".nav-toggle");
  const actions = document.querySelector(".top-actions");
  if (!topbar || !switcher || !branch || !head || !up || !nav || !actions) return;

  // 專案與分支：只有桌面版有專案；網頁版一直留在檔案面板。
  const projectUp = style === "project" && wide && !!desktop;
  if (projectUp) {
    put(up, switcher);
    put(up, branch);
  } else {
    put(head, switcher, true);
    if (branch.previousElementSibling !== head.parentElement) head.parentElement?.after(branch);
  }
  // 專案搬上去後，檔案面板上方改寫「檔案」。
  if (!label) {
    label = document.createElement("span");
    label.className = "project-head-label";
    label.textContent = t("檔案");
    head.append(label);
  }
  label.hidden = !projectUp;

  // 左側欄開關：版面切換鈕組時放進右邊的鈕組，其他時候在左上角。
  if (style === "layout" && wide) put(actions, nav, true);
  else put(topbar, nav, true);

  // 最近開啟只有桌面版有。
  const recent = document.querySelector<HTMLElement>(".topbar-tools [data-command='open-recent']");
  if (recent) recent.hidden = !desktop;
}

narrow.addEventListener("change", place);
