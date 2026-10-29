/**
 * 側邊欄的議題清單：Azure DevOps 的工作項目、GitHub 的 Issues 共用。
 * 可以搜尋或輸入編號、用篩選列縮小範圍；點一下在主要區域開啟內容。
 */
import { t } from "../i18n.ts";
import { icon } from "./icons.ts";

export interface IssueSummary {
  id: number;
  title: string;
  /** 標題上方的小字，例如「Bug 123・Active・10/20」。 */
  meta: string;
  webUrl: string;
}

/** 清單的一組（分組時有標題）。 */
export interface IssueGroup<T> {
  title: string | null;
  /** 這一組的標題列是一個項目（例如 User Story）：顯示成卡片、點一下開啟，組裡的項目縮排。 */
  head?: T;
  items: T[];
}

/** 清單的排列方式（排序或分組）；在清單上方切換，不用重新讀取。 */
export interface Arrangement<T> {
  id: string;
  label: string;
  arrange(items: T[]): IssueGroup<T>[];
}

export interface IssuesHandlers<T extends IssueSummary> {
  list(search: string): Promise<T[]>;
  /** 在主要區域開啟內容。 */
  view(item: T): void;
  /** 狀態列文字：`count` 是結果數量，`search` 是搜尋文字（空白表示預設清單）。 */
  status(count: number, search: string): string;
  placeholder: string;
  /** 排列方式（第一個是預設）與記住上次的選擇。 */
  arrangements?: Arrangement<T>[];
  arrangement?: { load(): string | null; save(id: string): void };
  /** 項目前面的小圓點（例如「上次看過之後有更新」）；沒有就回傳 null。 */
  mark?(item: T): { kind: string; label: string } | null;
  /** 拖曳項目時帶的 Markdown 連結（拖到文件裡插入）。 */
  link?(item: T): string;
  /** 放在搜尋框下方的篩選列（改變時呼叫 `refresh()`）。 */
  filters?: HTMLElement;
  /** 放在搜尋框右邊的按鈕（例如展開、收合篩選列）。 */
  filterButton?: HTMLElement;
}

/** 讀取失敗：顯示錯誤與「重試」按鈕（例如網路斷了又接上，不用重新啟動程式）。 */
export function showLoadError(status: HTMLElement, e: unknown, retry: () => void): void {
  const message = document.createElement("span");
  message.textContent = e instanceof Error ? e.message : String(e);
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn btn-small load-retry";
  b.append(icon("refresh-cw"), t("重試"));
  b.addEventListener("click", retry);
  const hint = document.createElement("span");
  hint.className = "load-hint";
  hint.textContent = t("網路恢復或切回這個視窗時會自動再試一次。");
  status.replaceChildren(message, b, hint);
}

/** 「10/20」這樣的短日期。 */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getMonth() + 1}/${d.getDate()}`;
}

export class IssuesPanel<T extends IssueSummary> {
  #h: IssuesHandlers<T>;
  #input: HTMLInputElement;
  #status: HTMLElement;
  #list: HTMLUListElement;
  #seq = 0;
  /** 目前在主要區域開著的項目（清單上標示出來）。 */
  #current: number | null = null;
  /** 清單上每一列對應的項目（重畫小圓點用）。 */
  #rowItems = new WeakMap<HTMLElement, T>();
  #timer = 0;
  #loaded = false;
  /** 上次讀取失敗：網路恢復時再試一次。 */
  #failed = false;
  /** 最近一次讀到的清單（切換排列方式時重畫）。 */
  #items: T[] = [];
  #arrange: HTMLSelectElement | null = null;
  /** 收起來的分組。 */
  #collapsed = new Set<string>();

  constructor(el: HTMLElement, handlers: IssuesHandlers<T>) {
    this.#h = handlers;
    el.classList.add("workitems");
    this.#input = document.createElement("input");
    this.#input.type = "search";
    this.#input.className = "workitems-search";
    this.#input.placeholder = handlers.placeholder;
    this.#input.setAttribute("aria-label", handlers.placeholder);
    this.#input.addEventListener("input", () => {
      clearTimeout(this.#timer);
      this.#timer = window.setTimeout(() => void this.refresh(), 400);
    });
    this.#input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        clearTimeout(this.#timer);
        void this.refresh();
      }
    });
    this.#status = document.createElement("p");
    this.#status.className = "workitems-status";
    let statusRow: HTMLElement = this.#status;
    const arrangements = handlers.arrangements;
    if (arrangements?.length) {
      const select = document.createElement("select");
      select.className = "workitems-arrange";
      select.setAttribute("aria-label", t("排列方式"));
      select.title = t("排列方式");
      for (const a of arrangements) select.append(new Option(a.label, a.id));
      const saved = handlers.arrangement?.load();
      if (saved && arrangements.some((a) => a.id === saved)) select.value = saved;
      select.addEventListener("change", () => {
        handlers.arrangement?.save(select.value);
        this.#render();
      });
      this.#arrange = select;
      statusRow = document.createElement("div");
      statusRow.className = "workitems-statusrow";
      statusRow.append(this.#status, select);
    }
    this.#list = document.createElement("ul");
    this.#list.className = "workitems-list";
    let search: HTMLElement = this.#input;
    if (handlers.filterButton) {
      search = document.createElement("div");
      search.className = "workitems-searchrow";
      search.append(this.#input, handlers.filterButton);
    }
    el.append(search, ...(handlers.filters ? [handlers.filters] : []), statusRow, this.#list);
  }

  /** 第一次顯示面板時才讀取。 */
  shown(): void {
    if (!this.#loaded) void this.refresh();
  }

  /** 連線狀態或資料夾改變時清掉舊的內容。 */
  reset(): void {
    this.#loaded = false;
    this.#seq++;
    this.#list.replaceChildren();
    this.#status.textContent = "";
  }

  async refresh(): Promise<void> {
    this.#loaded = true;
    const seq = ++this.#seq;
    const search = this.#input.value.trim();
    this.#status.textContent = t("讀取中…");
    try {
      const items = await this.#h.list(search);
      if (seq !== this.#seq) return;
      this.#failed = false;
      this.#status.textContent = this.#h.status(items.length, search);
      this.#items = items;
      this.#render();
    } catch (e) {
      if (seq !== this.#seq) return;
      // 下次打開面板時再試一次。
      this.#loaded = false;
      this.#failed = true;
      showLoadError(this.#status, e, () => void this.refresh());
      this.#list.replaceChildren();
    }
  }

  /** 上次讀取失敗就重新讀取（網路恢復、切回視窗時呼叫）。 */
  retryFailed(): void {
    if (this.#failed) void this.refresh();
  }

  /** 依目前的排列方式畫出清單（分組時每組有可以收合的標題）。 */
  #render(): void {
    const arrangement = this.#h.arrangements?.find((a) => a.id === this.#arrange?.value);
    const groups = arrangement ? arrangement.arrange(this.#items) : [{ title: null, items: this.#items }];
    const rows: HTMLLIElement[] = [];
    for (const group of groups) {
      if (group.head) {
        rows.push(...this.#headGroup(group as IssueGroup<T> & { head: T }, `${arrangement?.id}:${group.title}`));
        continue;
      }
      if (group.title !== null) {
        const key = `${arrangement?.id}:${group.title}`;
        const open = !this.#collapsed.has(key);
        const li = document.createElement("li");
        li.className = "workitems-group";
        const b = document.createElement("button");
        b.type = "button";
        b.setAttribute("aria-expanded", String(open));
        const name = document.createElement("span");
        name.className = "workitems-group-name";
        name.textContent = group.title || t("（未設定）");
        name.title = name.textContent;
        name.classList.toggle("wrap", name.textContent.length > 24);
        const count = document.createElement("span");
        count.className = "workitems-group-count";
        count.textContent = String(group.items.length);
        b.append(icon(open ? "chevron-down" : "chevron-right"), name, count);
        b.addEventListener("click", () => {
          if (open) this.#collapsed.add(key);
          else this.#collapsed.delete(key);
          this.#render();
          this.#list.querySelector<HTMLElement>(`.workitems-group button[data-key="${CSS.escape(key)}"]`)?.focus();
        });
        b.dataset.key = key;
        li.append(b);
        rows.push(li);
        if (!open) continue;
      }
      rows.push(...group.items.map((it) => this.#row(it)));
    }
    this.#list.replaceChildren(...rows);
  }

  /** 以項目當標題列的一組：左邊是收合箭頭，標題列本身可以點開那個項目；子項目縮排、左邊一條線。 */
  #headGroup(group: IssueGroup<T> & { head: T }, key: string): HTMLLIElement[] {
    const open = !this.#collapsed.has(key);
    const li = this.#row(group.head);
    li.classList.add("workitems-group-card");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "workitems-group-toggle";
    toggle.dataset.key = key;
    toggle.setAttribute("aria-expanded", String(open));
    const label = open ? t("收合 {n} 個子項目", { n: group.items.length }) : t("展開 {n} 個子項目", { n: group.items.length });
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
    toggle.append(icon(open ? "chevron-down" : "chevron-right"));
    toggle.addEventListener("click", () => {
      if (open) this.#collapsed.add(key);
      else this.#collapsed.delete(key);
      this.#render();
      this.#list.querySelector<HTMLElement>(`.workitems-group-toggle[data-key="${CSS.escape(key)}"]`)?.focus();
    });
    const count = document.createElement("span");
    count.className = "workitems-group-count";
    count.textContent = String(group.items.length);
    li.prepend(toggle);
    li.append(count);
    if (!open) return [li];
    return [
      li,
      ...group.items.map((it) => {
        const row = this.#row(it);
        row.classList.add("workitems-child");
        return row;
      }),
    ];
  }

  #row(item: T): HTMLLIElement {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "workitem";
    b.title = t("#{id}：{title}", { id: item.id, title: item.title });
    const top = document.createElement("span");
    top.className = "workitem-meta";
    top.textContent = item.meta;
    const title = document.createElement("span");
    title.className = "workitem-title";
    title.textContent = item.title;
    b.append(top, title);
    b.dataset.id = String(item.id);
    if (item.id === this.#current) b.setAttribute("aria-current", "true");
    this.#rowItems.set(b, item);
    this.#applyMark(b, item);
    b.addEventListener("click", () => {
      this.select(item.id);
      this.#h.view(item);
    });
    const link = this.#h.link;
    if (link) {
      b.draggable = true;
      b.addEventListener("dragstart", (e) => {
        if (!e.dataTransfer) return;
        e.dataTransfer.setData("text/plain", link(item));
        e.dataTransfer.effectAllowed = "copy";
      });
    }
    li.append(b);
    return li;
  }

  #applyMark(b: HTMLElement, item: T): void {
    b.querySelector(".workitem-dot")?.remove();
    const mark = this.#h.mark?.(item) ?? null;
    b.classList.toggle("workitem-marked", !!mark);
    if (!mark) return;
    const dot = document.createElement("span");
    dot.className = `workitem-dot ${mark.kind}`;
    dot.title = mark.label;
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", mark.label);
    b.querySelector(".workitem-meta")?.prepend(dot);
  }

  /** 讀過清單、而且沒有在搜尋（顯示的是篩選列的清單）。 */
  get showingList(): boolean {
    return this.#loaded && !this.#input.value.trim();
  }

  /** 排列方式要的資料讀到了（例如分組用的上層項目）：依目前的排列方式重畫，不重新讀取清單。 */
  rearrange(): void {
    if (this.#loaded && !this.#failed) this.#render();
  }

  /** 重畫清單上的小圓點（例如開啟項目、背景檢查之後）。 */
  refreshMarks(): void {
    for (const b of this.#list.querySelectorAll<HTMLElement>(".workitem")) {
      const item = this.#rowItems.get(b);
      if (item) this.#applyMark(b, item);
    }
  }

  /** 標示目前在主要區域開著的項目（null 表示都沒開）。 */
  select(id: number | null): void {
    this.#current = id;
    for (const b of this.#list.querySelectorAll<HTMLElement>(".workitem")) {
      if (b.dataset.id === String(id)) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    }
  }
}
