import { icon } from "./icons.ts";

export interface PickerItem {
  title: string;
  /** 次要說明（例如所在資料夾、指令分類）。 */
  detail?: string;
  icon?: string;
  /** 右側顯示的快速鍵。 */
  keys?: string;
}

export interface PickerOptions<T> {
  label: string;
  placeholder: string;
  empty: string;
  /** 依查詢字串回傳排序好的項目。 */
  query(text: string): T[] | Promise<T[]>;
  render(item: T): PickerItem;
  pick(item: T): void;
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

  constructor(opts: PickerOptions<T>) {
    this.#opts = opts;
    this.#dialog = document.createElement("dialog");
    this.#dialog.className = "palette";
    this.#dialog.setAttribute("aria-label", opts.label);
    const id = `picker-${Math.random().toString(36).slice(2, 8)}`;
    this.#dialog.innerHTML = `
      <input type="text" role="combobox" aria-expanded="true" aria-controls="${id}"
        aria-autocomplete="list" autocomplete="off" spellcheck="false" />
      <ul id="${id}" role="listbox"></ul>
      <p class="palette-hint"><kbd>↑</kbd><kbd>↓</kbd> 選擇　<kbd>Enter</kbd> 開啟　<kbd>Esc</kbd> 關閉</p>`;
    document.body.append(this.#dialog);
    this.#input = this.#dialog.querySelector("input")!;
    this.#input.placeholder = opts.placeholder;
    this.#list = this.#dialog.querySelector("ul")!;
    this.#list.setAttribute("aria-label", opts.label);

    this.#input.addEventListener("input", () => void this.#refresh());
    this.#input.addEventListener("keydown", (e) => this.#onKey(e));
    this.#list.addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
      if (li) this.#run(Number(li.dataset.index));
    });
    // 點對話框外面（::backdrop）關閉。
    this.#dialog.addEventListener("click", (e) => {
      if (e.target === this.#dialog) this.#dialog.close();
    });
  }

  open(initial = ""): void {
    if (this.#dialog.open) return;
    this.#input.value = initial;
    void this.#refresh();
    this.#dialog.showModal();
    this.#input.select();
  }

  async #refresh(): Promise<void> {
    const seq = ++this.#seq;
    const items = await this.#opts.query(this.#input.value);
    if (seq !== this.#seq) return; // 已經有更新的查詢
    this.#items = items;
    this.#active = 0;
    const listId = this.#list.id;
    this.#list.replaceChildren(
      ...items.map((item, i) => {
        const view = this.#opts.render(item);
        const li = document.createElement("li");
        li.id = `${listId}-${i}`;
        li.role = "option";
        li.dataset.index = String(i);
        if (view.icon) li.append(icon(view.icon));
        const title = document.createElement("span");
        title.className = "palette-title";
        title.textContent = view.title;
        li.append(title);
        if (view.detail) {
          const detail = document.createElement("span");
          detail.className = "palette-group";
          detail.textContent = view.detail;
          li.append(detail);
        }
        if (view.keys) {
          const kbd = document.createElement("kbd");
          kbd.textContent = view.keys;
          li.append(kbd);
        }
        return li;
      }),
    );
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "palette-empty";
      li.textContent = this.#opts.empty;
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
