import { icon } from "./icons.ts";

export interface TabInfo {
  id: string;
  name: string;
  /** 滑鼠停留時顯示的完整路徑。 */
  title: string;
  dirty: boolean;
  /** 檔案已從磁碟刪除。 */
  missing?: boolean;
}

export interface TabBarHandlers {
  select(id: string): void;
  close(id: string): void;
  create(): void;
}

/**
 * 分頁列。中鍵點分頁可以關閉；左右方向鍵在分頁間移動（WAI-ARIA tabs 模式）。
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
        const name = document.createElement("span");
        name.className = "tab-name";
        name.textContent = t.name;
        const close = document.createElement("button");
        close.type = "button";
        close.className = "tab-close";
        close.tabIndex = -1;
        close.title = t.dirty ? "關閉（有未存檔的變更）" : "關閉";
        close.setAttribute("aria-label", `關閉「${t.name}」`);
        close.classList.toggle("dirty", t.dirty);
        close.append(icon("x"));
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          this.#handlers.close(t.id);
        });
        tab.append(name, close);
        tab.addEventListener("click", () => this.#handlers.select(t.id));
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
}
