/**
 * 右側欄的分頁：大綱、反向連結、Wiki、助理放在同一欄（`aside#outline-right`），一次顯示一頁。
 * 分頁列是右側欄自己的第一列（和 VSCode 的右側欄一樣），不放在頂端列：頂端列右上角只留開關和視窗按鈕，
 * 分頁再多、右側欄再窄也不會被視窗按鈕擠掉。視窗不夠寬時右側欄是蓋在文件上的抽屜，分頁列一樣在最上面。
 * 哪些分頁有：大綱與反向連結（設定「大綱放在右邊」）、Wiki（Wiki 放在右側、連上 Azure DevOps）、
 * 助理（設定開了 Claude API 助理）；選了哪一頁記住。
 */
import { t } from "../i18n.ts";
import { ASSISTANT_MIN_WIDTH, RIGHT_TABS, type RightTab, parseRightTab, pickRightTab } from "../right-tabs-model.ts";
import * as storage from "../storage.ts";
import { assistantEnabled, assistantPanel, assistantShown } from "./assistant.ts";
import { app } from "./context.ts";
import { wikiPanel } from "./work-items-panel.ts";
import { outlinePlacedRight, renderBacklinks, wikiPlacedRight } from "./workspace-ui.ts";

const TAB_KEY = "right-tab";
const WIDTH_KEY = "outline-right-width";

let saved: RightTab | null = parseRightTab(storage.load(TAB_KEY));
let strip: HTMLElement | null = null;
const buttons = new Map<RightTab, HTMLButtonElement>();
/** 反向連結在右側欄自成一頁：這個盒子裝原本在大綱底下的反向連結（移回左邊時放回去）。 */
let backlinksBox: HTMLElement | null = null;
let backlinksCount = 0;

const LABELS: Record<RightTab, () => string> = {
  outline: () => t("大綱"),
  backlinks: () => t("反向連結"),
  wiki: () => "Wiki", // i18n-ignore
  assistant: () => t("助理"),
};

/** 現在有哪些分頁（依左到右的順序）。 */
export function availableRightTabs(): RightTab[] {
  const out: RightTab[] = [];
  if (outlinePlacedRight()) out.push("outline", "backlinks");
  if (wikiPlacedRight()) out.push("wiki");
  if (assistantEnabled()) out.push("assistant");
  return out;
}

/** 現在要顯示的分頁；右側欄沒東西（或只有還沒打開過的助理）時 null。 */
export function rightTab(): RightTab | null {
  return pickRightTab(saved, availableRightTabs());
}

/** 切到某一頁（記住），右側欄收著時不自動打開（呼叫端決定）。 */
export function selectRightTab(tab: RightTab): void {
  saved = tab;
  storage.save(TAB_KEY, tab);
  // 助理要比大綱寬：右側欄太窄時撐寬一點（記住，之後拖曳調整照舊）。
  if (tab === "assistant") {
    const now = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--outline-right-width")) || 0;
    if (now < ASSISTANT_MIN_WIDTH) {
      document.documentElement.style.setProperty("--outline-right-width", `${ASSISTANT_MIN_WIDTH}px`);
      storage.save(WIDTH_KEY, String(ASSISTANT_MIN_WIDTH));
    }
  }
  app.applyLayout();
  if (rightTab() !== tab || app.$("aside#outline-right").hidden) return;
  if (tab === "outline") app.updateActiveHeading();
  else if (tab === "backlinks") void renderBacklinks();
  else if (tab === "wiki") wikiPanel?.shown();
  else assistantShown();
}

/** 反向連結重新列出後更新分頁上的數字（幾份文件連到這裡）。 */
export function showBacklinksCount(n: number): void {
  backlinksCount = n;
  renderBadge();
  // 清單藏起來（不是專案裡的 Markdown 文件）時顯示說明。
  const list = document.querySelector<HTMLElement>("section#backlinks");
  const note = backlinksBox?.querySelector<HTMLElement>(":scope > .side-empty");
  if (note && list) note.hidden = !list.hidden;
}

function renderBadge(): void {
  const badge = buttons.get("backlinks")?.querySelector<HTMLElement>(".right-tab-badge");
  if (!badge) return;
  badge.textContent = String(backlinksCount);
  badge.hidden = backlinksCount === 0;
}

/** 分頁列（第一次用到才建立）：按鈕是 tab，左右鍵在分頁之間移動。 */
function buildStrip(): HTMLElement {
  const el = document.createElement("div");
  el.className = "right-tabs";
  el.role = "tablist";
  el.setAttribute("aria-label", t("右側欄"));
  for (const id of RIGHT_TABS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "right-tab";
    b.role = "tab";
    b.dataset.tab = id;
    b.hidden = true;
    const label = document.createElement("span");
    label.className = "right-tab-label";
    label.textContent = LABELS[id]();
    b.append(label);
    if (id === "backlinks") {
      const badge = document.createElement("span");
      badge.className = "right-tab-badge";
      badge.hidden = true;
      b.append(badge);
    }
    b.addEventListener("click", () => selectRightTab(id));
    buttons.set(id, b);
    el.append(b);
  }
  el.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const shown = [...buttons.values()].filter((b) => !b.hidden);
    const i = shown.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const next = shown[(i + (e.key === "ArrowRight" ? 1 : -1) + shown.length) % shown.length];
    next.focus();
    next.click();
  });
  return el;
}

/** 大綱在右側時，反向連結搬到自己的一頁；移回左邊時放回大綱的清單後面。 */
function placeBacklinks(outline: HTMLElement, right: HTMLElement, onRight: boolean): void {
  const list = document.querySelector<HTMLElement>("section#backlinks");
  if (!list) return;
  if (onRight) {
    if (!backlinksBox) {
      backlinksBox = Object.assign(document.createElement("div"), { className: "right-backlinks" });
      // 不是專案裡的 Markdown 文件時反向連結的清單是藏起來的：這一頁說明一下，不留空白。
      const note = Object.assign(document.createElement("p"), { className: "side-empty", textContent: t("只有專案裡的 Markdown 文件有反向連結。") });
      backlinksBox.append(note);
    }
    if (backlinksBox.parentElement !== right) right.append(backlinksBox);
    if (list.parentElement !== backlinksBox) backlinksBox.append(list);
    backlinksBox.querySelector<HTMLElement>(":scope > .side-empty")!.hidden = !list.hidden;
  } else if (backlinksBox?.isConnected) {
    outline.querySelector(":scope > .side-body")?.append(list);
    backlinksBox.remove();
  }
}

/**
 * 依面板目前放的位置整理右側欄（大綱、Wiki 移動後由 `placeOutline()` 呼叫，重複呼叫沒有影響）：
 * 分頁列放到該放的地方、只顯示選的那一頁、助理的面板放進右側欄。
 */
export function syncRightTabs(): void {
  const right = app.$("aside#outline-right");
  const outline = app.$("section#panel-outline");
  const wiki = document.querySelector<HTMLElement>("section#panel-wiki");
  const outlineRight = outline.parentElement === right;
  const wikiRight = !!wiki && wiki.parentElement === right;
  placeBacklinks(outline, right, outlineRight);
  const available = availableRightTabs();
  const current = pickRightTab(saved, available);
  // 助理的面板第一次要顯示時才建立，之後一直留在右側欄裡。
  const assistant = current === "assistant" || assistantPanel(false) ? assistantPanel(true) : null;
  if (assistant && assistant.parentElement !== right) right.append(assistant);

  strip ??= buildStrip();
  if (right.firstElementChild !== strip) right.prepend(strip);
  strip.hidden = !available.length;
  for (const [id, b] of buttons) {
    b.hidden = !available.includes(id);
    b.setAttribute("aria-selected", String(id === current));
    b.tabIndex = id === current ? 0 : -1;
  }
  const panels: [RightTab, HTMLElement | null][] = [
    ["outline", outlineRight ? outline : null],
    ["backlinks", outlineRight ? backlinksBox : null],
    ["wiki", wikiRight ? wiki : null],
    ["assistant", assistant],
  ];
  for (const [id, el] of panels) if (el) el.hidden = id !== current;
  right.dataset.tab = current ?? "";
  renderBadge();
}
