import { icon } from "./icons.ts";

export interface TabInfo {
  id: string;
  name: string;
  /** 滑鼠停留時顯示的完整路徑。 */
  title: string;
  dirty: boolean;
  /** 檔案已從磁碟刪除。 */
  missing?: boolean;
  /** 固定的分頁：顯示圖釘（按一下取消固定），沒有關閉按鈕。 */
  pinned?: boolean;
}

export interface TabBarHandlers {
  select(id: string): void;
  close(id: string): void;
  create(): void;
  /** 雙擊分頁改名；回傳 false 表示這個分頁不能直接改名。 */
  canRename(id: string): boolean;
  rename(id: string, name: string): void;
  /** 在分頁上按右鍵（或 Shift+F10、選單鍵）。 */
  menu(id: string, at: DOMRect): void;
  unpin(id: string): void;
}

/**
 * 分頁列（也是視窗最上方的標題列）。中鍵點分頁可以關閉；雙擊分頁可以改名；右鍵開啟分頁選單；
 * 左右方向鍵在分頁間移動（WAI-ARIA tabs 模式）。
 */
export class TabBar {
  #el: HTMLElement;
  #list: HTMLElement;
  #handlers: TabBarHandlers;

  constructor(el: HTMLElement, handlers: TabBarHandlers) {
    this.#el = el;
    this.#handlers = handlers;
    this.#list = document.createElement("div");
    this.#list.className = "tabs";
    this.#list.role = "tablist";
    this.#list.setAttribute("aria-label", "已開啟的文件");
    const add = document.createElement("button");
    add.type = "button";
    add.className = "btn icon-only tab-new";
    add.title = "新增文件";
    add.setAttribute("aria-label", "新增文件");
    add.append(icon("plus"));
    add.addEventListener("click", () => handlers.create());
    el.replaceChildren(this.#list, add);
    // 分頁很多時用滑鼠滾輪左右捲動（捲軸隱藏起來比較乾淨）。
    this.#list.addEventListener(
      "wheel",
      (e) => {
        if (e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        if (this.#list.scrollWidth <= this.#list.clientWidth) return;
        e.preventDefault();
        this.#list.scrollLeft += e.deltaY;
      },
      { passive: false },
    );

    this.#list.addEventListener("keydown", (e) => {
      const tabs = [...this.#list.querySelectorAll<HTMLElement>("[role=tab]")];
      const i = tabs.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      let next = -1;
      if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Delete") {
        handlers.close(tabs[i].dataset.id!);
        e.preventDefault();
        return;
      } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
        e.preventDefault();
        const r = tabs[i].getBoundingClientRect();
        handlers.menu(tabs[i].dataset.id!, new DOMRect(r.left, r.bottom, 0, 0));
        return;
      }
      if (next < 0) return;
      e.preventDefault();
      tabs[next].focus();
      handlers.select(tabs[next].dataset.id!);
    });
  }

  render(tabs: TabInfo[], activeId: string): void {
    this.#el.hidden = false;
    this.#list.replaceChildren(
      ...tabs.map((t) => {
        const tab = document.createElement("div");
        tab.className = "tab";
        tab.role = "tab";
        tab.dataset.id = t.id;
        tab.tabIndex = t.id === activeId ? 0 : -1;
        tab.title = t.title;
        tab.setAttribute("aria-selected", String(t.id === activeId));
        tab.classList.toggle("missing", !!t.missing);
        tab.classList.toggle("pinned", !!t.pinned);
        const name = document.createElement("span");
        name.className = "tab-name";
        name.textContent = t.name;
        const close = document.createElement("button");
        close.type = "button";
        close.className = "tab-close";
        close.tabIndex = -1;
        close.classList.toggle("dirty", t.dirty);
        if (t.pinned) {
          close.title = t.dirty ? "已固定（有未存檔的變更）；按一下取消固定" : "已固定；按一下取消固定";
          close.setAttribute("aria-label", `取消固定「${t.name}」`);
          close.append(icon("pin"));
        } else {
          close.title = t.dirty ? "關閉（有未存檔的變更）" : "關閉";
          close.setAttribute("aria-label", `關閉「${t.name}」`);
          close.append(icon("x"));
        }
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          if (t.pinned) this.#handlers.unpin(t.id);
          else this.#handlers.close(t.id);
        });
        tab.append(name, close);
        tab.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const at = new DOMRect(e.clientX, e.clientY, 0, 0);
          // Linux 按下右鍵就觸發 contextmenu，等放開後再顯示，以免被當成點在選單外而立刻關閉。
          if (e.buttons & 2) window.addEventListener("pointerup", () => setTimeout(() => this.#handlers.menu(t.id, at)), { once: true });
          else this.#handlers.menu(t.id, at);
        });
        tab.addEventListener("click", () => this.#handlers.select(t.id));
        tab.addEventListener("dblclick", (e) => {
          if ((e.target as HTMLElement).closest(".tab-close")) return;
          this.startRename(t.id);
        });
        tab.addEventListener("auxclick", (e) => {
          if (e.button === 1) {
            e.preventDefault();
            this.#handlers.close(t.id);
          }
        });
        return tab;
      }),
    );
    this.#list.querySelector<HTMLElement>("[aria-selected=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /** 把分頁名稱換成輸入框；Enter 確定、Esc 取消。 */
  startRename(id: string): void {
    if (!this.#handlers.canRename(id)) return;
    const tab = this.#list.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
    const name = tab?.querySelector<HTMLElement>(".tab-name");
    if (!tab || !name) return;
    const input = document.createElement("input");
    input.className = "tab-rename";
    input.value = name.textContent ?? "";
    input.setAttribute("aria-label", "文件名稱");
    input.spellcheck = false;
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.replaceWith(name);
      if (commit && value && value !== name.textContent) this.#handlers.rename(id, value);
      tab.focus();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("dblclick", (e) => e.stopPropagation());
    name.replaceWith(input);
    input.focus();
    // 先選取主檔名（不含副檔名），和檔案總管一樣。
    const dot = input.value.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  }
}
