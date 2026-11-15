/**
 * 尋找列開著時，在編輯區右邊的捲軸上用短線標出每個符合處的位置（和 VS Code 一樣）：一眼看出符合處
 * 分布在文件的哪裡、還有多遠；目前選到的那一個用強調色。線畫在疊在捲軸上的一層，位置照符合處在
 * 整份文件高度裡的比例換算。點一條短線就跳到那個符合處；這一層的其他地方不擋滑鼠，捲軸照常可以拖。
 */
import { getSearchQuery, searchPanelOpen, setSearchQuery } from "@codemirror/search";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/** 最多標幾個（再多也擠在一起看不出來）。 */
const LIMIT = 2000;

export interface Mark {
  /** 在軌道裡的位置（像素，已取整）。 */
  y: number;
  current: boolean;
  /** 這一條代表的第一個符合處是第幾個（從 0 開始）；點這一條就跳到它。 */
  index: number;
}

/**
 * 把符合處在文件裡的高度（`tops`，和 `contentHeight` 同單位）換成捲軸軌道上的位置。
 * 落在同一個像素的合併成一條；其中有目前選到的那一個時，整條算目前的。
 */
export function layoutMarks(tops: number[], current: number, contentHeight: number, track: number): Mark[] {
  if (contentHeight <= 0 || track <= 0) return [];
  const byY = new Map<number, Mark>();
  tops.forEach((top, i) => {
    const y = Math.min(track - 1, Math.max(0, Math.round((top / contentHeight) * track)));
    const mark = byY.get(y);
    if (mark) mark.current ||= i === current;
    else byY.set(y, { y, current: i === current, index: i });
  });
  return [...byY.values()].sort((a, b) => a.y - b.y);
}

interface Measured {
  top: number;
  height: number;
  width: number;
  marks: Mark[];
  ranges: { from: number; to: number }[];
}

class FindMarks {
  #view: EditorView;
  #el: HTMLElement;
  #key = "";

  constructor(view: EditorView) {
    this.#view = view;
    this.#el = document.createElement("div");
    this.#el.className = "find-marks";
    this.#el.setAttribute("aria-hidden", "true");
    this.#el.hidden = true;
    view.dom.append(this.#el);
    this.#schedule();
  }

  update(u: ViewUpdate): void {
    const queryChanged = u.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchQuery)));
    const toggled = searchPanelOpen(u.state) !== searchPanelOpen(u.startState);
    if (u.docChanged || u.selectionSet || u.geometryChanged || u.heightChanged || queryChanged || toggled) this.#schedule();
  }

  #schedule(): void {
    this.#view.requestMeasure({
      key: this,
      read: (view) => this.#measure(view),
      write: (m) => this.#draw(m),
    });
  }

  #measure(view: EditorView): Measured | null {
    const state = view.state;
    const query = getSearchQuery(state);
    if (!searchPanelOpen(state) || !query.search || !query.valid) return null;
    const scroller = view.scrollDOM;
    // 內容沒有超過一頁（沒有捲軸）就不用標。
    if (scroller.scrollHeight <= scroller.clientHeight + 1) return null;
    const tops: number[] = [];
    const ranges: { from: number; to: number }[] = [];
    let current = -1;
    const { from, to } = state.selection.main;
    const cursor = query.getCursor(state);
    for (let next = cursor.next(); !next.done && tops.length < LIMIT; next = cursor.next()) {
      if (next.value.from === from && next.value.to === to) current = tops.length;
      tops.push(view.lineBlockAt(next.value.from).top);
      ranges.push({ from: next.value.from, to: next.value.to });
    }
    if (!tops.length) return null;
    // 佔位置的捲軸（Windows）兩頭各有一個和捲軸一樣寬的箭頭按鈕，軌道在中間；浮在內容上的捲軸沒有按鈕。
    const bar = scroller.offsetWidth - scroller.clientWidth;
    const track = scroller.clientHeight - bar * 2;
    const box = scroller.getBoundingClientRect();
    const host = view.dom.getBoundingClientRect();
    return {
      top: box.top - host.top + bar,
      height: track,
      width: Math.max(bar, 10),
      marks: layoutMarks(tops, current, view.contentHeight, track),
      ranges,
    };
  }

  #draw(m: Measured | null): void {
    if (!m) {
      this.#el.hidden = true;
      this.#key = "";
      return;
    }
    const key = `${m.top}|${m.height}|${m.width}|${m.marks.map((k) => (k.current ? `c${k.y}` : k.y)).join(",")}`;
    this.#el.hidden = false;
    if (key === this.#key) return;
    this.#key = key;
    Object.assign(this.#el.style, { top: `${m.top}px`, height: `${m.height}px`, width: `${m.width}px` });
    drawMarks(this.#el, m.marks, (i) => {
      const r = m.ranges[i];
      if (!r) return;
      // 和按「下一個」一樣：選取那個符合處、捲到看得到的地方；焦點留在原來的地方（尋找框）。
      this.#view.dispatch({
        selection: { anchor: r.from, head: r.to },
        effects: EditorView.scrollIntoView(r.from, { y: "center" }),
        userEvent: "select.search",
      });
    });
  }

  destroy(): void {
    this.#el.remove();
  }
}

/** 畫出短線：`pick` 是點了某一條之後要做的事（跳到第幾個符合處）。和預覽的尋找列（app/preview-find.ts）共用。 */
export function drawMarks(el: HTMLElement, marks: Mark[], pick: (index: number) => void): void {
  el.replaceChildren(
    ...marks.map((k) => {
      const line = document.createElement("i");
      if (k.current) line.className = "current";
      line.style.top = `${k.y}px`;
      // 按下就跳（不等放開），也不讓捲軸把這一下當成「往這裡翻一頁」。
      line.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        pick(k.index);
      });
      return line;
    }),
  );
}

/** 尋找列開著時在捲軸上標出符合處。 */
export const findMarks = ViewPlugin.fromClass(FindMarks);
