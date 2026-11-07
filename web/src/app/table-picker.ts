/**
 * 插入表格時先選大小：和 Word 的「插入表格」一樣，滑鼠在格子上移動選要幾欄、幾列（含標題列），按一下插入。
 * 鍵盤：方向鍵調整、Enter 或空白鍵插入、Esc 取消。
 * 指令面板、插入選單、斜線指令、格式工具列的「插入表格」都從這裡開：開在游標旁邊，一律留在視窗內。
 */
import { formatTable } from "../../pkg/md_wasm.js";
import { insertBlock } from "../format.ts";
import { t } from "../i18n.ts";
import { blankTable, serializeTable } from "../table-model.ts";
import { placeMenu } from "../ui/menu-place.ts";
import { app } from "./context.ts";

/** 格子的大小（和 Word 一樣 10 欄 × 8 列；更大的表格插入後再用「＋列」「＋欄」或 Tab 加）。 */
export const PICKER_COLS = 10;
export const PICKER_ROWS = 8;
/** 剛打開時選好的大小：直接按 Enter 就插入這個大小。 */
const START = { cols: 3, rows: 3 };

let root: HTMLElement | null = null;
let grid: HTMLElement;
let label: HTMLElement;
let size = { ...START };

function build(): HTMLElement {
  const el = document.createElement("div");
  el.className = "menu table-picker";
  el.popover = "auto";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", t("插入表格"));
  grid = document.createElement("div");
  grid.className = "table-picker-grid";
  grid.tabIndex = 0;
  grid.setAttribute("role", "application");
  grid.setAttribute("aria-label", t("用方向鍵選要幾欄、幾列，按 Enter 插入"));
  grid.style.gridTemplateColumns = `repeat(${PICKER_COLS}, auto)`;
  for (let row = 1; row <= PICKER_ROWS; row++) {
    for (let col = 1; col <= PICKER_COLS; col++) {
      const cell = document.createElement("span");
      cell.className = row === 1 ? "table-picker-cell head" : "table-picker-cell";
      cell.dataset.col = String(col);
      cell.dataset.row = String(row);
      grid.append(cell);
    }
  }
  label = document.createElement("div");
  label.className = "table-picker-label";
  label.setAttribute("aria-live", "polite");
  el.append(grid, label);

  grid.addEventListener("mouseover", (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>(".table-picker-cell");
    if (cell) select(Number(cell.dataset.col), Number(cell.dataset.row));
  });
  grid.addEventListener("click", (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>(".table-picker-cell");
    if (!cell) return;
    select(Number(cell.dataset.col), Number(cell.dataset.row));
    insert();
  });
  grid.addEventListener("keydown", (e) => {
    const moves: Record<string, [number, number]> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
    const move = moves[e.key];
    if (move) select(size.cols + move[0], size.rows + move[1]);
    else if (e.key === "Enter" || e.key === " ") insert();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  el.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState !== "closed") return;
    // 按 Esc 或點旁邊關掉：游標回到文件（點的是其他輸入框時就留在那裡）。
    const active = document.activeElement;
    if (!active || active === document.body || el.contains(active)) app.editor.view.focus();
  });
  document.body.append(el);
  return el;
}

function select(cols: number, rows: number): void {
  size = { cols: Math.min(PICKER_COLS, Math.max(1, cols)), rows: Math.min(PICKER_ROWS, Math.max(1, rows)) };
  for (const cell of grid.children as HTMLCollectionOf<HTMLElement>) {
    cell.classList.toggle("on", Number(cell.dataset.col) <= size.cols && Number(cell.dataset.row) <= size.rows);
  }
  label.textContent = t("{cols} 欄 × {rows} 列", size);
}

function insert(): void {
  root?.hidePopover();
  const first = t("欄位 {n}", { n: 1 });
  const md = serializeTable(blankTable(size.cols, size.rows, (n) => t("欄位 {n}", { n })));
  // 插入後選取第一個欄位名稱，直接打字就能取代。
  app.editor.exec(insertBlock(formatTable(md) ?? md, first));
  app.editor.view.focus();
}

/** 在游標旁邊打開表格大小選擇器。 */
export function openTablePicker(): void {
  root ??= build();
  select(START.cols, START.rows);
  const view = app.editor.view;
  // 游標不在畫面上（例如只顯示預覽）時，開在編輯區的左上角。
  const edge = view.dom.getBoundingClientRect();
  const box = view.coordsAtPos(view.state.selection.main.head) ?? { left: edge.left + 24, top: edge.top + 24, bottom: edge.top + 24 };
  root.style.left = "0px";
  root.style.top = "0px";
  // 等指令面板、選單關好再打開（不然焦點會被它們還給編輯器）。
  setTimeout(() => {
    if (!root) return;
    root.showPopover();
    const rect = root.getBoundingClientRect();
    const place = placeMenu(
      { left: box.left, top: box.top, right: box.left, bottom: box.bottom },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    root.style.left = `${place.left}px`;
    root.style.top = `${place.top}px`;
    root.style.maxHeight = `${place.maxHeight}px`;
    grid.focus();
  });
}
