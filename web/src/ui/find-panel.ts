/**
 * 編輯器的「尋找與取代」列（取代 CodeMirror 內建的版面）：選項與按鈕改成圖示，
 * 說明與快速鍵放在滑鼠提示；顯示「第幾個／共幾個」。
 *
 * 搜尋框內：Enter 下一個、Shift+Enter 上一個、Alt+Enter 選取全部；
 * 取代框內：Enter 取代、Ctrl+Alt+Enter 全部取代；Alt+C／W／R 切換大小寫、全字、正規表示式。
 */
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import type { EditorState } from "@codemirror/state";
import { type EditorView, type Panel, runScopeHandlers, type ViewUpdate } from "@codemirror/view";
import { formatKeys } from "../commands.ts";
import { icon } from "./icons.ts";

/** 最多算到幾個符合項目（再多就顯示「1000+」）。 */
const COUNT_LIMIT = 1000;

export interface MatchCount {
  /** 目前選取範圍是第幾個符合項目（從 1 開始）；不在任何一個上面時是 0。 */
  current: number;
  total: number;
  /** 超過上限，沒有算完。 */
  more: boolean;
}

/** 算出符合項目的數量，以及目前的選取範圍是第幾個。 */
export function countMatches(state: EditorState, query: SearchQuery, limit = COUNT_LIMIT): MatchCount {
  const result: MatchCount = { current: 0, total: 0, more: false };
  if (!query.search || !query.valid) return result;
  const { from, to } = state.selection.main;
  const cursor = query.getCursor(state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    if (result.total >= limit) {
      result.more = true;
      break;
    }
    result.total++;
    if (next.value.from === from && next.value.to === to) result.current = result.total;
  }
  return result;
}

/** 「3／12」「12 個結果」「沒有結果」。 */
export function countLabel(c: MatchCount, valid = true): string {
  if (!valid) return "格式錯誤";
  if (!c.total) return "沒有結果";
  const total = c.more ? `${c.total}+` : String(c.total);
  return c.current ? `${c.current}／${total}` : `${total} 個結果`;
}

type Option = "caseSensitive" | "wholeWord" | "regexp";

const OPTIONS: { key: Option; icon: string; label: string; code: string }[] = [
  { key: "caseSensitive", icon: "case-sensitive", label: "大小寫須相符", code: "KeyC" },
  { key: "wholeWord", icon: "whole-word", label: "全字拼寫須相符", code: "KeyW" },
  { key: "regexp", icon: "regex", label: "使用正規表示式", code: "KeyR" },
];

function tip(label: string, keys?: string): string {
  return keys ? `${label}（${formatKeys(keys)}）` : label;
}

function iconButton(name: string, iconName: string, label: string, keys: string | undefined, run: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.name = name;
  b.className = "find-btn";
  b.title = tip(label, keys);
  b.setAttribute("aria-label", label);
  b.append(icon(iconName));
  // 按鈕不搶走焦點，搜尋框裡的游標位置保持不動。
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", run);
  return b;
}

class FindPanel implements Panel {
  dom: HTMLElement;
  #view: EditorView;
  #query: SearchQuery;
  #search: HTMLInputElement;
  #replace: HTMLInputElement;
  #toggles = new Map<Option, HTMLButtonElement>();
  #count: HTMLElement;
  #frame = 0;

  constructor(view: EditorView) {
    this.#view = view;
    this.#query = getSearchQuery(view.state);
    const commit = () => this.#commit();

    this.#search = this.#input("search", "尋找", commit);
    this.#search.setAttribute("main-field", "true");
    this.#replace = this.#input("replace", "取代", commit);

    const findBox = document.createElement("div");
    findBox.className = "find-box";
    findBox.append(this.#search);
    for (const opt of OPTIONS) {
      const b = iconButton(opt.key, opt.icon, opt.label, `Alt-${opt.code.slice(3).toLowerCase()}`, () => this.#toggle(opt.key));
      b.classList.add("find-toggle");
      this.#toggles.set(opt.key, b);
      findBox.append(b);
    }

    this.#count = document.createElement("span");
    this.#count.className = "find-count";
    this.#count.setAttribute("aria-live", "polite");

    const findRow = document.createElement("div");
    findRow.className = "find-row";
    findRow.append(
      findBox,
      this.#count,
      iconButton("prev", "arrow-up", "上一個", "Shift-Enter", () => findPrevious(view)),
      iconButton("next", "arrow-down", "下一個", "Enter", () => findNext(view)),
      iconButton("select", "text-cursor-input", "選取所有符合項目", "Alt-Enter", () => selectMatches(view)),
      iconButton("close", "x", "關閉", "Esc", () => closeSearchPanel(view)),
    );
    this.dom = document.createElement("div");
    this.dom.className = "cm-search find-panel";
    this.dom.append(findRow);

    if (!view.state.readOnly) {
      const replaceBox = document.createElement("div");
      replaceBox.className = "find-box";
      replaceBox.append(this.#replace);
      const replaceRow = document.createElement("div");
      replaceRow.className = "find-row";
      replaceRow.append(
        replaceBox,
        iconButton("replace", "replace", "取代", "Enter", () => replaceNext(view)),
        iconButton("replaceAll", "replace-all", "全部取代", "Mod-Alt-Enter", () => replaceAll(view)),
      );
      this.dom.append(replaceRow);
    }
    this.dom.addEventListener("keydown", (e) => this.#keydown(e));
    this.#sync();
  }

  #input(name: string, label: string, commit: () => void): HTMLInputElement {
    const input = document.createElement("input");
    input.className = "cm-textfield";
    input.name = name;
    input.placeholder = label;
    input.setAttribute("aria-label", label);
    input.spellcheck = false;
    input.autocomplete = "off";
    input.addEventListener("input", commit);
    input.addEventListener("change", commit);
    return input;
  }

  #commit(): void {
    const query = new SearchQuery({
      search: this.#search.value,
      replace: this.#replace.value,
      caseSensitive: this.#pressed("caseSensitive"),
      wholeWord: this.#pressed("wholeWord"),
      regexp: this.#pressed("regexp"),
    });
    if (query.eq(this.#query)) return;
    this.#query = query;
    this.#view.dispatch({ effects: setSearchQuery.of(query) });
  }

  #pressed(key: Option): boolean {
    return this.#toggles.get(key)!.getAttribute("aria-pressed") === "true";
  }

  #toggle(key: Option): void {
    const b = this.#toggles.get(key)!;
    b.setAttribute("aria-pressed", String(!this.#pressed(key)));
    this.#commit();
  }

  #keydown(e: KeyboardEvent): void {
    if (e.isComposing || e.keyCode === 229) return; // 注音選字中不要攔截按鍵
    if (runScopeHandlers(this.#view, e, "search-panel")) {
      e.preventDefault();
      return;
    }
    const opt = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey ? OPTIONS.find((o) => o.code === e.code) : undefined;
    if (opt) {
      e.preventDefault();
      this.#toggle(opt.key);
      return;
    }
    if (e.key !== "Enter") return;
    if (e.target === this.#search) {
      e.preventDefault();
      if (e.altKey) selectMatches(this.#view);
      else (e.shiftKey ? findPrevious : findNext)(this.#view);
    } else if (e.target === this.#replace) {
      e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && e.altKey) replaceAll(this.#view);
      else replaceNext(this.#view);
    }
  }

  /** 把目前的搜尋條件寫回輸入框與切換鈕（例如從選取的文字開啟搜尋列）。 */
  #sync(): void {
    const q = this.#query;
    if (this.#search.value !== q.search) this.#search.value = q.search;
    if (this.#replace.value !== q.replace) this.#replace.value = q.replace;
    for (const opt of OPTIONS) this.#toggles.get(opt.key)!.setAttribute("aria-pressed", String(q[opt.key]));
    this.#recount();
  }

  #recount(): void {
    cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => {
      const q = this.#query;
      const label = q.search ? countLabel(countMatches(this.#view.state, q), q.valid) : "";
      this.#count.textContent = label;
      this.#count.classList.toggle("find-none", label === "沒有結果" || label === "格式錯誤");
      this.#search.classList.toggle("find-invalid", !!q.search && !q.valid);
    });
  }

  update(u: ViewUpdate): void {
    let changed = u.docChanged || u.selectionSet;
    for (const tr of u.transactions) {
      for (const effect of tr.effects) {
        if (!effect.is(setSearchQuery)) continue;
        changed = true;
        // 從別的地方改了搜尋條件（例如選取文字後按 Ctrl+F）：更新輸入框。
        if (!effect.value.eq(this.#query)) {
          this.#query = effect.value;
          this.#sync();
        }
      }
    }
    if (changed) this.#recount();
  }

  mount(): void {
    this.#search.select();
  }

  destroy(): void {
    cancelAnimationFrame(this.#frame);
  }
}

export function createFindPanel(view: EditorView): Panel {
  return new FindPanel(view);
}
