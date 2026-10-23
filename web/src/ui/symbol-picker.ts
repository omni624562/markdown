/**
 * 符號面板：依分類瀏覽、用中文或英文搜尋，記得最近用過的符號。
 * 點一下插入並關閉；按住 Ctrl（或 Shift）點可以連續插入好幾個。
 */
import { t } from "../i18n.ts";
import * as storage from "../storage.ts";
import { SYMBOL_CATEGORIES, type SymbolEntry, searchSymbols, symbolName } from "../symbols.ts";

const RECENT_KEY = "recent-symbols";
const RECENT_LIMIT = 16;
const COLUMNS = 10;

export class SymbolPicker {
  #dialog: HTMLDialogElement;
  #input: HTMLInputElement;
  #tabs: HTMLElement;
  #grid: HTMLElement;
  #hint: HTMLElement;
  #category = "recent";
  #insert: (text: string) => void;

  constructor(insert: (text: string) => void) {
    this.#insert = insert;
    this.#dialog = document.createElement("dialog");
    this.#dialog.className = "symbol-picker";
    this.#dialog.setAttribute("aria-label", t("插入符號"));
    const tr = {
      placeholder: t("搜尋符號，例如「小於等於」「箭頭」「攝氏」"),
      search: t("搜尋符號"),
      categories: t("符號分類"),
      symbols: t("符號"),
    };
    this.#dialog.innerHTML = `
      <input type="search" placeholder="${tr.placeholder}" aria-label="${tr.search}" spellcheck="false" autocomplete="off" />
      <div class="symbol-tabs" role="tablist" aria-label="${tr.categories}"></div>
      <div class="symbol-grid" role="listbox" aria-label="${tr.symbols}"></div>
      <p class="symbol-hint"></p>`;
    document.body.append(this.#dialog);
    this.#input = this.#dialog.querySelector("input")!;
    this.#tabs = this.#dialog.querySelector(".symbol-tabs")!;
    this.#grid = this.#dialog.querySelector(".symbol-grid")!;
    this.#hint = this.#dialog.querySelector(".symbol-hint")!;

    this.#input.addEventListener("input", () => this.#render());
    this.#input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "ArrowDown" || (e.key === "Enter" && this.#cells().length)) {
        e.preventDefault();
        if (e.key === "Enter") this.#pick(this.#cells()[0].dataset.char!, e.ctrlKey || e.shiftKey);
        else this.#cells()[0]?.focus();
      }
    });
    this.#grid.addEventListener("keydown", (e) => this.#onGridKey(e));
    this.#grid.addEventListener("click", (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-char]");
      if (cell) this.#pick(cell.dataset.char!, e.ctrlKey || e.metaKey || e.shiftKey);
    });
    const describe = (e: Event) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-char]");
      if (cell) this.#hint.textContent = `${cell.dataset.char}\u3000${symbolName(cell.dataset.char!)}`;
    };
    this.#grid.addEventListener("focusin", describe);
    this.#grid.addEventListener("mouseover", describe);
    this.#dialog.addEventListener("click", (e) => {
      if (e.target === this.#dialog) this.#dialog.close();
    });
  }

  open(): void {
    this.#input.value = "";
    this.#category = this.#recent().length ? "recent" : SYMBOL_CATEGORIES[0].id;
    this.#render();
    this.#dialog.showModal();
    this.#input.focus();
  }

  #recent(): string[] {
    try {
      const list = JSON.parse(storage.load(RECENT_KEY) ?? "[]");
      return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  #pick(char: string, keepOpen: boolean): void {
    storage.save(RECENT_KEY, JSON.stringify([char, ...this.#recent().filter((c) => c !== char)].slice(0, RECENT_LIMIT)));
    if (!keepOpen) this.#dialog.close();
    this.#insert(char);
    if (keepOpen) this.#hint.textContent = t("已插入 {char}（按住 Ctrl 點可以繼續插入）", { char });
  }

  #cells(): HTMLElement[] {
    return [...this.#grid.querySelectorAll<HTMLElement>("[data-char]")];
  }

  #render(): void {
    const query = this.#input.value.trim();
    const tabs = [
      ...(this.#recent().length ? [{ id: "recent", label: t("最近使用") }] : []),
      ...SYMBOL_CATEGORIES.map((c) => ({ id: c.id, label: c.label })),
    ];
    this.#tabs.hidden = !!query;
    this.#tabs.replaceChildren(
      ...tabs.map((t) => {
        const b = document.createElement("button");
        b.type = "button";
        b.role = "tab";
        b.textContent = t.label;
        b.setAttribute("aria-selected", String(t.id === this.#category));
        b.addEventListener("click", () => {
          this.#category = t.id;
          this.#render();
        });
        return b;
      }),
    );
    let entries: { char: string; name: string }[];
    if (query) entries = searchSymbols(query);
    else if (this.#category === "recent") entries = this.#recent().map((char) => ({ char, name: symbolName(char) }));
    else entries = SYMBOL_CATEGORIES.find((c) => c.id === this.#category)?.symbols ?? [];
    this.#grid.replaceChildren(...entries.map((s) => this.#cell(s)));
    this.#hint.textContent = entries.length
      ? t("點一下插入；按住 Ctrl 點可以連續插入好幾個")
      : query
        ? t("找不到「{name}」", { name: query })
        : "";
  }

  #cell(s: Pick<SymbolEntry, "char" | "name">): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.role = "option";
    b.dataset.char = s.char;
    b.textContent = s.char;
    b.title = `${s.char} ${s.name}`;
    b.setAttribute("aria-label", s.name);
    b.tabIndex = -1;
    if ([...s.char].length > 1) b.classList.add("wide");
    return b;
  }

  #onGridKey(e: KeyboardEvent): void {
    const cells = this.#cells();
    const i = cells.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const move: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS };
    if (e.key in move) {
      e.preventDefault();
      const next = i + move[e.key];
      if (next < 0 && e.key === "ArrowUp") this.#input.focus();
      else cells[Math.min(Math.max(next, 0), cells.length - 1)]?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.#pick(cells[i].dataset.char!, e.ctrlKey || e.shiftKey);
    }
  }
}
