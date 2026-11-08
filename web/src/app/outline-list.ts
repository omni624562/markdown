/**
 * 大綱的清單：依文件的標題畫出項目（標題沒變就不重建）、收合與展開（每個分頁各自記住）、「全部收合／全部展開」。
 * 拖曳搬移章節、目前的標題在 outline.ts。從 main.ts 拆出來，透過 `app` 取用目前的分頁與大綱的元素。
 */
import type { Heading } from "../../pkg/md_wasm.js";
import { t } from "../i18n.ts";
import { hiddenByCollapse, subtreeEnd } from "../sections.ts";
import { icon } from "../ui/icons.ts";
import { app } from "./context.ts";
import { updateActiveHeading } from "./outline.ts";

/** 大綱目前列出的標題。 */
export let outlineHeadings: Heading[] = [];

let outlineKey = "";
/** 大綱的結構（範圍、能否搬移、各標題的層級）；一樣時只更新項目的文字與行號。 */
let outlineShape = "";
/** 大綱收合的標題（每個分頁各自記住，以「層級 標題文字」辨認，編輯後仍維持）。 */
const outlineCollapsed = new Map<string, Set<string>>();

/** 分頁關掉時忘記它的收合狀態。 */
export function forgetOutlineCollapse(id: string): void {
  outlineCollapsed.delete(id);
}
const collapseKey = (h: Heading) => `${h.level} ${h.text}`;
function collapsedSet(): Set<string> {
  const scope = app.outlineView ? `view:${app.outlineView.key}` : app.active.id;
  let set = outlineCollapsed.get(scope);
  if (!set) outlineCollapsed.set(scope, (set = new Set()));
  return set;
}

/** 「全部收合／全部展開」按鈕（放在大綱的標題列，`initOutlineList` 建立）。 */
let outlineCollapseAll: HTMLButtonElement;

/** 建立大綱標題列上的「全部收合／全部展開」按鈕。 */
export function initOutlineList(): void {
  outlineCollapseAll = document.createElement("button");
  outlineCollapseAll.type = "button";
  outlineCollapseAll.className = "btn icon-only";
  outlineCollapseAll.addEventListener("click", () => {
    const set = collapsedSet();
    const levels = outlineHeadings.map((h) => h.level);
    if (set.size) set.clear();
    else outlineHeadings.forEach((h, i) => subtreeEnd(levels, i) > i + 1 && set.add(collapseKey(h)));
    applyOutlineCollapse();
  });
  const actions = document.createElement("div");
  actions.className = "side-actions";
  actions.append(outlineCollapseAll);
  app.$("#panel-outline .side-head").append(actions);
}

/** 依收合狀態隱藏子標題，更新三角形與「全部收合／展開」按鈕。 */
function applyOutlineCollapse(): void {
  const set = collapsedSet();
  const levels = outlineHeadings.map((h) => h.level);
  const isCollapsed = (i: number) => set.has(collapseKey(outlineHeadings[i]));
  const hidden = hiddenByCollapse(levels, isCollapsed);
  app.outlineList.querySelectorAll<HTMLLIElement>(":scope > li").forEach((li, i) => {
    li.hidden = hidden[i];
    const toggle = li.querySelector<HTMLButtonElement>(".outline-toggle");
    if (!toggle) return;
    const collapsed = isCollapsed(i);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.title = collapsed ? t("展開") : t("收合");
    toggle.setAttribute("aria-label", toggle.title);
  });
  const any = [...set].some((k) => outlineHeadings.some((h) => collapseKey(h) === k));
  if (!any) set.clear();
  const canCollapse = outlineHeadings.some((_, i) => subtreeEnd(levels, i) > i + 1);
  outlineCollapseAll.hidden = !canCollapse;
  const label = any ? t("全部展開") : t("全部收合");
  outlineCollapseAll.title = label;
  outlineCollapseAll.setAttribute("aria-label", label);
  outlineCollapseAll.replaceChildren(icon(any ? "chevrons-up-down" : "chevrons-down-up"));
  updateActiveHeading();
}

/** 收合或展開第 `index` 個標題；`collapse` 省略時切換。 */
export function toggleOutline(index: number, collapse?: boolean): boolean {
  const h = outlineHeadings[index];
  const levels = outlineHeadings.map((o) => o.level);
  if (!h || subtreeEnd(levels, index) <= index + 1) return false;
  const set = collapsedSet();
  const key = collapseKey(h);
  const next = collapse ?? !set.has(key);
  if (next === set.has(key)) return false;
  if (next) set.add(key);
  else set.delete(key);
  applyOutlineCollapse();
  return true;
}

export function renderOutline(headings: Heading[]): void {
  const emptyEl = app.$("#outline-empty");
  emptyEl.hidden = headings.length > 0;
  emptyEl.textContent = app.outlineView
    ? t("這一頁沒有標題。")
    : app.cur.kind === "markdown"
      ? t("文件中還沒有標題。用 # 開頭的行會出現在這裡。")
      : t("只有 Markdown 文件的標題會顯示在大綱中。");
  outlineHeadings = headings;
  // Wiki、工作項目是唯讀的，不能拖曳搬移章節。
  const movable = !app.outlineView && app.cur.kind === "markdown";
  const scope = app.outlineView ? `view:${app.outlineView.key}` : app.active.id;
  // 標題沒有變（大多數按鍵都是這樣）就不重建，大文件可能有上千個標題。
  const key = `${scope}\n${movable}\n${headings.map((h) => `${h.level} ${h.line} ${h.id} ${h.text}`).join("\n")}`;
  if (key === outlineKey && app.outlineList.childElementCount === headings.length) return;
  outlineKey = key;
  const levels = headings.map((h) => h.level);
  // 標題的數量與層級都沒變（例如正在改某個標題的文字、在上面加了一行）：只更新原本的項目，
  // 不重建整份大綱（重建後要重新標示目前的段落、捲到它的位置，大文件每個字都要重新排版）。
  const shape = `${scope}\n${movable}\n${levels.join(",")}`;
  if (shape === outlineShape && app.outlineList.childElementCount === headings.length) {
    const links = app.outlineList.querySelectorAll<HTMLAnchorElement>("a");
    headings.forEach((h, i) => {
      const a = links[i];
      if (a.dataset.id !== h.id) {
        a.href = `#${encodeURIComponent(h.id)}`;
        a.dataset.id = h.id;
      }
      if (a.dataset.line !== String(h.line)) a.dataset.line = String(h.line);
      const label = h.text || t("（空白標題）");
      if (a.textContent !== label) a.textContent = label;
    });
    return;
  }
  outlineShape = shape;
  // 重新產生大綱時保留鍵盤焦點（例如用 Alt+↑／↓ 連續搬移章節）。
  const focused = document.activeElement as HTMLElement | null;
  const focusedIndex = focused && app.outlineList.contains(focused) ? Number(focused.dataset.index) : -1;
  const top = Math.min(...levels);
  app.outlineList.replaceChildren(
    ...headings.map((h, i) => {
      const li = document.createElement("li");
      li.style.setProperty("--depth", String(h.level - top));
      const a = document.createElement("a");
      a.href = `#${encodeURIComponent(h.id)}`;
      a.dataset.id = h.id;
      a.dataset.line = String(h.line);
      a.dataset.index = String(i);
      a.textContent = h.text || t("（空白標題）");
      a.style.setProperty("--level", String(h.level));
      // 連結預設可以拖曳：不能搬移章節時關掉，免得拖出網址。
      a.draggable = movable;
      if (movable) a.title = t("拖曳可以搬移整個章節；也可以按 Alt+↑／↓");
      // 有子標題的才有收合的三角形（不在 Tab 順序裡，鍵盤用 ←／→）。
      if (subtreeEnd(levels, i) > i + 1) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "outline-toggle";
        toggle.tabIndex = -1;
        toggle.dataset.index = String(i);
        toggle.append(icon("chevron-down"));
        li.append(toggle);
      }
      li.append(a);
      return li;
    }),
  );
  applyOutlineCollapse();
  if (focusedIndex >= 0) app.outlineList.querySelectorAll<HTMLElement>("a")[focusedIndex]?.focus({ preventScroll: true });
}
