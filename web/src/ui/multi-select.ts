/**
 * 可以複選的下拉選單（工作項目的類型、專案、區域篩選）：
 * 按鈕的樣子和一般的下拉選單一樣，打開是一排勾選框，上面有「全選」「全不選」，選項多時可以打字找。
 * 都不勾或全部勾都等於不限；選單關上時才套用，不會每勾一個就重新查一次。
 */

import { t } from "../i18n.ts";
import { choiceSummary, normalizeChoice } from "../multi-choice.ts";
import { placeMenu } from "./menu-place.ts";

export interface MultiSelectOptions {
  /** 給螢幕閱讀器與滑鼠提示的名稱（例如「類型」）。 */
  label: string;
  /** 不限時按鈕上的文字（例如「所有類型」）。 */
  all: string;
  /** 選單關上、選的值有變時呼叫（空的是不限）。 */
  onChange(values: string[]): void;
}

/** 選項多到這個數目時，上面多一個搜尋框。 */
const SEARCH_FROM = 9;

export class MultiSelect {
  readonly el: HTMLButtonElement;
  #pop: HTMLDivElement;
  #list: HTMLDivElement;
  #search: HTMLInputElement;
  #options: [string, string][] = [];
  #value: string[] = [];
  /** 選單打開時勾選的（還沒套用）。 */
  #draft = new Set<string>();
  #o: MultiSelectOptions;

  constructor(o: MultiSelectOptions) {
    this.#o = o;
    this.el = document.createElement("button");
    this.el.type = "button";
    this.el.className = "workitems-select multi-select";
    this.el.setAttribute("aria-haspopup", "true");
    this.el.setAttribute("aria-expanded", "false");

    this.#pop = document.createElement("div");
    this.#pop.className = "menu multi-select-pop";
    this.#pop.popover = "auto";
    this.#pop.setAttribute("aria-label", o.label);
    const tools = document.createElement("div");
    tools.className = "multi-select-tools";
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.textContent = t("全選");
    allBtn.addEventListener("click", () => this.#setAll(true));
    const noneBtn = document.createElement("button");
    noneBtn.type = "button";
    noneBtn.textContent = t("全不選");
    noneBtn.addEventListener("click", () => this.#setAll(false));
    tools.append(allBtn, noneBtn);
    this.#search = document.createElement("input");
    this.#search.type = "search";
    this.#search.className = "multi-select-search";
    this.#search.placeholder = t("搜尋…");
    this.#search.setAttribute("aria-label", t("搜尋{label}", { label: o.label }));
    this.#search.addEventListener("input", () => this.#filter());
    this.#list = document.createElement("div");
    this.#list.className = "multi-select-list";
    this.#list.role = "group";
    const hint = document.createElement("p");
    hint.className = "multi-select-hint";
    hint.textContent = t("都不勾就是不限");
    this.#pop.append(tools, this.#search, this.#list, hint);
    document.body.append(this.#pop);

    this.el.addEventListener("click", () => {
      if (this.#pop.matches(":popover-open")) this.#pop.hidePopover();
      else this.#open();
    });
    this.#pop.addEventListener("toggle", (e) => {
      const open = (e as ToggleEvent).newState === "open";
      this.el.setAttribute("aria-expanded", String(open));
      if (!open) this.#apply();
    });
    this.#pop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        this.#pop.hidePopover();
        this.el.focus();
      }
    });
    this.#render();
  }

  get value(): string[] {
    return [...this.#value];
  }

  set value(v: string[]) {
    this.#value = normalizeChoice(v, this.#options.map(([o]) => o));
    this.#render();
  }

  get hidden(): boolean {
    return this.el.hidden;
  }

  set hidden(v: boolean) {
    this.el.hidden = v;
    if (v && this.#pop.matches(":popover-open")) this.#pop.hidePopover();
  }

  /** 換選項（值、顯示的文字）；已經選的值留著，還沒讀到的選項也照樣顯示。 */
  setOptions(options: [string, string][]): void {
    this.#options = options;
    this.#render();
  }

  #labelOf = (v: string): string => this.#options.find(([o]) => o === v)?.[1] ?? v;

  #render(): void {
    const text = choiceSummary(this.#value, this.#labelOf, this.#o.all);
    this.el.textContent = text;
    this.el.title = this.#value.length ? `${this.#o.label}：${this.#value.map(this.#labelOf).join(", ")}` : this.#o.label; // i18n-ignore（名稱與冒號）
    this.el.setAttribute("aria-label", `${this.#o.label}：${text}`); // i18n-ignore（名稱與冒號）
    this.el.classList.toggle("chosen", this.#value.length > 0);
  }

  #open(): void {
    this.#draft = new Set(this.#value);
    // 還沒讀到的選項（例如上次選的區域）也列出來，才取消得掉。
    const extra = this.#value.filter((v) => !this.#options.some(([o]) => o === v)).map((v): [string, string] => [v, v]);
    this.#list.replaceChildren(
      ...[...this.#options, ...extra].map(([v, text]) => {
        const row = document.createElement("label");
        row.className = "multi-select-item";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.value = v;
        box.checked = this.#draft.has(v);
        box.addEventListener("change", () => {
          if (box.checked) this.#draft.add(v);
          else this.#draft.delete(v);
        });
        const name = document.createElement("span");
        name.textContent = text;
        row.title = text;
        row.append(box, name);
        return row;
      }),
    );
    this.#search.value = "";
    this.#search.hidden = this.#options.length < SEARCH_FROM;
    this.#pop.showPopover();
    this.#pop.style.minWidth = `${this.el.offsetWidth}px`;
    this.#pop.style.maxHeight = "";
    const { width, height } = this.#pop.getBoundingClientRect();
    const p = placeMenu(this.el.getBoundingClientRect(), { width, height }, { width: window.innerWidth, height: window.innerHeight });
    Object.assign(this.#pop.style, { left: `${p.left}px`, top: `${p.top}px`, right: "auto", bottom: "auto", maxHeight: `${p.maxHeight}px` });
    (this.#search.hidden ? this.#list.querySelector<HTMLInputElement>("input") : this.#search)?.focus();
  }

  /** 全選或全不選（有打字找時只動找到的那些）。 */
  #setAll(on: boolean): void {
    for (const box of this.#list.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) {
      if (box.closest<HTMLElement>(".multi-select-item")!.hidden) continue;
      box.checked = on;
      if (on) this.#draft.add(box.value);
      else this.#draft.delete(box.value);
    }
  }

  #filter(): void {
    const q = this.#search.value.trim().toLowerCase();
    for (const row of this.#list.querySelectorAll<HTMLElement>(".multi-select-item")) {
      row.hidden = !!q && !(row.textContent ?? "").toLowerCase().includes(q);
    }
  }

  #apply(): void {
    const next = normalizeChoice([...this.#draft], this.#options.map(([o]) => o));
    const same = next.length === this.#value.length && next.every((v) => this.#value.includes(v));
    if (same) return;
    this.#value = next;
    this.#render();
    this.#o.onChange(this.value);
  }
}
