/**
 * 可以複選的下拉選單（工作項目的類型、專案、區域篩選）：
 * 按鈕的樣子和一般的下拉選單一樣，打開是一排勾選框。第一列「全部」一次勾或取消全部（部分勾選時顯示半勾），
 * 滑鼠移到某一列時右邊有「只選這個」；選項多時可以打字找。
 * 不限時全部都是勾的；離開選單（點外面、按 Esc 或 Enter）時才套用，不會每勾一個就重新查一次。
 *
 * `single` 是單選（例如「人」）：同樣的按鈕與選單樣子，點一下就套用並關上。
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
  /** 單選：只能選一個，點了就套用。 */
  single?: boolean;
}

/** 選項多到這個數目時，上面多一個搜尋框。 */
const SEARCH_FROM = 9;

export class MultiSelect {
  readonly el: HTMLButtonElement;
  #pop: HTMLDivElement;
  #list: HTMLDivElement;
  #search: HTMLInputElement;
  #allRow: HTMLLabelElement;
  #allBox: HTMLInputElement;
  #allText: HTMLSpanElement;
  #status: HTMLSpanElement;
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
    this.#pop.className = "multi-select-pop";
    this.#pop.popover = "auto";
    this.#pop.setAttribute("aria-label", o.label);
    this.#search = document.createElement("input");
    this.#search.type = "search";
    this.#search.className = "multi-select-search";
    this.#search.placeholder = t("搜尋…");
    this.#search.setAttribute("aria-label", t("搜尋{label}", { label: o.label }));
    this.#search.addEventListener("input", () => this.#filter());
    // 「全部」：勾選或取消全部（有打字找時只動找到的那些）。
    this.#allRow = document.createElement("label");
    this.#allRow.className = "multi-select-item multi-select-all";
    this.#allBox = document.createElement("input");
    this.#allBox.type = "checkbox";
    this.#allBox.addEventListener("change", () => this.#setAll(this.#allBox.checked));
    this.#allText = document.createElement("span");
    this.#allRow.append(this.#allBox, this.#allText);
    this.#list = document.createElement("div");
    this.#list.className = "multi-select-list";
    this.#list.role = "group";
    const foot = document.createElement("div");
    foot.className = "multi-select-foot";
    this.#status = document.createElement("span");
    foot.append(this.#status);
    this.#pop.append(this.#search, this.#allRow, this.#list, foot);
    if (o.single) {
      this.#pop.classList.add("single");
      this.#allRow.hidden = true;
      foot.hidden = true;
    }
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
    this.#value = this.#o.single ? v.slice(0, 1) : normalizeChoice(v, this.#options.map(([o]) => o));
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
  }

  /** 全部的選項（還沒讀到的已選值也列出來，才取消得掉）。 */
  #all(): [string, string][] {
    const extra = this.#value.filter((v) => !this.#options.some(([o]) => o === v)).map((v): [string, string] => [v, v]);
    return [...this.#options, ...extra];
  }

  #open(): void {
    const all = this.#all();
    // 不限時全部都勾著（和「全部」的意思一樣）。
    this.#draft = new Set(this.#value.length ? this.#value : all.map(([v]) => v));
    this.#list.replaceChildren(
      ...all.map(([v, text]) => {
        const row = document.createElement("label");
        row.className = "multi-select-item";
        row.title = text;
        row.dataset.text = text.toLowerCase();
        const box = document.createElement("input");
        box.type = this.#o.single ? "radio" : "checkbox";
        box.name = this.#o.label;
        box.value = v;
        box.checked = this.#draft.has(v);
        const name = document.createElement("span");
        name.textContent = text;
        if (this.#o.single) {
          // 單選：點了就套用並關上（點已經選的那個也一樣關上）。
          row.addEventListener("click", (e) => {
            e.preventDefault();
            this.#pop.hidePopover();
            this.el.focus();
            if (this.#value[0] === v) return;
            this.#value = [v];
            this.#render();
            this.#o.onChange(this.value);
          });
          row.append(box, name);
          return row;
        }
        box.addEventListener("change", () => {
          if (box.checked) this.#draft.add(v);
          else this.#draft.delete(v);
          this.#sync();
        });
        const only = document.createElement("button");
        only.type = "button";
        only.className = "multi-select-only";
        only.textContent = t("只選這個");
        only.addEventListener("click", (e) => {
          e.preventDefault();
          this.#draft = new Set([v]);
          for (const b of this.#boxes()) b.checked = b.value === v;
          this.#sync();
        });
        row.append(box, name, only);
        return row;
      }),
    );
    this.#search.value = "";
    this.#search.hidden = all.length < SEARCH_FROM;
    this.#filter();
    this.#pop.showPopover();
    this.#pop.style.minWidth = `${Math.max(this.el.offsetWidth, 220)}px`;
    this.#pop.style.maxHeight = "";
    const { width, height } = this.#pop.getBoundingClientRect();
    const p = placeMenu(this.el.getBoundingClientRect(), { width, height }, { width: window.innerWidth, height: window.innerHeight });
    Object.assign(this.#pop.style, { left: `${p.left}px`, top: `${p.top}px`, right: "auto", bottom: "auto", maxHeight: `${p.maxHeight}px` });
    const first = this.#o.single ? this.#list.querySelector<HTMLInputElement>("input:checked") : this.#allBox;
    (this.#search.hidden ? first : this.#search)?.focus();
  }

  #boxes(): HTMLInputElement[] {
    return [...this.#list.querySelectorAll<HTMLInputElement>("input")];
  }

  /** 「全部」的勾選狀態（全勾、半勾、沒勾）與下面的「已選幾項」。 */
  #sync(): void {
    const shown = this.#boxes().filter((b) => !b.closest<HTMLElement>(".multi-select-item")!.hidden);
    const on = shown.filter((b) => b.checked).length;
    this.#allBox.checked = shown.length > 0 && on === shown.length;
    this.#allBox.indeterminate = on > 0 && on < shown.length;
    const total = this.#boxes().length;
    const picked = this.#draft.size;
    // 都沒勾時查不到東西也沒意義，當成全部。
    this.#status.textContent =
      picked === 0 ? t("都沒勾：等於全部") : picked >= total ? t("全部") : t("已選 {n}／{total} 項", { n: picked, total });
    this.#status.classList.toggle("warn", picked === 0);
  }

  /** 勾選或取消全部（有打字找時只動找到的那些）。 */
  #setAll(on: boolean): void {
    for (const box of this.#boxes()) {
      if (box.closest<HTMLElement>(".multi-select-item")!.hidden) continue;
      box.checked = on;
      if (on) this.#draft.add(box.value);
      else this.#draft.delete(box.value);
    }
    this.#sync();
  }

  #filter(): void {
    const q = this.#search.value.trim().toLowerCase();
    let shown = 0;
    for (const row of this.#list.querySelectorAll<HTMLElement>(".multi-select-item")) {
      row.hidden = !!q && !(row.dataset.text ?? "").includes(q);
      if (!row.hidden) shown++;
    }
    this.#allText.textContent = q ? t("全部符合的（{n}）", { n: shown }) : t("全部（{n}）", { n: shown });
    this.#sync();
  }

  #apply(): void {
    if (this.#o.single) return;
    const next = normalizeChoice([...this.#draft], this.#options.map(([o]) => o));
    const same = next.length === this.#value.length && next.every((v) => this.#value.includes(v));
    if (same) return;
    this.#value = next;
    this.#render();
    this.#o.onChange(this.value);
  }
}
