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

export interface IssuesHandlers<T extends IssueSummary> {
  list(search: string): Promise<T[]>;
  /** 在主要區域開啟內容。 */
  view(item: T): void;
  /** 狀態列文字：`count` 是結果數量，`search` 是搜尋文字（空白表示預設清單）。 */
  status(count: number, search: string): string;
  placeholder: string;
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
    this.#list = document.createElement("ul");
    this.#list.className = "workitems-list";
    let search: HTMLElement = this.#input;
    if (handlers.filterButton) {
      search = document.createElement("div");
      search.className = "workitems-searchrow";
      search.append(this.#input, handlers.filterButton);
    }
    el.append(search, ...(handlers.filters ? [handlers.filters] : []), this.#status, this.#list);
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
      this.#list.replaceChildren(...items.map((it) => this.#row(it)));
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
