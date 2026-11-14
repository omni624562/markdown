/**
 * 即時預覽（編輯區）拖動段落調整順序：滑鼠移到段落、標題、清單項目上時，左邊出現「⋮⋮」把手，
 * 拖到別的位置放開就搬過去。規則和預覽一樣（app/preview-drag.ts 的 moveText）：
 * 標題整節一起搬、清單項目在項目之間（縮排與項目符號跟著目標清單）、其他區塊在區塊之間。
 * 哪一塊是什麼從 Markdown 的語法樹找（預覽是看 data-sourcepos）。只在即時預覽有，原始碼模式照舊用選取文字拖曳。
 */
import { ensureSyntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import type { LineRange } from "../block-move.ts";
import { sectionRange } from "../sections.ts";
import { app } from "./context.ts";
import { outlineHeadings } from "./outline-list.ts";
import { type DragKind, type DragTarget, commitMove, dragEnabled, makeHandle, moveText } from "./preview-drag.ts";

/** 編輯區裡一塊可以搬的東西。 */
interface Block {
  kind: DragKind;
  range: LineRange;
  heading: number;
  node: SyntaxNode;
}

interface Gap {
  target: DragTarget;
  /** 畫面上的位置（client 座標）。 */
  y: number;
  left: number;
  width: number;
}

const HEADING = /^(ATXHeading[1-6]|SetextHeading[12])$/;

let handle: HTMLButtonElement | null = null;
let marker: HTMLElement | null = null;
let hovered: Block | null = null;
let dragging: Block | null = null;

function live(): boolean {
  return dragEnabled() && app.editor.view.dom.classList.contains("cm-lp");
}

function lines(state: EditorState, node: SyntaxNode): LineRange {
  const doc = state.doc;
  const first = doc.lineAt(node.from).number;
  // 結尾剛好在下一行的開頭時，那一行不算。
  const end = doc.lineAt(node.to);
  const last = end.from === node.to && node.to > node.from ? end.number - 1 : end.number;
  return { first, last: Math.max(first, last) };
}

function tree(state: EditorState) {
  return ensureSyntaxTree(state, state.doc.length, 200);
}

/** 文件最上層的區塊（Document 的子節點）。 */
function topBlocks(state: EditorState): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const t = tree(state);
  for (let n = t?.topNode.firstChild ?? null; n; n = n.nextSibling) out.push(n);
  return out;
}

function toBlock(state: EditorState, node: SyntaxNode): Block {
  const range = lines(state, node);
  if (node.name === "ListItem") return { kind: "item", range, heading: -1, node };
  if (HEADING.test(node.name)) {
    const heading = outlineHeadings.findIndex((h) => h.line === range.first);
    if (heading >= 0) {
      const s = sectionRange(outlineHeadings, heading, state.doc.lines);
      return { kind: "section", range: { first: s.first, last: s.end - 1 }, heading, node };
    }
  }
  return { kind: "block", range, heading: -1, node };
}

/**
 * 位置 `pos` 那一行所在的那一塊（清單項目優先，其次是最上層的區塊）。
 * 從那一行第一個不是空白的字找：滑鼠在短的一行的右邊時，位置會落在行尾，從那裡找會找不到段落。
 */
function blockAt(state: EditorState, pos: number): Block | null {
  const t = tree(state);
  if (!t) return null;
  const line = state.doc.lineAt(pos);
  if (!line.text.trim()) return null;
  const start = line.from + (line.text.length - line.text.trimStart().length);
  let top: SyntaxNode | null = null;
  for (let n: SyntaxNode | null = t.resolveInner(start, 1); n; n = n.parent) {
    if (n.name === "ListItem") return toBlock(state, n);
    if (n.parent && !n.parent.parent) top = n;
  }
  return top ? toBlock(state, top) : null;
}

/** 某一行在畫面上的上緣、下緣（client 座標）。 */
function lineBox(line: number): { top: number; bottom: number } {
  const view = app.editor.view;
  const b = view.lineBlockAt(view.state.doc.line(line).from);
  return { top: b.top + view.documentTop, bottom: b.bottom + view.documentTop };
}

function gaps(src: Block): Gap[] {
  const view = app.editor.view;
  const state = view.state;
  const content = view.contentDOM.getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(view.contentDOM.querySelector(".cm-line") ?? view.contentDOM).paddingLeft) || 0;
  const left = content.left + pad;
  const width = content.width - pad * 2;
  const out: Gap[] = [];
  const inside = (r: LineRange) => r.first >= src.range.first && r.first <= src.range.last;
  if (src.kind === "item") {
    const items: SyntaxNode[] = [];
    tree(state)?.iterate({
      enter: (n) => {
        if (n.name === "ListItem") items.push(n.node);
      },
    });
    for (const node of items) {
      const r = lines(state, node);
      if (inside(r)) continue;
      const line = state.doc.line(r.first);
      const indent = line.text.length - line.text.trimStart().length;
      const x = view.coordsAtPos(line.from + indent)?.left ?? left;
      const box = lineBox(r.first);
      const prev = node.prevSibling?.name === "ListItem" ? lineBox(lines(state, node.prevSibling).last).bottom : null;
      out.push({ target: { range: r, after: false }, y: prev === null ? box.top : (prev + box.top) / 2, left: x, width: left + width - x });
      if (node.nextSibling?.name !== "ListItem") {
        out.push({ target: { range: r, after: true }, y: lineBox(r.last).bottom + 2, left: x, width: left + width - x });
      }
    }
    return out;
  }
  const blocks = topBlocks(state);
  let prevBottom: number | null = null;
  for (const node of blocks) {
    const r = lines(state, node);
    const box = { top: lineBox(r.first).top, bottom: lineBox(r.last).bottom };
    if (!inside(r) && (src.kind !== "section" || HEADING.test(node.name))) {
      out.push({ target: { range: r, after: false }, y: prevBottom === null ? box.top : (prevBottom + box.top) / 2, left, width });
    }
    prevBottom = box.bottom;
  }
  if (prevBottom !== null) out.push({ target: { range: null, after: true }, y: prevBottom + 4, left, width });
  return out;
}

function nearest(src: Block, y: number): Gap | null {
  let best: Gap | null = null;
  for (const g of gaps(src)) if (!best || Math.abs(g.y - y) < Math.abs(best.y - y)) best = g;
  return best;
}

/** 把手放在這一塊第一行的中間、文字左邊（清單項目放在項目符號左邊，標題放在 # 左邊）。 */
function place(block: Block): void {
  const v = app.editor.view;
  if (block.range.first > v.state.doc.lines) return hide();
  const line = v.state.doc.line(block.range.first);
  const indent = line.text.length - line.text.trimStart().length;
  const x = v.coordsAtPos(line.from + indent)?.left ?? v.contentDOM.getBoundingClientRect().left;
  const box = lineBox(block.range.first);
  handle!.style.top = `${(box.top + Math.min(box.bottom, box.top + 40)) / 2}px`;
  handle!.style.left = `${Math.max(2, x - 26)}px`;
  handle!.hidden = false;
}

function hide(): void {
  if (handle) handle.hidden = true;
  hovered = null;
}

function clear(): void {
  if (marker) marker.hidden = true;
  dragging = null;
}

export function initLiveDrag(): void {
  const view = () => app.editor.view;
  const pane = app.$(".editor-pane");
  handle = makeHandle();
  handle.classList.add("live-drag-handle");
  marker = document.createElement("div");
  marker.className = "preview-drop-line live-drop-line";
  marker.hidden = true;
  document.body.append(handle, marker);

  pane.addEventListener("mousemove", (e) => {
    if (dragging || e.buttons) return;
    if (handle!.contains(e.target as Node)) return;
    const v = view();
    if (!live() || !v.contentDOM.contains(e.target as Node)) return hide();
    const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
    const block = pos === null ? null : blockAt(v.state, pos);
    if (!block) return hide();
    if (hovered && hovered.node.from === block.node.from && hovered.node.to === block.node.to) return;
    hovered = block;
    place(block);
  });
  pane.addEventListener("mouseleave", (e) => {
    // 移到把手上（把手在編輯區外面的 body 上，滑鼠下面可能是裡面的圖示）不算離開。
    if (!dragging && !handle!.contains(e.relatedTarget as Node | null)) hide();
  });
  // 捲動時跟著移（內容換掉後編輯器也可能晚一點才捲動）。
  app.editor.view.scrollDOM.addEventListener("scroll", () => {
    if (hovered && !dragging) place(hovered);
  });

  handle.addEventListener("mouseleave", (e) => {
    if (!dragging && !pane.contains(e.relatedTarget as Node | null)) hide();
  });
  handle.addEventListener("dragstart", (e) => {
    if (!hovered || !live() || !e.dataTransfer) return e.preventDefault();
    dragging = hovered;
    const text = view().state.doc.sliceString(view().state.doc.line(dragging.range.first).from, view().state.doc.line(dragging.range.last).to);
    e.dataTransfer.setData("text/plain", text.trim());
    e.dataTransfer.effectAllowed = "copyMove";
    // 拖曳開始後才藏起把手（在 dragstart 裡直接藏起被拖的元素會取消拖曳）。
    requestAnimationFrame(() => {
      if (dragging) handle!.hidden = true;
    });
  });
  // 在捕捉階段處理：不讓編輯器把拖進來的文字插進去。
  pane.addEventListener(
    "dragover",
    (e) => {
      if (!dragging) return;
      const gap = nearest(dragging, e.clientY);
      if (!gap) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer!.dropEffect = "move";
      marker!.hidden = false;
      marker!.style.top = `${gap.y}px`;
      marker!.style.left = `${gap.left}px`;
      marker!.style.width = `${gap.width}px`;
    },
    true,
  );
  pane.addEventListener("dragleave", (e) => {
    if (dragging && !pane.contains(e.relatedTarget as Node | null)) marker!.hidden = true;
  });
  pane.addEventListener(
    "drop",
    (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      const src = dragging;
      const gap = nearest(src, e.clientY);
      clear();
      // 內容會換掉，原本記的區塊位置就不準了：滑鼠再動時重新找。
      hide();
      const out = gap && moveText(src.kind, src.range, src.heading, gap.target);
      if (out) commitMove(out);
    },
    true,
  );
  document.addEventListener("dragend", () => {
    if (dragging) clear();
  });
}
