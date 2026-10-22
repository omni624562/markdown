/**
 * 即時預覽中可以直接編輯的表格：點儲存格就能打字（顯示該格的 Markdown 原文），
 * Tab／Shift+Tab 移到下一格或上一格（最後一格按 Tab 新增一列）、Enter 移到下一列、Esc 存好並離開表格。
 * 滑鼠移到表格上時，右上角出現新增／刪除列與欄、對齊、顯示原始碼的按鈕。
 * 每次修改都改寫整個表格的 Markdown，再交給核心依中文字寬對齊。
 */
import { type EditorView, WidgetType } from "@codemirror/view";
import {
  type Align,
  type TableModel,
  cellText,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  parseTable,
  serializeTable,
  setAlign,
  setCell,
} from "./table-model.ts";

/** 表格重畫後要接著編輯的儲存格（用表格在文件中的起點辨認，修改表格不會改變起點）。 */
let pendingFocus: { from: number; row: number; col: number } | null = null;

interface Cell {
  row: number;
  col: number;
}

export class EditableTableWidget extends WidgetType {
  readonly markdown: string;
  readonly render: (markdown: string) => string;
  readonly format: (markdown: string) => string | undefined;
  constructor(
    markdown: string,
    render: (markdown: string) => string,
    format: (markdown: string) => string | undefined,
  ) {
    super();
    this.markdown = markdown;
    this.render = render;
    this.format = format;
  }

  eq(other: EditableTableWidget): boolean {
    return other.markdown === this.markdown;
  }

  ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-block cm-lp-table markdown-body";
    wrap.innerHTML = this.render(this.markdown);
    const table = wrap.querySelector("table");
    if (!table) return wrap;
    const cells = [...table.rows].map((tr, row) =>
      [...tr.cells].map((td, col) => {
        td.dataset.row = String(row);
        td.dataset.col = String(col);
        return td;
      }),
    );
    let editing: HTMLTableCellElement | null = null;
    let current: Cell = { row: cells.length - 1, col: 0 };
    /** 正在用鍵盤或按鈕移動：失去焦點時不要另外存一次。 */
    let moving = false;

    const at = (c: Cell) => cells[c.row]?.[c.col] as HTMLTableCellElement | undefined;
    const tableFrom = () => view.posAtDOM(wrap);

    /** 目前的模型，包含正在編輯但還沒存的儲存格。 */
    const model = (): TableModel => {
      const m = parseTable(this.markdown);
      if (!editing) return m;
      return setCell(m, Number(editing.dataset.row), Number(editing.dataset.col), editing.innerText);
    };

    /**
     * 表格還在文件原本的位置。編輯儲存格時切換分頁或開新文件，離開儲存格的時候文件已經換掉了，
     * 這時不能再寫回去（位置對不上）。
     */
    const inPlace = (from: number) =>
      from >= 0 && view.state.sliceDoc(from, from + this.markdown.length) === this.markdown;

    const commit = (next: TableModel, focus: Cell | null) => {
      const md = serializeTable(next);
      const text = this.format(md) ?? md;
      const from = tableFrom();
      if (!inPlace(from)) return;
      if (text === this.markdown) {
        if (focus && at(focus)) start(at(focus)!);
        return;
      }
      pendingFocus = focus ? { from, ...focus } : null;
      view.dispatch({ changes: { from, to: from + this.markdown.length, insert: text }, userEvent: "input.table" });
    };

    const start = (cell: HTMLTableCellElement) => {
      if (editing === cell) return;
      if (editing) stop(false);
      editing = cell;
      current = { row: Number(cell.dataset.row), col: Number(cell.dataset.col) };
      cell.dataset.html = cell.innerHTML;
      cell.textContent = cellText(parseTable(this.markdown), current.row, current.col).replace(/<br\s*\/?>/gi, "\n");
      cell.contentEditable = "plaintext-only";
      cell.classList.add("cm-lp-cell-editing");
      wrap.classList.add("editing");
      cell.focus();
      const range = document.createRange();
      range.selectNodeContents(cell);
      range.collapse(false);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      view.requestMeasure();
    };

    /** 結束編輯；`save` 為 false 時還原。 */
    const stop = (save: boolean) => {
      const cell = editing;
      if (!cell) return;
      if (save) {
        commit(model(), null);
        return;
      }
      editing = null;
      cell.contentEditable = "false";
      cell.classList.remove("cm-lp-cell-editing");
      wrap.classList.remove("editing");
      cell.innerHTML = cell.dataset.html ?? "";
    };

    const move = (dRow: number, dCol: number, grow: boolean) => {
      const cols = cells[0].length;
      let { row, col } = current;
      col += dCol;
      if (col >= cols) {
        col = 0;
        row++;
      } else if (col < 0) {
        col = cols - 1;
        row--;
      }
      row += dRow;
      if (row < 0) return;
      let next = model();
      if (row >= cells.length) {
        if (!grow) return;
        next = insertRow(next, next.body.length);
      }
      moving = true;
      commit(next, { row, col });
      moving = false;
    };

    wrap.addEventListener("mousedown", (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLTableCellElement>("td, th");
      if (e.button !== 0 || !cell || !wrap.contains(cell) || cell === editing) return;
      e.preventDefault();
      start(cell);
    });
    wrap.addEventListener("keydown", (e) => {
      if (!editing || e.isComposing) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === "KeyA") {
        // 瀏覽器原生的全選會選到外層的整份文件，這裡只選這一格。
        e.preventDefault();
        const range = document.createRange();
        range.selectNodeContents(editing);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      } else if (e.key === "Tab") {
        e.preventDefault();
        move(0, e.shiftKey ? -1 : 1, !e.shiftKey);
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        move(1, 0, true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        leave();
      }
    });
    wrap.addEventListener("input", () => view.requestMeasure());
    // 儲存格裡的按鍵、輸入、貼上與滑鼠操作都屬於儲存格，不能讓編輯器收到（例如 Ctrl+A 會選取整份文件）。
    for (const type of [
      "keydown",
      "keypress",
      "keyup",
      "beforeinput",
      "input",
      "compositionstart",
      "compositionupdate",
      "compositionend",
      "paste",
      "copy",
      "cut",
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
      "selectstart",
      "dragstart",
      "drop",
    ]) {
      wrap.addEventListener(type, (e) => {
        if (editing && editing.contains(e.target as Node)) e.stopPropagation();
      });
    }
    wrap.addEventListener("focusout", (e) => {
      if (moving || !editing) return;
      // 焦點移到工具列以外的地方：存起來。
      if (e.relatedTarget instanceof Node && wrap.contains(e.relatedTarget)) return;
      stop(true);
    });

    /**
     * 存好正在編輯的儲存格並離開表格，編輯器拿回焦點：游標放到表格後面（表格維持排版顯示），
     * `source` 為 true 時放到表格開頭（顯示 Markdown 原始碼）。
     */
    const leave = (source = false) => {
      const from = tableFrom();
      const md = serializeTable(model());
      const text = editing ? (this.format(md) ?? md) : this.markdown;
      moving = true;
      stop(false);
      moving = false;
      if (!inPlace(from)) return;
      const changed = text !== this.markdown;
      const length = view.state.doc.length - this.markdown.length + text.length;
      view.dispatch({
        changes: changed ? { from, to: from + this.markdown.length, insert: text } : undefined,
        selection: { anchor: source ? from : Math.min(length, from + text.length + 1) },
        userEvent: changed ? "input.table" : undefined,
      });
      view.focus();
    };

    // ---- 工具列 ----
    const tools = document.createElement("div");
    tools.className = "cm-lp-table-tools";
    tools.setAttribute("role", "toolbar");
    tools.setAttribute("aria-label", "表格");
    const button = (label: string, title: string, run: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        moving = true;
        run();
        moving = false;
      });
      return b;
    };
    const align = (a: Align) => commit(setAlign(model(), current.col, a), editing ? current : null);
    tools.append(
      button("＋列", "在下方插入一列", () => {
        const row = Math.max(1, current.row + 1);
        commit(insertRow(model(), row - 1), { row, col: current.col });
      }),
      button("＋欄", "在右側插入一欄", () => commit(insertColumn(model(), current.col), { row: current.row, col: current.col + 1 })),
      button("－列", "刪除這一列", () => {
        if (current.row < 1) return;
        commit(deleteRow(model(), current.row), null);
      }),
      button("－欄", "刪除這一欄", () => commit(deleteColumn(model(), current.col), null)),
      button("⇤", "這一欄靠左", () => align("left")),
      button("⇔", "這一欄置中", () => align("center")),
      button("⇥", "這一欄靠右", () => align("right")),
      button("原始碼", "顯示表格的 Markdown 原始碼", () => leave(true)),
    );
    wrap.prepend(tools);

    // 修改後重畫：接著編輯原本要去的儲存格。
    requestAnimationFrame(() => {
      if (!pendingFocus || !wrap.isConnected) return;
      let from: number;
      try {
        from = view.posAtDOM(wrap);
      } catch {
        return;
      }
      if (from !== pendingFocus.from) return;
      const target = at(pendingFocus);
      pendingFocus = null;
      if (target) start(target);
    });
    return wrap;
  }
}
