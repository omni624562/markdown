import { t } from "../i18n.ts";
import { icon } from "./icons.ts";
import { placeMenu } from "./menu-place.ts";

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
  /** 不是本機檔案：`wiki` 是編輯中的 Azure DevOps Wiki 頁面（存檔時寫回伺服器）。 */
  source?: "wiki";
  /** 工作項目、Wiki 頁面等唯讀內容的分頁（不是文件）。 */
  item?: {
    icon: string;
    /** 來源（`ado`、`wiki`…），決定圖示的顏色。 */
    origin: string;
    /** 預覽分頁（名稱斜體）：點別的項目時會換掉。 */
    preview: boolean;
    /** 並排顯示在文件右邊。 */
    side: boolean;
    /** 工作項目的類型（`kindKey`）：圖示用這個類型的顏色。 */
    kind?: string;
  };
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
  /** 雙擊預覽分頁：留下來。 */
  keep(id: string): void;
}

/**
 * 分頁列（也是視窗最上方的標題列）。中鍵點分頁可以關閉；雙擊分頁可以改名；右鍵開啟分頁選單；
 * 左右方向鍵在分頁間移動（WAI-ARIA tabs 模式）。
 */
export class TabBar {
  #el: HTMLElement;
  #list: HTMLElement;
  #handlers: TabBarHandlers;
  /** 分頁太多、放不下時出現的「所有分頁」按鈕與清單。 */
  #more: HTMLButtonElement;
  #moreMenu: HTMLDivElement;
  #tabs: TabInfo[] = [];
  #activeId = "";

  constructor(el: HTMLElement, handlers: TabBarHandlers) {
    this.#el = el;
    this.#handlers = handlers;
    this.#list = document.createElement("div");
    this.#list.className = "tabs";
    this.#list.role = "tablist";
    this.#list.setAttribute("aria-label", t("已開啟的文件"));
    const add = document.createElement("button");
    add.type = "button";
    add.className = "btn icon-only tab-new";
    add.title = t("新增文件");
    add.setAttribute("aria-label", t("新增文件"));
    add.append(icon("plus"));
    add.addEventListener("click", () => handlers.create());
    this.#more = document.createElement("button");
    this.#more.type = "button";
    this.#more.className = "btn icon-only tab-more";
    this.#more.title = t("所有分頁");
    this.#more.setAttribute("aria-label", t("所有分頁"));
    this.#more.setAttribute("aria-haspopup", "menu");
    this.#more.hidden = true;
    this.#more.append(icon("chevron-down"));
    this.#moreMenu = document.createElement("div");
    this.#moreMenu.className = "menu tab-more-menu";
    this.#moreMenu.popover = "auto";
    this.#moreMenu.role = "menu";
    document.body.append(this.#moreMenu);
    this.#more.addEventListener("click", () => this.#openMore());
    this.#moreMenu.addEventListener("keydown", (e) => {
      const items = [...this.#moreMenu.querySelectorAll<HTMLElement>("button")];
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.key === "ArrowDown") items[(i + 1) % items.length]?.focus();
      else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length]?.focus();
      else return;
      e.preventDefault();
    });
    el.replaceChildren(this.#list, this.#more, add);
    // 分頁變多、視窗變窄時，判斷要不要顯示「所有分頁」按鈕與兩側的淡出提示。
    new ResizeObserver(() => this.#updateOverflow()).observe(this.#list);
    this.#list.addEventListener("scroll", () => this.#updateOverflow(), { passive: true });
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
    this.#tabs = tabs;
    this.#activeId = activeId;
    this.#list.replaceChildren(
      ...tabs.map((info) => {
        const tab = document.createElement("div");
        tab.className = "tab";
        tab.role = "tab";
        tab.dataset.id = info.id;
        tab.tabIndex = info.id === activeId ? 0 : -1;
        tab.title = info.title;
        tab.setAttribute("aria-selected", String(info.id === activeId));
        tab.classList.toggle("missing", !!info.missing);
        tab.classList.toggle("pinned", !!info.pinned);
        tab.classList.toggle("tab-wiki", info.source === "wiki");
        tab.classList.toggle("tab-item", !!info.item);
        tab.classList.toggle("preview", !!info.item?.preview);
        tab.classList.toggle("side-shown", !!info.item?.side);
        if (info.item) tab.dataset.origin = info.item.origin;
        if (info.item?.kind) tab.dataset.wiKind = info.item.kind;
        const name = document.createElement("span");
        name.className = "tab-name";
        name.textContent = info.name;
        if (info.item) {
          const mark = icon(info.item.icon);
          mark.classList.add("tab-icon");
          tab.append(mark);
        }
        const close = document.createElement("button");
        close.type = "button";
        close.className = "tab-close";
        close.tabIndex = -1;
        close.classList.toggle("dirty", info.dirty);
        if (info.pinned) {
          close.title = info.dirty ? t("已固定（有未存檔的變更）；按一下取消固定") : t("已固定；按一下取消固定");
          close.setAttribute("aria-label", t("取消固定「{name}」", { name: info.name }));
          close.append(icon("pin"));
        } else {
          close.title = info.dirty ? t("關閉（有未存檔的變更）") : t("關閉");
          close.setAttribute("aria-label", t("關閉「{name}」", { name: info.name }));
          close.append(icon("x"));
        }
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          if (info.pinned) this.#handlers.unpin(info.id);
          else this.#handlers.close(info.id);
        });
        tab.append(name, close);
        tab.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const at = new DOMRect(e.clientX, e.clientY, 0, 0);
          // Linux 按下右鍵就觸發 contextmenu，等放開後再顯示，以免被當成點在選單外而立刻關閉。
          if (e.buttons & 2) window.addEventListener("pointerup", () => setTimeout(() => this.#handlers.menu(info.id, at)), { once: true });
          else this.#handlers.menu(info.id, at);
        });
        tab.addEventListener("click", () => this.#handlers.select(info.id));
        tab.addEventListener("dblclick", (e) => {
          if ((e.target as HTMLElement).closest(".tab-close")) return;
          if (info.item) this.#handlers.keep(info.id);
          else this.startRename(info.id);
        });
        tab.addEventListener("auxclick", (e) => {
          if (e.button === 1) {
            e.preventDefault();
            this.#handlers.close(info.id);
          }
        });
        return tab;
      }),
    );
    this.#list.querySelector<HTMLElement>("[aria-selected=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    this.#updateOverflow();
  }

  #updateOverflow(): void {
    const list = this.#list;
    const overflow = list.scrollWidth > list.clientWidth + 1;
    this.#more.hidden = !overflow;
    list.classList.toggle("more-left", overflow && list.scrollLeft > 1);
    list.classList.toggle("more-right", overflow && list.scrollLeft + list.clientWidth < list.scrollWidth - 1);
  }

  /** 列出所有分頁（目前的打勾、未存檔的加圓點），點一下切換過去。 */
  #openMore(): void {
    const menu = this.#moreMenu;
    menu.replaceChildren(
      ...this.#tabs.map((t) => {
        const item = document.createElement("button");
        item.type = "button";
        item.role = "menuitemradio";
        const current = t.id === this.#activeId;
        item.setAttribute("aria-checked", String(current));
        item.title = t.title;
        item.append(icon(t.item?.icon ?? (t.pinned ? "pin" : "file")));
        item.append(Object.assign(document.createElement("span"), { textContent: `${t.name}${t.dirty ? "  ●" : ""}` }));
        if (current) item.append(icon("check"));
        item.addEventListener("click", () => {
          menu.hidePopover();
          this.#handlers.select(t.id);
        });
        return item;
      }),
    );
    menu.showPopover();
    const { width, height } = menu.getBoundingClientRect();
    const p = placeMenu(this.#more.getBoundingClientRect(), { width, height }, { width: window.innerWidth, height: window.innerHeight }, "below");
    Object.assign(menu.style, { left: `${p.left}px`, top: `${p.top}px`, right: "auto", bottom: "auto", maxHeight: `${p.maxHeight}px` });
    menu.querySelector<HTMLElement>("[aria-checked=true]")?.focus();
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
    input.setAttribute("aria-label", t("文件名稱"));
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
