/**
 * 可以複選的下拉選單（工作項目的類型、專案、區域篩選）：
 * 按鈕的樣子和一般的下拉選單一樣，打開是一排勾選框。第一列「全部」一次勾或取消全部（部分勾選時顯示半勾），
 * 滑鼠移到某一列時右邊有「只選這個」；選項多時可以打字找。
 * 不限時全部都是勾的；離開選單（點外面、按 Esc 或 Enter）時才套用，不會每勾一個就重新查一次。
 * 不會出現「一個都沒勾」：那和全部勾的意思一樣，畫面卻完全相反，容易以為出錯。全部勾著時再按「全部」維持全部，
 * 取消最後一個勾的也不行，下面提示要只看某一項時按「只選這個」。
 *
 * `single` 是單選（例如「人」）：同樣的按鈕與選單樣子，點一下就套用並關上。
 * Wiki 的「顯示哪些最上層頁面」也用這個選單：自己的圖示按鈕（`button`）、勾了馬上套用（`live`）。
 */

import { wasOpenOnPress } from "./popover-toggle.ts";
import { t } from "../i18n.ts";
import { choiceSummary, normalizeChoice } from "../multi-choice.ts";
import { containWheel } from "./contain-wheel.ts";
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
  /** 用這個按鈕打開選單（按鈕上的文字與提示由呼叫的人自己管）；沒給時建立一個下拉選單樣子的按鈕。 */
  button?: HTMLButtonElement;
  /** 每勾一個就馬上套用（例如 Wiki 的樹狀目錄），不用等選單關上。 */
  live?: boolean;
  /** 選單最上面的一行說明（例如「顯示哪些最上層頁面」）。 */
  caption?: string;
  /**
   * 選單裡選項的樣子另外決定（例如 Sprint：名稱旁邊標「本週」、日期靠右、分組）；回傳 null 的照一般的寫法。
   * 按鈕上照樣用選項的文字；這種選項不顯示滑鼠提示（內容都看得到了）。
   */
  rich?: (value: string) => RichItem | null;
  /** 這一組平常只列前 `keep` 個（勾著的一定列出），下面「顯示更早的 N 個」展開；打字找時全部都找。 */
  fold?: { group: string; keep: number };
  /** 按鈕上的文字另外決定（例如狀態勾了所有還沒結束的，寫「進行中」）；回傳 null 時照一般的寫法。 */
  summary?(values: string[]): string | null;
}

/** 選單裡一個選項的樣子（見 {@link MultiSelectOptions.rich}）。 */
export interface RichItem {
  name: string;
  /** 名稱後面的小字（例如「本週」「下一個」）。 */
  note?: string;
  /** 目前的那一個（例如本週的 Sprint）：底色標出，名稱粗體。 */
  current?: boolean;
  /** 靠右的小字（例如日期）。 */
  aside?: string;
  /** 分組的名稱：和上一個選項不同時，上面加一行組名。 */
  group?: string;
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
  #caption: HTMLDivElement;
  #options: [string, string][] = [];
  #value: string[] = [];
  /** 選單打開時勾選的（還沒套用）。 */
  #draft = new Set<string>();
  #o: MultiSelectOptions;

  /** 換選單最上面的說明（空字串不顯示）。 */
  setCaption(text: string): void {
    this.#caption.textContent = text;
    this.#caption.hidden = !text;
  }

  constructor(o: MultiSelectOptions) {
    this.#o = o;
    this.el = o.button ?? document.createElement("button");
    this.el.type = "button";
    if (!o.button) this.el.className = "workitems-select multi-select";
    this.el.setAttribute("aria-haspopup", "true");
    this.el.setAttribute("aria-expanded", "false");

    this.#pop = document.createElement("div");
    this.#pop.className = "multi-select-pop";
    this.#pop.popover = "auto";
    this.#pop.setAttribute("aria-label", o.label);
    containWheel(this.#pop);
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
    this.#caption = document.createElement("div");
    this.#caption.className = "multi-select-caption";
    this.setCaption(o.caption ?? "");
    this.#pop.append(this.#caption);
    this.#pop.append(this.#search, this.#allRow, this.#list, foot);
    if (o.single) {
      this.#pop.classList.add("single");
      this.#allRow.hidden = true;
      foot.hidden = true;
    }
    document.body.append(this.#pop);

    // 再按一次按鈕要關上（見 popover-toggle.ts）。
    const wasOpen = wasOpenOnPress(this.el, () => this.#pop);
    this.el.addEventListener("click", () => {
      if (wasOpen()) {
        if (this.#pop.matches(":popover-open")) this.#pop.hidePopover();
      } else this.#open();
    });
    // 用 beforetoggle：收起的當下就套用選的條件（toggle 事件排在後面才觸發，按 Esc 之後畫面會慢一拍）。
    this.#pop.addEventListener("beforetoggle", (e) => {
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
    if (this.#o.button) return;
    const text = this.#o.summary?.(this.value) ?? choiceSummary(this.#value, this.#labelOf, this.#o.all);
    this.el.textContent = text;
    this.el.title = this.#value.length ? `${this.#o.label}：${this.#value.map(this.#labelOf).join(", ")}` : this.#o.summary ? `${this.#o.label}：${text}` : this.#o.label; // i18n-ignore（名稱與冒號）
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
        const rich = this.#o.rich?.(v) ?? null;
        if (!rich) row.title = text;
        row.dataset.text = text.toLowerCase();
        const box = document.createElement("input");
        box.type = this.#o.single ? "radio" : "checkbox";
        box.name = this.#o.label;
        box.value = v;
        box.checked = this.#draft.has(v);
        const name = document.createElement("span");
        name.textContent = text;
        const aside = document.createElement("span");
        if (rich) {
          row.classList.add("rich");
          row.classList.toggle("current", !!rich.current);
          row.dataset.group = rich.group ?? "";
          name.className = "multi-select-name";
          name.textContent = rich.name;
          if (rich.note) {
            const note = document.createElement("small");
            note.className = "multi-select-note";
            note.textContent = rich.note;
            name.append(note);
          }
          aside.className = "multi-select-aside";
          aside.textContent = rich.aside ?? "";
        }
        const parts = [name];
        const tail = rich?.aside ? [aside] : [];
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
          row.append(box, ...parts, ...tail);
          return row;
        }
        box.addEventListener("change", () => {
          if (box.checked) this.#draft.add(v);
          else if (this.#draft.size <= 1) {
            // 最後一個勾的：不能取消（一個都不勾等於全部，反而看不出來）。
            box.checked = true;
            this.#sync(t("至少要勾一項；要看全部請勾「全部」"));
            return;
          } else this.#draft.delete(v);
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
        row.append(box, ...parts, only, ...tail);
        return row;
      }),
    );
    if (this.#o.rich) this.#decorate();
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

  /** 分組的組名、收起來的選項與「顯示更早的 N 個」、分組之後沒有分組的選項上面的分隔線。 */
  #decorate(): void {
    const rows = [...this.#list.querySelectorAll<HTMLElement>(".multi-select-item")];
    const fold = this.#o.fold;
    let prev: string | undefined;
    let inFold = 0;
    const folded: HTMLElement[] = [];
    const count = (g: string) => rows.filter((r) => r.dataset.group === g).length;
    for (const row of rows) {
      const g = row.dataset.group;
      if (g && g !== prev) {
        const head = document.createElement("div");
        head.className = "multi-select-group";
        head.textContent = g;
        if (fold?.group === g) {
          const n = document.createElement("span");
          n.textContent = String(count(g));
          head.append(n);
        }
        row.before(head);
      } else if (!g && prev) row.classList.add("multi-select-sep");
      if (fold && g === fold.group) {
        inFold++;
        const box = row.querySelector<HTMLInputElement>("input")!;
        if (inFold > fold.keep && !box.checked) {
          row.classList.add("folded");
          folded.push(row);
        }
      }
      prev = g || undefined;
    }
    if (!folded.length) return;
    const more = document.createElement("button");
    more.type = "button";
    more.className = "multi-select-more";
    more.textContent = t("顯示更早的 {n} 個", { n: folded.length });
    more.addEventListener("click", (e) => {
      e.preventDefault();
      for (const r of folded) r.classList.remove("folded");
      more.remove();
      this.#search.focus();
    });
    const last = rows.filter((r) => r.dataset.group === fold!.group).at(-1)!;
    last.after(more);
  }

  #boxes(): HTMLInputElement[] {
    return [...this.#list.querySelectorAll<HTMLInputElement>("input")];
  }

  /** 「全部」的勾選狀態（全勾、半勾）與下面的「已選幾項」；`hint` 是剛剛的操作沒有作用時的說明。 */
  #sync(hint?: string): void {
    const shown = this.#boxes().filter((b) => !b.closest<HTMLElement>(".multi-select-item")!.hidden);
    const on = shown.filter((b) => b.checked).length;
    this.#allBox.checked = shown.length > 0 && on === shown.length;
    this.#allBox.indeterminate = on > 0 && on < shown.length;
    const total = this.#boxes().length;
    const picked = this.#draft.size;
    this.#status.textContent = hint ?? (picked >= total ? t("全部") : t("已選 {n}／{total} 項", { n: picked, total }));
    this.#status.classList.toggle("hint", !!hint);
    if (this.#o.live && this.#pop.matches(":popover-open")) this.#apply();
  }

  /** 勾選或取消全部（有打字找時只動找到的那些）；取消後會一個都不勾時不取消。 */
  #setAll(on: boolean): void {
    if (!on) {
      const shown = new Set(this.#boxes().filter((b) => !b.closest<HTMLElement>(".multi-select-item")!.hidden).map((b) => b.value));
      if (![...this.#draft].some((v) => !shown.has(v))) {
        this.#allBox.checked = true;
        this.#sync(t("已經是全部；要只看某一項，按那一項右邊的「只選這個」"));
        return;
      }
    }
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
    // 沒有打字找時就是「全部」（數字是選項的個數，不是工作項目的個數，寫出來反而容易誤會）。
    this.#allText.textContent = q ? t("全部符合的（{n}）", { n: shown }) : t("全部");
    // 打字找時收起來的也一起找，組名與「顯示更早」先藏起來。
    this.#list.classList.toggle("searching", !!q);
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
