/**
 * 在預覽拖動段落調整順序：滑鼠移到預覽的段落、標題、清單項目上時，左邊出現「⋮⋮」把手，
 * 拖到別的位置放開就搬過去（改的是原始 Markdown，Ctrl+Z 或通知上的「復原」可以還原）。
 * - 標題：整個章節（標題到下一個同級或更高級的標題之前）一起搬，放在別的標題前面或文件最後（和大綱拖曳一樣）。
 * - 清單項目（含子項目）：放在別的項目之間，縮排與項目符號換成目標清單的。
 * - 其他區塊（段落、表格、程式碼、引言、圖片）：放在其他區塊之間。
 * 只在 Markdown 文件、可以編輯、沒有在看差異時有。拖到助理的輸入區是把那段文字放進問題（帶著 text/plain）。
 */
import { undo } from "@codemirror/commands";
import { type LineRange, moveBlock, moveListItem } from "../block-move.ts";
import { t } from "../i18n.ts";
import { parseSourcepos } from "../scroll-sync.ts";
import { moveSection, sectionRange } from "../sections.ts";
import { icon } from "../ui/icons.ts";
import { toast } from "../ui/toast.ts";
import { app } from "./context.ts";
import { outlineHeadings } from "./outline-list.ts";

type Kind = "section" | "item" | "block";

/** 要搬的東西：預覽裡的元素與它在原始碼的行範圍。 */
interface Source {
  kind: Kind;
  el: HTMLElement;
  range: LineRange;
  /** 章節：第幾個標題（`outlineHeadings` 的索引）。 */
  heading: number;
}

/** 放開的位置：放在 `el` 前面，或（`after`）後面。 */
interface Gap {
  el: HTMLElement | null;
  after: boolean;
  /** 預覽內容裡的高度（px，含捲動）。 */
  y: number;
  left: number;
  width: number;
}

let handle: HTMLButtonElement | null = null;
let marker: HTMLElement | null = null;
let hovered: Source | null = null;
let dragging: Source | null = null;

const range = (el: Element): LineRange | null => {
  const pos = parseSourcepos(el.getAttribute("data-sourcepos"));
  return pos ? { first: pos.start, last: pos.end } : null;
};

function enabled(): boolean {
  return app.cur.kind === "markdown" && !app.editor.view.state.readOnly && !app.review.active;
}

/** 滑鼠下面那一塊可以搬的東西（清單項目優先，其次是預覽最上層的區塊）。 */
function sourceAt(target: EventTarget | null): Source | null {
  if (!(target instanceof Element)) return null;
  const root = app.previewEl;
  const li = target.closest<HTMLElement>("li[data-sourcepos]");
  if (li && root.contains(li)) {
    const r = range(li);
    if (r) return { kind: "item", el: li, range: r, heading: -1 };
  }
  let el: Element | null = target;
  while (el && el.parentElement !== root) el = el.parentElement;
  if (!(el instanceof HTMLElement) || !el.hasAttribute("data-sourcepos")) return null;
  const r = range(el);
  if (!r) return null;
  if (/^H[1-6]$/.test(el.tagName)) {
    const heading = outlineHeadings.findIndex((h) => h.line === r.first);
    if (heading >= 0) {
      const s = sectionRange(outlineHeadings, heading, app.editor.view.state.doc.lines);
      return { kind: "section", el, range: { first: s.first, last: s.end - 1 }, heading };
    }
  }
  return { kind: "block", el, range: r, heading: -1 };
}

/** 元素在預覽捲動容器裡的位置（含捲動）。 */
function place(el: Element): { top: number; bottom: number; left: number; width: number } {
  const s = app.previewScroller;
  const base = s.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { top: r.top - base.top + s.scrollTop, bottom: r.bottom - base.top + s.scrollTop, left: r.left - base.left + s.scrollLeft, width: r.width };
}

/** 可以放的位置（依種類）。 */
function gaps(src: Source): Gap[] {
  const root = app.previewEl;
  const out: Gap[] = [];
  // 線畫在兩塊之間（前一塊的下緣和這一塊的上緣中間）。
  const add = (el: HTMLElement | null, after: boolean, at: { top: number; bottom: number; left: number; width: number }, prev?: Element | null) => {
    const y = after ? at.bottom + 4 : prev ? (place(prev).bottom + at.top) / 2 : at.top - 4;
    out.push({ el, after, y, left: at.left, width: at.width });
  };
  if (src.kind === "item") {
    const items = [...root.querySelectorAll<HTMLElement>("li[data-sourcepos]")].filter((li) => li !== src.el && !src.el.contains(li));
    for (const li of items) {
      const at = place(li);
      add(li, false, at, li.previousElementSibling);
      // 清單的最後一項後面也可以放。
      if (!li.nextElementSibling) add(li, true, at);
    }
    return out;
  }
  const blocks = [...root.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el.hasAttribute("data-sourcepos"));
  const inside = (el: HTMLElement) => {
    const r = range(el);
    return !!r && r.first >= src.range.first && r.first <= src.range.last;
  };
  for (const el of blocks) {
    if (inside(el)) continue;
    // 章節只能放在別的標題前面（或文件最後），和大綱拖曳一樣。
    if (src.kind === "section" && !/^H[1-6]$/.test(el.tagName)) continue;
    add(el, false, place(el), el.previousElementSibling);
  }
  const last = blocks.at(-1);
  if (last) add(null, true, place(last));
  return out;
}

function nearest(src: Source, clientY: number): Gap | null {
  const s = app.previewScroller;
  const y = clientY - s.getBoundingClientRect().top + s.scrollTop;
  let best: Gap | null = null;
  for (const g of gaps(src)) if (!best || Math.abs(g.y - y) < Math.abs(best.y - y)) best = g;
  return best;
}

/** 搬完的內容；位置沒變時是 null。 */
function moved(src: Source, gap: Gap): string | null {
  const text = app.editor.text;
  const lines = app.editor.view.state.doc.lines;
  if (src.kind === "item") {
    const target = gap.el && range(gap.el);
    return target ? moveListItem(text, src.range, target, gap.after) : null;
  }
  if (src.kind === "section") {
    let before = outlineHeadings.length;
    if (gap.el) {
      const r = range(gap.el);
      before = outlineHeadings.findIndex((h) => h.line === r?.first);
      if (before < 0) return null;
    }
    return moveSection(text, outlineHeadings, src.heading, before);
  }
  const target = gap.el ? range(gap.el)?.first : lines + 1;
  return target ? moveBlock(text, src.range, target) : null;
}

function hideHandle(): void {
  if (handle) handle.hidden = true;
  hovered = null;
}

function clear(): void {
  if (marker) marker.hidden = true;
  dragging?.el.classList.remove("drag-source");
  dragging = null;
}

export function initPreviewDrag(): void {
  const scroller = app.previewScroller;
  handle = document.createElement("button");
  handle.type = "button";
  handle.className = "preview-drag-handle";
  handle.draggable = true;
  handle.hidden = true;
  handle.title = t("拖曳調整順序");
  handle.setAttribute("aria-label", t("拖曳調整順序"));
  handle.append(icon("grip-vertical"));
  marker = document.createElement("div");
  marker.className = "preview-drop-line";
  marker.hidden = true;
  scroller.append(handle, marker);

  scroller.addEventListener("mousemove", (e) => {
    if (dragging || e.buttons) return;
    if (e.target === handle || handle!.contains(e.target as Node)) return;
    const src = enabled() ? sourceAt(e.target) : null;
    if (!src) return hideHandle();
    if (hovered?.el === src.el) return;
    hovered = src;
    const at = place(src.el);
    // 把手對齊第一行的中間，放在區塊左邊：清單項目放在項目符號左邊，標題放在「#」連結左邊。
    const font = parseFloat(getComputedStyle(src.el).fontSize);
    const lineH = Math.min(at.bottom - at.top, font * 1.6);
    const gap = src.kind === "item" ? 40 : src.kind === "section" ? 26 + font : 26;
    handle!.style.top = `${at.top + lineH / 2}px`;
    handle!.style.left = `${Math.max(2, at.left - gap)}px`;
    handle!.hidden = false;
  });
  scroller.addEventListener("mouseleave", (e) => {
    if (!dragging && e.relatedTarget !== handle) hideHandle();
  });

  handle.addEventListener("dragstart", (e) => {
    if (!hovered || !enabled() || !e.dataTransfer) return e.preventDefault();
    dragging = hovered;
    const lines = app.editor.text.split("\n").slice(dragging.range.first - 1, dragging.range.last);
    // 帶著文字：拖到助理的輸入區時放進問題。
    e.dataTransfer.setData("text/plain", lines.join("\n").trim());
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setDragImage(dragging.el, 0, 0);
    // 拖曳開始後才藏起把手：在 dragstart 裡直接藏起被拖的元素，有些瀏覽器會取消這次拖曳。
    requestAnimationFrame(() => {
      dragging?.el.classList.add("drag-source");
      if (dragging) handle!.hidden = true;
    });
  });
  scroller.addEventListener("dragover", (e) => {
    if (!dragging) return;
    const gap = nearest(dragging, e.clientY);
    if (!gap) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    marker!.hidden = false;
    marker!.style.top = `${gap.y}px`;
    marker!.style.left = `${gap.left}px`;
    marker!.style.width = `${gap.width}px`;
  });
  scroller.addEventListener("dragleave", (e) => {
    if (dragging && !scroller.contains(e.relatedTarget as Node | null)) marker!.hidden = true;
  });
  scroller.addEventListener("drop", (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
    const src = dragging;
    const gap = nearest(src, e.clientY);
    clear();
    const out = gap && moved(src, gap);
    if (!out) return;
    app.editor.replaceAll(out, { userEvent: "move.block", isolate: true });
    app.renderNow();
    toast(t("已調整順序"), { action: { label: t("復原"), run: () => void (undo(app.editor.view), app.renderNow()) } });
  });
  document.addEventListener("dragend", () => {
    if (dragging) clear();
  });
}
