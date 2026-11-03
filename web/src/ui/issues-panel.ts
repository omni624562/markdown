/**
 * 側邊欄的議題清單：Azure DevOps 的工作項目、GitHub 的 Issues 共用。
 * 可以搜尋或輸入編號、用篩選列縮小範圍；點一下在主要區域開啟內容。
 */
import { type Freshness, freshnessOf } from "../copy-cache.ts";
import { t } from "../i18n.ts";
import { stateTone } from "../issue-doc.ts";
import { kindKey } from "../work-item-colors.ts";
import { icon } from "./icons.ts";

export interface IssueSummary {
  id: number;
  title: string;
  /** 標題上方的小字，例如「Bug 123・10/20」。 */
  meta: string;
  webUrl: string;
  /** 工作項目的類型：清單左邊的色條用類型的顏色（設定裡可以改）。 */
  kind?: string;
  /** 狀態：顯示在小字右邊，前面的圓點顏色依狀態（新的、進行中、已解決、完成、移除）。 */
  state?: string;
}

/** 清單的一組（分組時有標題）。 */
export interface IssueGroup<T> {
  title: string | null;
  items: T[];
  /** 樹狀（例如依上層項目分組的 Epic → Feature → Story → Task）：畫在 `items` 前面。 */
  tree?: IssueTreeNode<T>[];
}

/** 樹狀清單的一個節點：項目與它底下的子項目。有子項目的是標題列（卡片、可以收合），子項目縮排。 */
export interface IssueTreeNode<T> {
  item: T;
  /** 不在清單上、只是用來分組的上層（淡色）。 */
  dim?: boolean;
  /** 標題列上的摘要（例如「3 個 User Story・8 個 Task」）。 */
  summary?: string;
  children: IssueTreeNode<T>[];
}

/** 樹狀清單最多縮排幾層（再深的和第 3 層對齊，窄的側邊欄也放得下）。 */
const TREE_INDENT_MAX = 3;

/** 清單的排列方式（排序或分組）；在清單上方切換，不用重新讀取。 */
export interface Arrangement<T> {
  id: string;
  label: string;
  arrange(items: T[]): IssueGroup<T>[];
}

export interface IssuesHandlers<T extends IssueSummary> {
  /** 讀清單；有副本時可以先回傳副本，背景讀完再呼叫 `update`（重新整理清單）。 */
  list(search: string, update: () => void): Promise<T[]>;
  /** 按「重試」時先忘掉剛讀到的結果（一定向伺服器讀）。 */
  forget?(): void;
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
  /** 拖曳項目時另外帶的資料（型別對應內容，例如拖到左側圖示列變成捷徑）。 */
  dragData?(item: T): Record<string, string>;
  /** 放在搜尋框下方的篩選列（改變時呼叫 `refresh()`）。 */
  filters?: HTMLElement;
  /** 放在搜尋框右邊的按鈕（例如展開、收合篩選列）。 */
  filterButton?: HTMLElement;
  /**
   * 一次改好幾個：Ctrl＋點一下加選、Shift＋點一下選一段，或按「選取」進入選取模式；
   * 選了之後清單上方出現「一起改…」，按了呼叫 `run`。
   */
  bulk?: { run(items: T[]): void };
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

/** 副本存下的時間：今天的只寫時間，其他加上日期；不知道時間的寫「上次」。 */
export function copyTime(savedAt: number): string {
  if (!savedAt) return t("上次");
  const d = new Date(savedAt);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/**
 * 顯示的是副本時，在狀態列後面加註：背景更新中，或這次讀不到（附「重試」）。
 * 回傳是否加了註記。
 */
export function noteCopy(status: HTMLElement, value: unknown, retry: () => void): boolean {
  const f: Freshness | null = freshnessOf(value);
  if (!f) {
    status.classList.remove("from-copy");
    return false;
  }
  status.classList.add("from-copy");
  const note = document.createElement("span");
  note.className = "copy-note";
  if (f.state === "updating") {
    note.textContent = t("（{time} 的資料，更新中…）", { time: copyTime(f.savedAt) });
    status.append(" ", note);
    return true;
  }
  note.textContent = t("連不上伺服器，顯示 {time} 存下的資料。", { time: copyTime(f.savedAt) });
  if (f.error) note.title = f.error;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn btn-small load-retry";
  b.append(icon("refresh-cw"), t("重試"));
  b.addEventListener("click", retry);
  status.append(" ", note, b);
  return true;
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
  /** 「全部收合／全部展開」（有分組時才出現）。 */
  #foldAll: HTMLButtonElement | null = null;
  /** 目前畫面上可以收合的分組。 */
  #groupKeys: string[] = [];
  /** 選取的項目（一起改用）；`#selecting` 是選取模式（點一下就是選取，不是開啟）。 */
  #selected = new Set<number>();
  #selecting = false;
  /** Shift＋點一下選一段時的起點。 */
  #anchor: number | null = null;
  /** 畫面上每個編號對應的項目（分組標題列的上層項目也算）。 */
  #byId = new Map<number, T>();
  #bulkBar: HTMLElement | null = null;
  #selectButton: HTMLButtonElement | null = null;

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
    const tools = document.createElement("span");
    tools.className = "workitems-tools";
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
      const fold = document.createElement("button");
      fold.type = "button";
      fold.className = "workitems-fold";
      fold.hidden = true;
      fold.addEventListener("click", () => {
        // 有任何一組開著就全部收合，否則全部展開。
        const collapse = this.#groupKeys.some((k) => !this.#collapsed.has(k));
        for (const k of this.#groupKeys) {
          if (collapse) this.#collapsed.add(k);
          else this.#collapsed.delete(k);
        }
        this.#render();
        this.#list.scrollTop = 0;
        fold.focus();
      });
      this.#foldAll = fold;
      tools.append(select, fold);
    }
    if (handlers.bulk) tools.append(this.#bulkTools());
    if (tools.childElementCount) {
      statusRow = document.createElement("div");
      statusRow.className = "workitems-statusrow";
      statusRow.append(this.#status, tools);
    }
    this.#list = document.createElement("ul");
    this.#list.className = "workitems-list";
    // 清單自己捲動（上面的搜尋與篩選固定不動）；捲下去時上緣出現分隔線。
    this.#list.addEventListener("scroll", () => this.#list.classList.toggle("scrolled", this.#list.scrollTop > 0), { passive: true });
    let search: HTMLElement = this.#input;
    if (handlers.filterButton) {
      search = document.createElement("div");
      search.className = "workitems-searchrow";
      search.append(this.#input, handlers.filterButton);
    }
    // 清單上按 Esc：取消選取。
    this.#list.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && (this.#selected.size || this.#selecting)) {
        e.preventDefault();
        e.stopPropagation();
        this.clearSelection();
      }
    });
    el.append(search, ...(handlers.filters ? [handlers.filters] : []), statusRow, ...(this.#bulkBar ? [this.#bulkBar] : []), this.#list);
  }

  /** 「選取」按鈕與選了之後出現的「已選 N 項・一起改…・取消選取」。 */
  #bulkTools(): HTMLElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "workitems-fold workitems-pick";
    b.title = t("選取好幾個一起改（也可以 Ctrl＋點一下加選、Shift＋點一下選一段）");
    b.setAttribute("aria-label", t("選取好幾個一起改"));
    b.setAttribute("aria-pressed", "false");
    b.append(icon("list-checks"));
    b.addEventListener("click", () => {
      if (this.#selecting) this.clearSelection();
      else {
        this.#selecting = true;
        this.#syncSelection();
      }
    });
    this.#selectButton = b;
    const bar = document.createElement("div");
    bar.className = "workitems-bulk";
    bar.hidden = true;
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", t("選取的項目"));
    const count = Object.assign(document.createElement("span"), { className: "workitems-bulk-count" });
    const run = document.createElement("button");
    run.type = "button";
    run.className = "btn btn-small btn-primary workitems-bulk-run";
    run.textContent = t("一起改…");
    run.addEventListener("click", () => {
      const items = this.selectedItems();
      if (items.length) this.#h.bulk?.run(items);
    });
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "btn btn-small";
    clear.textContent = t("取消選取");
    clear.addEventListener("click", () => this.clearSelection());
    bar.append(count, run, clear);
    this.#bulkBar = bar;
    return b;
  }

  /** 選取的項目（依清單上的順序）。 */
  selectedItems(): T[] {
    const order = [...this.#list.querySelectorAll<HTMLElement>(".workitem")].map((b) => Number(b.dataset.id));
    const ids = [...new Set([...order.filter((id) => this.#selected.has(id)), ...this.#selected])];
    return ids.map((id) => this.#byId.get(id)).filter((it): it is T => !!it);
  }

  /** 取消選取，離開選取模式。 */
  clearSelection(): void {
    this.#selected.clear();
    this.#selecting = false;
    this.#anchor = null;
    this.#syncSelection();
  }

  /** 選取狀態畫到清單與上方的列。 */
  #syncSelection(): void {
    const on = this.#selecting || this.#selected.size > 0;
    for (const b of this.#list.querySelectorAll<HTMLElement>(".workitem")) {
      const picked = this.#selected.has(Number(b.dataset.id));
      b.classList.toggle("selected", picked);
      if (on) b.setAttribute("aria-pressed", String(picked));
      else b.removeAttribute("aria-pressed");
    }
    this.#list.classList.toggle("selecting", on);
    this.#selectButton?.setAttribute("aria-pressed", String(this.#selecting));
    this.#selectButton?.classList.toggle("active", this.#selecting);
    const bar = this.#bulkBar;
    if (!bar) return;
    bar.hidden = !on;
    const n = this.#selected.size;
    bar.querySelector(".workitems-bulk-count")!.textContent = n ? t("已選 {n} 項", { n }) : t("點項目選取");
    bar.querySelector<HTMLButtonElement>(".workitems-bulk-run")!.disabled = !n;
  }

  /** 點一下項目時：選取（回傳 true）或照常開啟（false）。 */
  #pick(id: number, e: MouseEvent): boolean {
    if (!this.#h.bulk || !(this.#selecting || e.ctrlKey || e.metaKey || e.shiftKey)) return false;
    if (e.shiftKey && this.#anchor !== null) {
      const order = [...this.#list.querySelectorAll<HTMLElement>(".workitem")].map((b) => Number(b.dataset.id));
      const [a, b] = [order.indexOf(this.#anchor), order.indexOf(id)];
      if (a >= 0 && b >= 0) for (const x of order.slice(Math.min(a, b), Math.max(a, b) + 1)) this.#selected.add(x);
      else this.#selected.add(id);
    } else {
      if (this.#selected.has(id)) this.#selected.delete(id);
      else this.#selected.add(id);
      this.#anchor = id;
    }
    this.#syncSelection();
    return true;
  }

  /** 第一次顯示面板時才讀取。 */
  shown(): void {
    if (!this.#loaded) void this.refresh();
    // 面板藏著時標出的項目捲不過去：顯示出來後再捲到看得到的地方。
    else requestAnimationFrame(() => this.#list.querySelector<HTMLElement>('.workitem[aria-current="true"]')?.scrollIntoView({ block: "nearest" }));
  }

  /** 連線狀態或資料夾改變時清掉舊的內容。 */
  reset(): void {
    this.#loaded = false;
    this.#seq++;
    this.#list.replaceChildren();
    this.#status.textContent = "";
  }

  /** 重新讀取；`quiet`：清單留著、不顯示「讀取中…」（背景讀完副本的更新時）。 */
  async refresh(quiet = false): Promise<void> {
    this.#loaded = true;
    const seq = ++this.#seq;
    const search = this.#input.value.trim();
    if (!quiet) this.#status.textContent = t("讀取中…");
    try {
      const items = await this.#h.list(search, () => {
        // 背景讀完：搜尋文字沒變才重畫（變了的話新的讀取已經在跑）。
        if (seq === this.#seq) void this.refresh(true);
      });
      if (seq !== this.#seq) return;
      this.#failed = false;
      this.#status.textContent = this.#h.status(items.length, search);
      noteCopy(this.#status, items, () => {
        this.#h.forget?.();
        void this.refresh();
      });
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
    this.#byId.clear();
    this.#groupKeys = [];
    const prefix = `${arrangement?.id}:`;
    for (const group of groups) {
      if (group.tree) {
        // 收合的節點底下也算（「全部展開」才會打開裡面收起來的）。
        const walk = (nodes: IssueTreeNode<T>[]) => {
          for (const n of nodes) {
            if (!n.children.length) continue;
            this.#groupKeys.push(`${prefix}tree:${n.item.id}`);
            walk(n.children);
          }
        };
        walk(group.tree);
        this.#treeRows(group.tree, 0, prefix, rows);
      }
      if (group.title !== null) {
        const key = `${prefix}${group.title}`;
        this.#groupKeys.push(key);
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
    // 重新讀到的清單裡沒有的就不算選取了。
    for (const id of this.#selected) if (!this.#byId.has(id)) this.#selected.delete(id);
    this.#syncSelection();
    this.#updateFoldAll();
  }

  /** 「全部收合／全部展開」：兩組以上才顯示；有任何一組開著就是「全部收合」。 */
  #updateFoldAll(): void {
    const b = this.#foldAll;
    if (!b) return;
    b.hidden = this.#groupKeys.length < 2;
    const collapse = this.#groupKeys.some((k) => !this.#collapsed.has(k));
    const label = collapse ? t("全部收合") : t("全部展開");
    b.title = label;
    b.setAttribute("aria-label", label);
    b.replaceChildren(icon(collapse ? "chevrons-down-up" : "chevrons-up-down"));
  }

  /**
   * 樹狀清單（`depth` 是第幾層）：有子項目的節點是標題列（左邊收合箭頭，卡片本身可以點開那個項目，
   * 下面一行是摘要），收起來時不畫子項目；子項目每一層縮排一點、左邊一條線。
   */
  #treeRows(nodes: IssueTreeNode<T>[], depth: number, prefix: string, rows: HTMLLIElement[]): void {
    for (const node of nodes) {
      const li = this.#row(node.item);
      if (depth) {
        li.classList.add("workitems-child");
        li.dataset.depth = String(Math.min(depth, TREE_INDENT_MAX));
      }
      li.classList.toggle("workitems-dim", !!node.dim);
      rows.push(li);
      if (!node.children.length) continue;
      const key = `${prefix}tree:${node.item.id}`;
      const open = !this.#collapsed.has(key);
      li.classList.add("workitems-group-card");
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "workitems-group-toggle";
      toggle.dataset.key = key;
      toggle.setAttribute("aria-expanded", String(open));
      const n = node.children.length;
      const label = open ? t("收合 {n} 個子項目", { n }) : t("展開 {n} 個子項目", { n });
      toggle.title = label;
      toggle.setAttribute("aria-label", label);
      toggle.append(icon(open ? "chevron-down" : "chevron-right"));
      toggle.addEventListener("click", () => {
        if (open) this.#collapsed.add(key);
        else this.#collapsed.delete(key);
        this.#render();
        this.#list.querySelector<HTMLElement>(`.workitems-group-toggle[data-key="${CSS.escape(key)}"]`)?.focus();
      });
      li.prepend(toggle);
      if (node.summary) {
        const summary = document.createElement("span");
        summary.className = "workitem-summary";
        summary.textContent = node.summary;
        li.querySelector(".workitem")?.append(summary);
      }
      if (open) this.#treeRows(node.children, depth + 1, prefix, rows);
    }
  }

  #row(item: T): HTMLLIElement {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "workitem";
    b.title = t("#{id}：{title}", { id: item.id, title: item.title });
    const top = document.createElement("span");
    top.className = "workitem-meta";
    top.append(Object.assign(document.createElement("span"), { className: "workitem-meta-text", textContent: item.meta }));
    if (item.state) {
      const state = document.createElement("span");
      state.className = "workitem-state";
      const dot = document.createElement("span");
      dot.className = `ado-state-dot ${stateTone(item.state)}`;
      dot.setAttribute("aria-hidden", "true");
      state.append(dot, item.state);
      top.append(state);
    }
    const title = document.createElement("span");
    title.className = "workitem-title";
    title.textContent = item.title;
    b.append(top, title);
    b.dataset.id = String(item.id);
    if (item.kind) b.dataset.wiKind = kindKey(item.kind);
    if (item.id === this.#current) b.setAttribute("aria-current", "true");
    this.#rowItems.set(b, item);
    this.#byId.set(item.id, item);
    this.#applyMark(b, item);
    b.addEventListener("click", (e) => {
      if (this.#pick(item.id, e)) return;
      this.select(item.id);
      this.#h.view(item);
    });
    const { link, dragData } = this.#h;
    if (link || dragData) {
      b.draggable = true;
      b.addEventListener("dragstart", (e) => {
        if (!e.dataTransfer) return;
        if (link) e.dataTransfer.setData("text/plain", link(item));
        for (const [type, data] of Object.entries(dragData?.(item) ?? {})) e.dataTransfer.setData(type, data);
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
    b.querySelector(".workitem-meta-text")?.prepend(dot);
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
    // 分組收起來時，展開它所在的那一組（和檔案面板展開資料夾一樣），才看得到。
    if (id !== null) {
      const arrangement = this.#h.arrangements?.find((a) => a.id === this.#arrange?.value);
      const groups = arrangement?.arrange(this.#items) ?? [];
      const keys: string[] = [];
      const group = groups.find((g) => g.items.some((it) => it.id === id));
      if (group && group.title !== null) keys.push(`${arrangement?.id}:${group.title}`);
      // 樹狀：展開它所有的上層。
      const path = (nodes: IssueTreeNode<T>[]): string[] | null => {
        for (const n of nodes) {
          if (n.item.id === id) return [];
          const below = path(n.children);
          if (below) return [`${arrangement?.id}:tree:${n.item.id}`, ...below];
        }
        return null;
      };
      for (const g of groups) if (g.tree) keys.push(...(path(g.tree) ?? []));
      const closed = keys.filter((k) => this.#collapsed.has(k));
      if (closed.length) {
        for (const k of closed) this.#collapsed.delete(k);
        this.#render();
      }
    }
    for (const b of this.#list.querySelectorAll<HTMLElement>(".workitem")) {
      if (b.dataset.id === String(id)) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    }
    this.#list.querySelector<HTMLElement>('.workitem[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }
}
