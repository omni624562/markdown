import { type Command, type Commands, formatKeys, fuzzyScore } from "../commands.ts";
import { icon } from "./icons.ts";

/**
 * 指令面板（Ctrl/⌘+Shift+P）：輸入關鍵字即可找到所有功能並看到對應的快速鍵。
 * 使用原生 <dialog>，焦點管理與 Esc 關閉都交給瀏覽器。
 */
export class Palette {
  #dialog: HTMLDialogElement;
  #input: HTMLInputElement;
  #list: HTMLUListElement;
  #commands: Commands;
  #items: Command[] = [];
  #active = 0;

  constructor(commands: Commands) {
    this.#commands = commands;
    this.#dialog = document.createElement("dialog");
    this.#dialog.className = "palette";
    this.#dialog.setAttribute("aria-label", "指令面板");
    this.#dialog.innerHTML = `
      <input type="text" role="combobox" aria-expanded="true" aria-controls="palette-list"
        aria-autocomplete="list" placeholder="輸入指令名稱，例如「匯出」「表格」「深色」" autocomplete="off" spellcheck="false" />
      <ul id="palette-list" role="listbox" aria-label="指令"></ul>
      <p class="palette-hint"><kbd>↑</kbd><kbd>↓</kbd> 選擇　<kbd>Enter</kbd> 執行　<kbd>Esc</kbd> 關閉</p>`;
    document.body.append(this.#dialog);
    this.#input = this.#dialog.querySelector("input")!;
    this.#list = this.#dialog.querySelector("ul")!;

    this.#input.addEventListener("input", () => this.#refresh());
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

  open(): void {
    if (this.#dialog.open) return;
    this.#input.value = "";
    this.#refresh();
    this.#dialog.showModal();
    this.#input.focus();
  }

  #refresh(): void {
    const q = this.#input.value;
    this.#items = this.#commands
      .available()
      .filter((c) => c.id !== "palette")
      .map((c) => ({ c, score: Math.max(fuzzyScore(q, c.title), fuzzyScore(q, `${c.group} ${c.title}`) - 1) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);
    this.#active = 0;

    this.#list.replaceChildren(
      ...this.#items.map((c, i) => {
        const li = document.createElement("li");
        li.id = `palette-item-${i}`;
        li.role = "option";
        li.dataset.index = String(i);
        if (c.icon) li.append(icon(c.icon));
        const title = document.createElement("span");
        title.className = "palette-title";
        title.textContent = c.title;
        const group = document.createElement("span");
        group.className = "palette-group";
        group.textContent = c.group;
        li.append(title, group);
        if (c.keys) {
          const kbd = document.createElement("kbd");
          kbd.textContent = formatKeys(c.keys);
          li.append(kbd);
        }
        return li;
      }),
    );
    if (!this.#items.length) {
      const li = document.createElement("li");
      li.className = "palette-empty";
      li.textContent = "找不到符合的指令";
      this.#list.append(li);
    }
    this.#highlight();
  }

  #highlight(): void {
    this.#list.querySelectorAll("[role=option]").forEach((li, i) => {
      li.setAttribute("aria-selected", String(i === this.#active));
      if (i === this.#active) li.scrollIntoView({ block: "nearest" });
    });
    this.#input.setAttribute("aria-activedescendant", this.#items.length ? `palette-item-${this.#active}` : "");
  }

  #onKey(e: KeyboardEvent): void {
    if (e.isComposing) return; // 注音輸入選字中不要攔截按鍵
    const n = this.#items.length;
    if (e.key === "ArrowDown" && n) {
      this.#active = (this.#active + 1) % n;
    } else if (e.key === "ArrowUp" && n) {
      this.#active = (this.#active - 1 + n) % n;
    } else if (e.key === "Enter") {
      this.#run(this.#active);
    } else {
      return;
    }
    e.preventDefault();
    this.#highlight();
  }

  #run(index: number): void {
    const cmd = this.#items[index];
    if (!cmd) return;
    this.#dialog.close();
    void this.#commands.run(cmd.id);
  }
}
