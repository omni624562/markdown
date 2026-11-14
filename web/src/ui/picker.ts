import { t } from "../i18n.ts";
import { icon } from "./icons.ts";

export interface PickerItem {
  title: string;
  /** 次要說明（例如所在資料夾、指令分類）。 */
  detail?: string;
  icon?: string;
  /** 右側顯示的快速鍵。 */
  keys?: string;
  /** 分區標題：和上一個項目不同時，在前面顯示標題。 */
  section?: string;
  /** 名稱前面的顏色圓點（專案的顏色）。 */
  color?: string | null;
  /** 名稱後面的小標籤（例如 COMET 專案）。 */
  badge?: HTMLElement;
}

export interface PickerOptions<T> {
  label: string;
  placeholder: string;
  /** 沒有項目時的說明（可以依目前的狀況給不同的說明）。 */
  empty: string | (() => string);
  /** 分類與快速鍵各佔固定寬度的一欄，上下對齊（指令面板）。 */
  columns?: boolean;
  /** 說明放在名稱下面一行（說明很長時，例如修改記錄）。 */
  stacked?: boolean;
  /** 開在視窗最上面（蓋住標題列中間的搜尋框），不是畫面上方三分之一處。 */
  top?: boolean;
  /** 說明（所在資料夾等）是固定寬度、靠左的一欄，每一行從同一個位置開始（快速開啟）。 */
  detailColumn?: boolean;
  /**
   * 搜尋框下面「也可以：」那一列：輸入開頭的符號改找別的東西（例如 `>` 指令）。按一下就填入那個符號。
   * 每次打開時重新取得（依目前的狀況，例如連上 Azure DevOps 才有工作項目）。
   */
  tips?(): { prefix: string; label: string }[];
  /**
   * 依查詢字串回傳排序好的項目。比較慢的部分（例如向伺服器查詢）可以先不等，
   * 查到後呼叫 `more` 換成完整的清單（查詢字串已經改了的話會略過）。
   */
  query(text: string, more: (items: T[]) => void): T[] | Promise<T[]>;
  render(item: T): PickerItem;
  pick(item: T): void;
  /** 清單關閉時（選了項目之後，或取消）。 */
  closed?(): void;
}

/**
 * 有搜尋框的選擇清單（指令面板、Ctrl+P 快速開啟共用）。
 * 使用原生 <dialog>，焦點管理與 Esc 關閉都交給瀏覽器。
 */
export class Picker<T> {
  #dialog: HTMLDialogElement;
  #input: HTMLInputElement;
  #list: HTMLUListElement;
  #opts: PickerOptions<T>;
  #items: T[] = [];
  #active = 0;
  #seq = 0;
  #tips: HTMLElement;

  constructor(opts: PickerOptions<T>) {
    this.#opts = opts;
    this.#dialog = document.createElement("dialog");
    this.#dialog.className = opts.columns ? "palette palette-columns" : opts.stacked ? "palette palette-stacked" : "palette";
    if (opts.top) this.#dialog.classList.add("palette-top");
    if (opts.detailColumn) this.#dialog.classList.add("palette-detail-col");
    this.#dialog.setAttribute("aria-label", opts.label);
    const id = `picker-${Math.random().toString(36).slice(2, 8)}`;
    const tr = { select: t("選擇"), open: t("開啟"), close: t("關閉") };
    this.#dialog.innerHTML = `
      <input type="text" role="combobox" aria-expanded="true" aria-controls="${id}"
        aria-autocomplete="list" autocomplete="off" spellcheck="false" />
      <p class="palette-tips" hidden></p>
      <ul id="${id}" role="listbox"></ul>
      <p class="palette-hint"><kbd>↑</kbd><kbd>↓</kbd> ${tr.select}\u3000<kbd>Enter</kbd> ${tr.open}\u3000<kbd>Esc</kbd> ${tr.close}</p>`;
    document.body.append(this.#dialog);
    this.#input = this.#dialog.querySelector("input")!;
    this.#input.placeholder = opts.placeholder;
    this.#list = this.#dialog.querySelector("ul")!;
    this.#list.setAttribute("aria-label", opts.label);
    this.#tips = this.#dialog.querySelector(".palette-tips")!;
    this.#tips.addEventListener("click", (e) => {
      const tip = (e.target as HTMLElement).closest<HTMLElement>("[data-prefix]");
      if (!tip) return;
      // 已經打的字留著，換掉開頭原本的符號（打了「釜山」再按「? 問助理」→「?釜山」）。
      const prefixes = [...this.#tips.querySelectorAll<HTMLElement>("[data-prefix]")].map((b) => b.dataset.prefix!);
      const typed = this.#input.value.trimStart();
      const old = prefixes.find((p) => typed.startsWith(p));
      this.#input.value = tip.dataset.prefix! + (old ? typed.slice(old.length) : typed);
      this.#input.focus();
      void this.#refresh();
    });

    this.#input.addEventListener("input", () => void this.#refresh());
    this.#input.addEventListener("keydown", (e) => this.#onKey(e));
    this.#list.addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
      if (li) this.#run(Number(li.dataset.index));
    });
    this.#dialog.addEventListener("close", () => opts.closed?.());
    // 點對話框外面（::backdrop）關閉。
    this.#dialog.addEventListener("click", (e) => {
      if (e.target === this.#dialog) this.#dialog.close();
    });
  }

  open(initial = ""): void {
    if (this.#dialog.open) return;
    this.#input.value = initial;
    this.#renderTips();
    void this.#refresh();
    this.#dialog.showModal();
    this.#input.select();
  }

  #renderTips(): void {
    const tips = this.#opts.tips?.() ?? [];
    this.#tips.hidden = !tips.length;
    this.#tips.replaceChildren(
      Object.assign(document.createElement("span"), { textContent: t("也可以：") }),
      ...tips.map(({ prefix, label }) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "palette-tip";
        b.dataset.prefix = prefix;
        b.tabIndex = -1; // 用鍵盤直接打符號就好，Tab 不停在這裡
        b.append(Object.assign(document.createElement("kbd"), { textContent: prefix }), label);
        return b;
      }),
    );
  }

  async #refresh(): Promise<void> {
    const seq = ++this.#seq;
    // 慢的結果（`more`）比第一批先到時，等第一批畫完再換上。
    let shown = false;
    let late: T[] | null = null;
    const more = (list: T[]) => {
      if (seq !== this.#seq) return;
      if (shown) this.#render(list, true);
      else late = list;
    };
    const items = await this.#opts.query(this.#input.value, more);
    if (seq !== this.#seq) return; // 已經有更新的查詢
    this.#render(items, false);
    shown = true;
    if (late) this.#render(late, true);
  }

  /** 畫出清單；`keep` 時（補上慢的結果）選取的項目不變。 */
  #render(items: T[], keep: boolean): void {
    const picked = keep ? this.#items[this.#active] : undefined;
    this.#items = items;
    this.#active = picked === undefined ? 0 : Math.max(0, items.indexOf(picked));
    const listId = this.#list.id;
    let section: string | undefined;
    this.#list.replaceChildren(
      ...items.flatMap((item, i) => {
        const view = this.#opts.render(item);
        const out: HTMLLIElement[] = [];
        if (view.section && view.section !== section) {
          const head = document.createElement("li");
          head.className = "palette-section";
          head.role = "presentation";
          head.textContent = view.section;
          out.push(head);
        }
        section = view.section;
        const li = document.createElement("li");
        li.id = `${listId}-${i}`;
        li.role = "option";
        li.dataset.index = String(i);
        if (view.icon) li.append(icon(view.icon));
        if (view.color !== undefined) {
          const dot = document.createElement("span");
          dot.className = "project-dot";
          if (view.color) dot.dataset.color = view.color;
          li.append(dot);
        }
        const title = document.createElement("span");
        title.className = "palette-title";
        title.textContent = view.title;
        const named = view.badge ? Object.assign(document.createElement("span"), { className: "palette-named" }) : null;
        if (named) named.append(title, view.badge!);
        // 說明太長時截掉（完整的在滑鼠提示裡），名稱不會被擠成一字一行。
        const detail = view.detail ? Object.assign(document.createElement("span"), { className: "palette-group", textContent: view.detail, title: view.detail }) : null;
        if (this.#opts.stacked) {
          const text = document.createElement("span");
          text.className = "palette-text";
          text.append(named ?? title, ...(detail ? [detail] : []));
          li.append(text);
        } else li.append(named ?? title, ...(detail ? [detail] : []));
        const kbd = view.keys ? Object.assign(document.createElement("kbd"), { textContent: view.keys }) : null;
        if (this.#opts.columns) {
          // 沒有快速鍵的項目也留一格空白，左邊的分類文字才會上下切齊。
          const cell = document.createElement("span");
          cell.className = "palette-keys";
          if (kbd) cell.append(kbd);
          li.append(cell);
        } else if (kbd) li.append(kbd);
        out.push(li);
        return out;
      }),
    );
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "palette-empty";
      li.textContent = typeof this.#opts.empty === "function" ? this.#opts.empty() : this.#opts.empty;
      this.#list.append(li);
    }
    this.#highlight();
  }

  #highlight(): void {
    this.#list.querySelectorAll("[role=option]").forEach((li, i) => {
      li.setAttribute("aria-selected", String(i === this.#active));
      if (i === this.#active) li.scrollIntoView({ block: "nearest" });
    });
    this.#input.setAttribute("aria-activedescendant", this.#items.length ? `${this.#list.id}-${this.#active}` : "");
  }

  #onKey(e: KeyboardEvent): void {
    if (e.isComposing) return; // 注音輸入選字中不要攔截按鍵
    const n = this.#items.length;
    if (e.key === "ArrowDown" && n) this.#active = (this.#active + 1) % n;
    else if (e.key === "ArrowUp" && n) this.#active = (this.#active - 1 + n) % n;
    else if (e.key === "Enter") this.#run(this.#active);
    else return;
    e.preventDefault();
    this.#highlight();
  }

  #run(index: number): void {
    const item = this.#items[index];
    if (item === undefined) return;
    this.#dialog.close();
    this.#opts.pick(item);
  }
}
