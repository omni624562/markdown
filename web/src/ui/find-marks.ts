/**
 * 尋找列開著時，在編輯區右邊的捲軸上用短線標出每個符合處的位置（和 VS Code 一樣）：一眼看出符合處
 * 分布在文件的哪裡、還有多遠；目前選到的那一個用強調色。線畫在疊在捲軸上的一層（不擋滑鼠），
 * 位置照符合處在整份文件高度裡的比例換算。
 */
import { getSearchQuery, searchPanelOpen, setSearchQuery } from "@codemirror/search";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/** 最多標幾個（再多也擠在一起看不出來）。 */
const LIMIT = 2000;

export interface Mark {
  /** 在軌道裡的位置（像素，已取整）。 */
  y: number;
  current: boolean;
}

/**
 * 把符合處在文件裡的高度（`tops`，和 `contentHeight` 同單位）換成捲軸軌道上的位置。
 * 落在同一個像素的合併成一條；其中有目前選到的那一個時，整條算目前的。
 */
export function layoutMarks(tops: number[], current: number, contentHeight: number, track: number): Mark[] {
  if (contentHeight <= 0 || track <= 0) return [];
  const byY = new Map<number, boolean>();
  tops.forEach((top, i) => {
    const y = Math.min(track - 1, Math.max(0, Math.round((top / contentHeight) * track)));
    byY.set(y, (byY.get(y) ?? false) || i === current);
  });
  return [...byY].map(([y, cur]) => ({ y, current: cur })).sort((a, b) => a.y - b.y);
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

  #measure(view: EditorView): { top: number; height: number; width: number; marks: Mark[] } | null {
    const state = view.state;
    const query = getSearchQuery(state);
    if (!searchPanelOpen(state) || !query.search || !query.valid) return null;
    const scroller = view.scrollDOM;
    // 內容沒有超過一頁（沒有捲軸）就不用標。
    if (scroller.scrollHeight <= scroller.clientHeight + 1) return null;
    const tops: number[] = [];
    let current = -1;
    const { from, to } = state.selection.main;
    const cursor = query.getCursor(state);
    for (let next = cursor.next(); !next.done && tops.length < LIMIT; next = cursor.next()) {
      if (next.value.from === from && next.value.to === to) current = tops.length;
      tops.push(view.lineBlockAt(next.value.from).top);
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
    };
  }

  #draw(m: { top: number; height: number; width: number; marks: Mark[] } | null): void {
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
    this.#el.replaceChildren(
      ...m.marks.map((k) => {
        const line = document.createElement("i");
        if (k.current) line.className = "current";
        line.style.top = `${k.y}px`;
        return line;
      }),
    );
  }

  destroy(): void {
    this.#el.remove();
  }
}

/** 尋找列開著時在捲軸上標出符合處。 */
export const findMarks = ViewPlugin.fromClass(FindMarks);
