/**
 * 右側欄的分區（和 VS Code 的側邊欄一樣）：大綱、反向連結、Wiki 各有一列標題，按一下收合或展開；
 * 收合的分區只剩標題列，其他展開的分區撐滿整欄（收起大綱時 Wiki 就是整欄的高度）。
 * 大綱與 Wiki 都在右側、而且都展開時，中間有一條分隔線，可以拖曳或用方向鍵調整上下的高度，雙擊恢復一半一半。
 * 收合狀態與分隔線的位置都記住。只改右側欄：面板移回左邊的側邊欄時恢復原本的樣子。
 *
 * 右側欄與面板連標籤名稱一起找（`aside#outline-right`）：預覽裡文件標題的 id 是從標題文字來的
 * （`# Outline Right` 的 id 就是 `outline-right`），預覽又排在右側欄前面，只用 id 找會拿到標題。
 */
import { t } from "../i18n.ts";
import { type RightSection, SPLIT, clampSplit, formatCollapsed, parseCollapsed, parseSplit, stepSplit } from "../right-sections-model.ts";
import * as storage from "../storage.ts";
import { icon } from "../ui/icons.ts";
import { app } from "./context.ts";
import { wikiPanel } from "./work-items-panel.ts";

const COLLAPSED_KEY = "right-collapsed";
const SPLIT_KEY = "right-split";

const collapsed = parseCollapsed(storage.load(COLLAPSED_KEY));
let ratio = parseSplit(storage.load(SPLIT_KEY));
let backlinksCount = 0;

/** 每個分區的標題按鈕（第一次放到右側時才建立）。 */
const toggles = new Map<RightSection, HTMLButtonElement>();
/** 反向連結在右側欄自成一區：標題列加上原本的反向連結（移回左邊時放回大綱底下）。 */
let backlinksBox: HTMLElement | null = null;
let splitter: HTMLElement | null = null;

/** 分區的標題按鈕：三角形、名稱（反向連結還有數字），`aria-expanded` 是否展開。 */
function toggleFor(id: RightSection, label: string, body: HTMLElement): HTMLButtonElement {
  let b = toggles.get(id);
  if (b) return b;
  b = document.createElement("button");
  b.type = "button";
  b.className = "rs-toggle";
  b.dataset.section = id;
  const name = document.createElement("span");
  name.className = "rs-label";
  name.textContent = label;
  b.append(icon("chevron-down"), name);
  body.id ||= `rs-body-${id}`;
  b.setAttribute("aria-controls", body.id);
  b.addEventListener("click", () => setSectionCollapsed(id, !collapsed.has(id)));
  toggles.set(id, b);
  return b;
}

/** 面板（大綱、Wiki）的標題列：在右側欄時標題換成可以收合的按鈕，移回左邊時換回原本的文字。 */
function placeHead(id: RightSection, panel: HTMLElement, onRight: boolean): void {
  const h2 = panel.querySelector<HTMLElement>(":scope > .side-head > h2");
  const body = panel.querySelector<HTMLElement>(":scope > .side-body");
  if (!h2 || !body) return;
  const button = toggles.get(id);
  if (onRight && !button?.isConnected) {
    h2.replaceChildren(toggleFor(id, h2.textContent ?? "", body));
  } else if (!onRight && button && h2.contains(button)) {
    h2.replaceChildren(button.querySelector(".rs-label")?.textContent ?? "");
  }
  panel.classList.toggle("rs-collapsed", onRight && collapsed.has(id));
}

/** 大綱在右側時，反向連結搬到大綱底下自己的一區；移回左邊時放回大綱的清單後面。 */
function placeBacklinks(outline: HTMLElement, onRight: boolean): void {
  const list = document.querySelector<HTMLElement>("section#backlinks");
  if (!list) return;
  if (onRight) {
    if (!backlinksBox) {
      backlinksBox = document.createElement("div");
      backlinksBox.className = "rs-backlinks";
      const head = document.createElement("div");
      head.className = "side-head";
      const h2 = document.createElement("h2");
      const body = document.createElement("div");
      body.className = "rs-body";
      const button = toggleFor("backlinks", t("反向連結"), body);
      const badge = document.createElement("span");
      badge.className = "rs-badge";
      button.append(badge);
      h2.append(button);
      head.append(h2);
      backlinksBox.append(head, body);
    }
    if (backlinksBox.parentElement !== outline) outline.append(backlinksBox);
    const body = backlinksBox.querySelector(".rs-body")!;
    if (list.parentElement !== body) body.append(list);
    backlinksBox.classList.toggle("rs-collapsed", collapsed.has("backlinks"));
    renderBadge();
  } else if (backlinksBox?.isConnected) {
    outline.querySelector(":scope > .side-body")?.append(list);
    backlinksBox.remove();
  }
}

function renderBadge(): void {
  const badge = toggles.get("backlinks")?.querySelector<HTMLElement>(".rs-badge");
  if (!badge) return;
  badge.textContent = String(backlinksCount);
  badge.hidden = backlinksCount === 0;
}

/** 反向連結重新列出後更新標題列上的數字（幾份文件連到這裡）。 */
export function showBacklinksCount(n: number): void {
  backlinksCount = n;
  renderBadge();
}

/** 大綱與 Wiki 兩塊加起來的高度（分隔線不算）。 */
function splitTotal(): number {
  const outline = document.querySelector<HTMLElement>("section#panel-outline");
  const wiki = document.querySelector<HTMLElement>("section#panel-wiki");
  return (outline?.getBoundingClientRect().height ?? 0) + (wiki?.getBoundingClientRect().height ?? 0);
}

function setSplit(r: number): void {
  ratio = r;
  storage.save(SPLIT_KEY, String(r));
  applySplit();
}

function applySplit(): void {
  const right = document.querySelector<HTMLElement>("aside#outline-right");
  right?.style.setProperty("--rs-top", String(ratio));
  right?.style.setProperty("--rs-bottom", String(Math.round((1 - ratio) * 1000) / 1000));
  splitter?.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
}

/** 大綱與 Wiki 之間的分隔線：拖曳、方向鍵（Shift 一次移多一點）、Home／End 調整，雙擊恢復一半一半。 */
function createSplitter(): HTMLElement {
  const handle = document.createElement("div");
  handle.className = "rs-splitter";
  handle.role = "separator";
  handle.tabIndex = 0;
  handle.title = t("拖曳調整高度（雙擊恢復）");
  handle.setAttribute("aria-orientation", "horizontal");
  handle.setAttribute("aria-label", t("調整大綱與 Wiki 的高度（方向鍵調整，雙擊恢復）"));
  handle.setAttribute("aria-controls", "panel-outline panel-wiki");
  handle.setAttribute("aria-valuemin", String(Math.round(SPLIT.min * 100)));
  handle.setAttribute("aria-valuemax", String(Math.round(SPLIT.max * 100)));
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const top = app.$("section#panel-outline").getBoundingClientRect().top;
    const total = splitTotal();
    // 按住的地方離分隔線上緣多遠：拖曳時分隔線跟著滑鼠，不會一按下就跳一下。
    const grab = e.clientY - handle.getBoundingClientRect().top;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing-rows");
    handle.classList.add("dragging");
    const move = (ev: PointerEvent) => setSplit(clampSplit((ev.clientY - grab - top) / total, total));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      document.body.classList.remove("resizing-rows");
      handle.classList.remove("dragging");
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  });
  handle.addEventListener("dblclick", () => setSplit(clampSplit(SPLIT.default, splitTotal())));
  handle.addEventListener("keydown", (e) => {
    const total = splitTotal();
    const px = e.shiftKey ? SPLIT.bigStep : SPLIT.step;
    if (e.key === "ArrowUp") setSplit(stepSplit(ratio, -px, total));
    else if (e.key === "ArrowDown") setSplit(stepSplit(ratio, px, total));
    else if (e.key === "Home") setSplit(clampSplit(0, total));
    else if (e.key === "End") setSplit(clampSplit(1, total));
    else return;
    e.preventDefault();
  });
  return handle;
}

/**
 * 依面板目前放的位置整理右側欄（大綱、Wiki 移動後由 `placeOutline()` 呼叫，重複呼叫沒有影響）：
 * 標題列、反向連結那一區、收合狀態，以及兩塊都在右側又都展開時的分隔線。
 */
export function syncRightSections(): void {
  const right = app.$("aside#outline-right");
  const outline = app.$("section#panel-outline");
  const wiki = document.querySelector<HTMLElement>("section#panel-wiki");
  const outlineRight = outline.parentElement === right;
  const wikiRight = !!wiki && wiki.parentElement === right;
  placeHead("outline", outline, outlineRight);
  placeBacklinks(outline, outlineRight);
  if (wiki) placeHead("wiki", wiki, wikiRight);
  for (const [id, b] of toggles) b.setAttribute("aria-expanded", String(!collapsed.has(id)));
  splitter ??= createSplitter();
  if (wiki && wikiRight) {
    if (splitter.nextElementSibling !== wiki) wiki.before(splitter);
  } else if (splitter.parentElement !== right) right.append(splitter);
  const wikiOpen = wikiRight && !collapsed.has("wiki");
  const split = outlineRight && wikiOpen && !collapsed.has("outline");
  splitter.hidden = !split;
  right.classList.toggle("rs-split", split);
  right.classList.toggle("rs-wiki-open", wikiOpen);
  // 只剩反向連結展開（大綱收合、Wiki 收合或不在右側）：反向連結撐滿。
  right.classList.toggle("rs-fill-backlinks", outlineRight && collapsed.has("outline") && !collapsed.has("backlinks") && !wikiOpen);
  applySplit();
}

/** 收合或展開右側欄的一個分區（記住）。展開 Wiki 時讀取頁面、捲到目前的頁面。 */
export function setSectionCollapsed(id: RightSection, value: boolean): void {
  if (collapsed.has(id) === value) return;
  if (value) collapsed.add(id);
  else collapsed.delete(id);
  storage.save(COLLAPSED_KEY, formatCollapsed(collapsed));
  syncRightSections();
  if (value) return;
  if (id === "wiki") wikiPanel?.shown();
  if (id === "outline") app.updateActiveHeading();
}

export function sectionCollapsed(id: RightSection): boolean {
  return collapsed.has(id);
}
