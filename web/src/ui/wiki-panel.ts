/**
 * 側邊欄的 Azure DevOps Wiki：選一個 Wiki、看頁面樹狀目錄（可以搜尋頁面名稱），
 * 點一下頁面在主要區域以唯讀方式開啟。
 */
import { t } from "../i18n.ts";
import { flattenPages, pageName, pushRecent, snippetParts } from "../wiki-text.ts";
import { icon } from "./icons.ts";
import { showLoadError } from "./issues-panel.ts";

export interface WikiInfo {
  id: string;
  name: string;
  project: string;
}

export interface WikiTreePage {
  path: string;
  children: WikiTreePage[];
}

export interface WikiPanelHooks<W extends WikiInfo> {
  wikis(): Promise<W[]>;
  pages(wiki: W): Promise<WikiTreePage[]>;
  /** 在主要區域開啟頁面。 */
  open(wiki: W, path: string): void;
  /** 上次選的 Wiki。 */
  load(): string | null;
  save(id: string): void;
  /** 每個 Wiki 各自記住的最近看過、釘選的頁面。 */
  prefs(wikiId: string): WikiPrefs;
  savePrefs(wikiId: string, prefs: WikiPrefs): void;
  /** 拖曳頁面時帶的 Markdown 連結（拖到文件裡插入）；沒有網址時回傳 null。 */
  link?(wiki: W, path: string): string | null;
  /** 搜尋頁面內容（`path` 是頁面路徑）；伺服器沒有搜尋功能時 `available` 是 false。 */
  searchContent?(wiki: W, text: string): Promise<WikiContentSearch>;
  /** 新增頁面：`parent` 是上層頁面（null 是最上層）；不能新增的 Wiki（例如程式碼 Wiki）回傳 false 時不顯示按鈕。 */
  create?(wiki: W, parent: string | null): void;
  canCreate?(wiki: W): boolean;
  /** 釘選放在別的地方（例如左側圖示列）：給了就用它，面板上不列「已釘選」。 */
  pins?: WikiPins<W>;
  /** 拖曳頁面時另外帶的資料（型別 → 內容），例如拖到圖示列變成捷徑。 */
  dragData?(wiki: W, path: string): Record<string, string>;
}

export interface WikiPins<W> {
  has(wiki: W, path: string): boolean;
  toggle(wiki: W, path: string): void;
  /** 釘選按鈕的說明：[還沒釘選時, 已釘選時]。 */
  labels: [string, string];
}

export interface WikiContentSearch {
  available: boolean;
  results: { path: string; snippet: string }[];
}

export interface WikiPrefs {
  recent: string[];
  pinned: string[];
}

/** 最近看過列出幾頁、最多釘選幾頁。 */
const RECENT_LIMIT = 5;
const PINNED_LIMIT = 30;

/** 搜尋結果最多列出幾頁。 */
const MAX_RESULTS = 200;
/** 搜尋內容：至少幾個字、停止輸入多久後才搜尋。 */
const CONTENT_MIN = 2;
const CONTENT_DELAY = 500;

export class WikiPanel<W extends WikiInfo> {
  #h: WikiPanelHooks<W>;
  #select: HTMLSelectElement;
  /** 「新增頁面」（最上層）。 */
  #newBtn: HTMLButtonElement;
  #input: HTMLInputElement;
  #status: HTMLElement;
  #list: HTMLUListElement;
  /** 樹狀目錄上方的「釘選」「最近看過」。 */
  #quick: HTMLElement;
  #prefs: WikiPrefs = { recent: [], pinned: [] };
  #wikis: W[] = [];
  #wiki: W | null = null;
  #pages: WikiTreePage[] = [];
  #expanded = new Set<string>();
  #current: string | null = null;
  #seq = 0;
  #loaded = false;
  /** 上次讀取失敗時要重做的事（網路恢復時再試一次）。 */
  #retry: (() => void) | null = null;
  /** 名稱搜尋結果下方的「內容符合」。 */
  #content: HTMLElement;
  #contentTimer = 0;
  #contentSeq = 0;
  /** 搜過的內容結果（`Wiki id` + 搜尋字 → 結果或錯誤訊息）。 */
  #contentCache = new Map<string, WikiContentSearch | string>();
  /** 伺服器沒有搜尋功能（只提示一次，之後不再搜尋）。 */
  #contentUnavailable = false;

  constructor(el: HTMLElement, hooks: WikiPanelHooks<W>) {
    this.#h = hooks;
    el.classList.add("workitems", "wiki-panel");
    const bar = document.createElement("div");
    bar.className = "workitems-filters wiki-filters";
    this.#select = document.createElement("select");
    this.#select.className = "workitems-select";
    this.#select.setAttribute("aria-label", "Wiki");
    this.#select.addEventListener("change", () => {
      const wiki = this.#wikis.find((w) => w.id === this.#select.value) ?? null;
      if (wiki) this.#h.save(wiki.id);
      void this.#loadPages(wiki);
    });
    this.#newBtn = document.createElement("button");
    this.#newBtn.type = "button";
    this.#newBtn.className = "wiki-new";
    const newLabel = t("新增頁面");
    this.#newBtn.title = newLabel;
    this.#newBtn.setAttribute("aria-label", newLabel);
    this.#newBtn.append(icon("file-plus"), Object.assign(document.createElement("span"), { textContent: newLabel }));
    this.#newBtn.hidden = true;
    this.#newBtn.addEventListener("click", () => {
      if (this.#wiki) this.#h.create?.(this.#wiki, null);
    });
    bar.append(this.#select, this.#newBtn);
    this.#input = document.createElement("input");
    this.#input.type = "search";
    this.#input.className = "workitems-search";
    const searchLabel = hooks.searchContent ? t("搜尋頁面名稱與內容") : t("搜尋頁面名稱");
    this.#input.placeholder = searchLabel;
    this.#input.setAttribute("aria-label", searchLabel);
    this.#input.addEventListener("input", () => this.#render());
    // ↓ 從搜尋框移到清單。
    this.#input.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" || e.isComposing) return;
      const first = this.#pageButtons()[0];
      if (!first) return;
      e.preventDefault();
      first.focus();
    });
    this.#status = document.createElement("p");
    this.#status.className = "workitems-status";
    this.#list = document.createElement("ul");
    this.#list.className = "wiki-tree";
    this.#list.setAttribute("role", "tree");
    this.#list.setAttribute("aria-label", t("Wiki 頁面"));
    this.#list.addEventListener("keydown", (e) => this.#keydown(e));
    // 樹狀目錄在 Tab 順序裡只佔一個位置（目前聚焦的那一列）。
    this.#list.addEventListener("focusin", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".wiki-page");
      if (b) this.#rove(b);
    });
    this.#quick = document.createElement("div");
    this.#quick.className = "wiki-quick";
    this.#quick.hidden = true;
    this.#quick.addEventListener("keydown", (e) => this.#keydown(e));
    this.#content = document.createElement("section");
    this.#content.className = "wiki-content";
    this.#content.hidden = true;
    this.#content.addEventListener("keydown", (e) => this.#keydown(e));
    el.append(bar, this.#input, this.#status, this.#quick, this.#list, this.#content);
    // 把頁面拖到文件裡，插入 `[頁面名稱](網址)`。
    el.addEventListener("dragstart", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>(".wiki-page");
      if (!b || !this.#wiki || !e.dataTransfer) return;
      const path = b.dataset.path!;
      const link = this.#h.link?.(this.#wiki, path);
      const extra = this.#h.dragData?.(this.#wiki, path) ?? {};
      if (!link && !Object.keys(extra).length) return;
      if (link) e.dataTransfer.setData("text/plain", link);
      for (const [type, value] of Object.entries(extra)) e.dataTransfer.setData(type, value);
      e.dataTransfer.effectAllowed = "copy";
    });
  }

  /** 第一次顯示面板時才讀取。 */
  shown(): void {
    if (!this.#loaded) void this.refresh();
  }

  /** 連線狀態改變時清掉舊的內容。 */
  reset(): void {
    this.#loaded = false;
    this.#seq++;
    this.#wikis = [];
    this.#wiki = null;
    this.#pages = [];
    this.#select.replaceChildren();
    this.#list.replaceChildren();
    this.#quick.replaceChildren();
    this.#quick.hidden = true;
    this.#status.textContent = "";
    this.#contentCache.clear();
    this.#contentUnavailable = false;
    this.#renderContent("");
  }

  /** 重新讀取 Wiki 清單與目前 Wiki 的頁面。 */
  async refresh(): Promise<void> {
    this.#loaded = true;
    const seq = ++this.#seq;
    this.#status.textContent = t("讀取中…");
    try {
      const wikis = await this.#h.wikis();
      if (seq !== this.#seq) return;
      this.#wikis = wikis;
      this.#select.replaceChildren(
        ...wikis.map((w) => {
          const o = document.createElement("option");
          o.value = w.id;
          // 專案 Wiki 的名稱本來就是「專案.wiki」，不用再加專案名稱。
          o.textContent = w.name.toLowerCase().startsWith(w.project.toLowerCase())
            ? w.name
            : t("{project}／{name}", { project: w.project, name: w.name });
          return o;
        }),
      );
      this.#select.hidden = wikis.length < 2;
      const keep = this.#wiki?.id ?? this.#h.load();
      const wiki = wikis.find((w) => w.id === keep) ?? wikis[0] ?? null;
      if (wiki) this.#select.value = wiki.id;
      await this.#loadPages(wiki);
    } catch (e) {
      if (seq !== this.#seq) return;
      // 下次打開面板時再試一次。
      this.#loaded = false;
      this.#retry = () => void this.refresh();
      showLoadError(this.#status, e, this.#retry);
      this.#list.replaceChildren();
    }
  }

  async #loadPages(wiki: W | null): Promise<void> {
    const seq = ++this.#seq;
    if (wiki?.id !== this.#wiki?.id) this.#expanded.clear();
    this.#wiki = wiki;
    this.#pages = [];
    this.#newBtn.hidden = !this.#canCreate();
    this.#prefs = wiki ? this.#h.prefs(wiki.id) : { recent: [], pinned: [] };
    this.#list.replaceChildren();
    this.#quick.hidden = true;
    this.#renderContent("");
    if (!wiki) {
      this.#status.textContent = t("這個集合裡沒有 Wiki");
      return;
    }
    this.#status.textContent = t("讀取中…");
    try {
      const pages = await this.#h.pages(wiki);
      if (seq !== this.#seq) return;
      this.#pages = pages;
      this.#retry = null;
      this.#render();
    } catch (e) {
      if (seq !== this.#seq) return;
      this.#loaded = false;
      this.#retry = () => void this.#loadPages(wiki);
      showLoadError(this.#status, e, this.#retry);
    }
  }

  /** 上次讀取失敗就重新讀取（網路恢復、切回視窗時呼叫）。 */
  retryFailed(): void {
    const retry = this.#retry;
    this.#retry = null;
    retry?.();
  }

  /** 目前選的 Wiki。 */
  get wiki(): W | null {
    return this.#wiki;
  }

  /** 目前 Wiki 的頁面樹。 */
  get pages(): WikiTreePage[] {
    return this.#pages;
  }

  #render(): void {
    const q = this.#input.value.trim().toLowerCase();
    this.#renderQuick(!q);
    if (!this.#pages.length) {
      this.#status.textContent = t("這個 Wiki 還沒有頁面");
      this.#list.replaceChildren();
      this.#renderContent("");
      return;
    }
    if (q) {
      const found: WikiTreePage[] = [];
      const walk = (list: WikiTreePage[]) => {
        for (const p of list) {
          if (pageName(p.path).toLowerCase().includes(q)) found.push(p);
          walk(p.children);
        }
      };
      walk(this.#pages);
      this.#status.textContent = found.length ? t("找到 {n} 頁", { n: found.length }) : t("找不到符合的頁面");
      this.#list.replaceChildren(...found.slice(0, MAX_RESULTS).map((p) => this.#row(p, 0, true)));
      this.#rove();
      this.#renderContent(this.#input.value.trim());
      return;
    }
    this.#renderContent("");
    this.#status.textContent = "";
    const rows: HTMLLIElement[] = [];
    const walk = (list: WikiTreePage[], depth: number) => {
      for (const p of list) {
        rows.push(this.#row(p, depth, false));
        if (this.#expanded.has(p.path)) walk(p.children, depth + 1);
      }
    };
    walk(this.#pages, 0);
    this.#list.replaceChildren(...rows);
    this.#rove();
  }

  /** 「釘選」「最近看過」、樹狀目錄與「內容符合」裡所有的頁面按鈕（由上而下）。 */
  #pageButtons(): HTMLButtonElement[] {
    const quick = this.#quick.hidden ? [] : [...this.#quick.querySelectorAll<HTMLButtonElement>(".wiki-page")];
    const content = this.#content.hidden ? [] : [...this.#content.querySelectorAll<HTMLButtonElement>(".wiki-page")];
    return [...quick, ...this.#list.querySelectorAll<HTMLButtonElement>(".wiki-page"), ...content];
  }

  /** 名稱搜尋結果下方的「內容符合」：停止輸入一下子後才搜尋，同樣的字不重複搜尋。 */
  #renderContent(text: string): void {
    clearTimeout(this.#contentTimer);
    const wiki = this.#wiki;
    if (!wiki || !this.#h.searchContent || [...text].length < CONTENT_MIN) {
      this.#contentSeq++;
      this.#content.hidden = true;
      this.#content.replaceChildren();
      return;
    }
    const heading = document.createElement("h3");
    heading.textContent = t("內容符合");
    const note = (message: string) => {
      const p = document.createElement("p");
      p.className = "wiki-content-note";
      p.textContent = message;
      this.#content.replaceChildren(heading, p);
      this.#content.hidden = false;
    };
    if (this.#contentUnavailable) {
      note(t("伺服器沒有啟用 Wiki 內容搜尋（需要安裝 Search 擴充功能），目前只能搜尋頁面名稱"));
      return;
    }
    const key = `${wiki.id}\n${text.toLowerCase()}`;
    const cached = this.#contentCache.get(key);
    if (cached !== undefined) {
      if (typeof cached === "string") note(cached);
      else this.#showContent(heading, cached);
      return;
    }
    note(t("搜尋內容中…"));
    const seq = ++this.#contentSeq;
    this.#contentTimer = window.setTimeout(async () => {
      let result: WikiContentSearch | string;
      try {
        result = await this.#h.searchContent!(wiki, text);
      } catch (e) {
        result = String(e);
      }
      if (typeof result !== "string" && !result.available) this.#contentUnavailable = true;
      else this.#contentCache.set(key, result);
      if (seq === this.#contentSeq) this.#renderContent(text);
    }, CONTENT_DELAY);
  }

  #showContent(heading: HTMLElement, found: WikiContentSearch): void {
    const exists = new Set(flattenPages(this.#pages));
    const results = found.results.filter((r) => exists.has(r.path));
    heading.textContent = t("內容符合（{n}）", { n: results.length });
    if (!results.length) {
      const p = document.createElement("p");
      p.className = "wiki-content-note";
      p.textContent = t("沒有頁面內容符合");
      this.#content.replaceChildren(heading, p);
      this.#content.hidden = false;
      return;
    }
    const ul = document.createElement("ul");
    for (const r of results) {
      const li = document.createElement("li");
      li.className = "wiki-row";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "wiki-page";
      b.dataset.path = r.path;
      b.title = r.path;
      b.draggable = !!(this.#h.link || this.#h.dragData);
      b.tabIndex = -1;
      const name = document.createElement("span");
      name.className = "wiki-name";
      name.textContent = pageName(r.path);
      b.append(name);
      const where = r.path.slice(1, r.path.lastIndexOf("/"));
      if (where) {
        const meta = document.createElement("span");
        meta.className = "wiki-where";
        meta.textContent = where;
        b.append(meta);
      }
      const parts = snippetParts(r.snippet);
      if (parts.length) {
        const snip = document.createElement("span");
        snip.className = "wiki-snippet";
        for (const part of parts) {
          if (!part.hit) snip.append(part.text);
          else {
            const mark = document.createElement("mark");
            mark.textContent = part.text;
            snip.append(mark);
          }
        }
        b.append(snip);
      }
      if (r.path === this.#current) b.setAttribute("aria-current", "true");
      b.addEventListener("click", () => {
        if (!this.#wiki) return;
        this.select(r.path);
        this.#h.open(this.#wiki, r.path);
      });
      li.append(b);
      ul.append(li);
    }
    this.#content.replaceChildren(heading, ul);
    this.#content.hidden = false;
  }

  /** 樹狀目錄裡只有 `active`（沒給就是目前的頁面或第一列）可以用 Tab 移到。 */
  #rove(active?: HTMLButtonElement): void {
    const buttons = [...this.#list.querySelectorAll<HTMLButtonElement>(".wiki-page")];
    const target = active ?? buttons.find((b) => b.getAttribute("aria-current") === "true") ?? buttons[0];
    for (const b of buttons) b.tabIndex = b === target ? 0 : -1;
  }

  #focusPage(path: string): void {
    this.#list.querySelector<HTMLButtonElement>(`.wiki-page[data-path="${CSS.escape(path)}"]`)?.focus();
  }

  /** 鍵盤操作：↑↓ 移動、→ 展開（已展開就移到第一個子頁面）、← 收合（已收合就移到上一層）、Home／End、Enter 開啟。 */
  #keydown(e: KeyboardEvent): void {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".wiki-page");
    if (!b || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
    const all = this.#pageButtons();
    const i = all.indexOf(b);
    const path = b.dataset.path!;
    const inTree = this.#list.contains(b);
    const expanded = b.closest("li")?.getAttribute("aria-expanded");
    let target: HTMLElement | undefined;
    switch (e.key) {
      case "ArrowDown":
        target = all[i + 1];
        break;
      case "ArrowUp":
        target = i > 0 ? all[i - 1] : this.#input;
        break;
      case "Home":
        target = all[0];
        break;
      case "End":
        target = all[all.length - 1];
        break;
      case "ArrowRight":
        if (!inTree) return;
        if (expanded === "false") {
          this.#toggle(path);
          this.#focusPage(path);
        } else if (expanded === "true") target = all[i + 1];
        break;
      case "ArrowLeft":
        if (!inTree) return;
        if (expanded === "true") {
          this.#toggle(path);
          this.#focusPage(path);
        } else this.#focusPage(path.slice(0, path.lastIndexOf("/")));
        break;
      default:
        return;
    }
    e.preventDefault();
    target?.focus();
  }

  #row(page: WikiTreePage, depth: number, flat: boolean): HTMLLIElement {
    const li = document.createElement("li");
    li.setAttribute("role", "treeitem");
    li.className = "wiki-row";
    li.style.setProperty("--depth", String(depth));
    const open = this.#expanded.has(page.path);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "wiki-toggle";
    toggle.tabIndex = -1;
    if (!flat && page.children.length) {
      li.setAttribute("aria-expanded", String(open));
      toggle.append(icon(open ? "chevron-down" : "chevron-right"));
      toggle.setAttribute("aria-label", open ? t("收合") : t("展開"));
      toggle.addEventListener("click", () => this.#toggle(page.path));
    } else toggle.disabled = true;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wiki-page";
    b.dataset.path = page.path;
    b.title = page.path;
    b.draggable = !!(this.#h.link || this.#h.dragData);
    const name = document.createElement("span");
    name.className = "wiki-name";
    name.textContent = pageName(page.path);
    b.append(name);
    if (flat) {
      const where = page.path.slice(0, page.path.lastIndexOf("/"));
      if (where) {
        const meta = document.createElement("span");
        meta.className = "wiki-where";
        meta.textContent = where.slice(1);
        b.append(meta);
      }
    }
    if (page.path === this.#current) b.setAttribute("aria-current", "true");
    b.addEventListener("click", () => {
      if (!this.#wiki) return;
      if (!flat && page.children.length && !open) this.#toggle(page.path);
      this.select(page.path);
      this.#h.open(this.#wiki, page.path);
    });
    li.append(toggle, b);
    if (this.#canCreate()) li.append(this.#addButton(page.path));
    li.append(this.#pinButton(page.path));
    return li;
  }

  #canCreate(): boolean {
    return !!this.#wiki && !!this.#h.create && (this.#h.canCreate?.(this.#wiki) ?? true);
  }

  /** 「新增子頁面」的按鈕（滑鼠移到列上才出現）。 */
  #addButton(path: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wiki-add";
    const label = t("在「{name}」底下新增子頁面", { name: pageName(path) });
    b.title = label;
    b.setAttribute("aria-label", label);
    b.append(icon("plus"));
    b.addEventListener("click", () => {
      if (this.#wiki) this.#h.create?.(this.#wiki, path);
    });
    return b;
  }

  /** 釘選／取消釘選的按鈕（滑鼠移到列上才出現；已釘選的一直顯示）。 */
  #pinButton(path: string): HTMLButtonElement {
    const pinned = this.#isPinned(path);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wiki-pin";
    b.classList.toggle("pinned", pinned);
    const labels = this.#h.pins?.labels ?? [t("釘選這一頁"), t("取消釘選")];
    const label = pinned ? labels[1] : labels[0];
    b.title = label;
    b.setAttribute("aria-label", label);
    b.setAttribute("aria-pressed", String(pinned));
    b.append(icon(pinned ? "pin-off" : "pin"));
    b.addEventListener("click", () => this.#togglePin(path));
    return b;
  }

  #isPinned(path: string): boolean {
    const pins = this.#h.pins;
    if (pins) return !!this.#wiki && pins.has(this.#wiki, path);
    return this.#prefs.pinned.includes(path);
  }

  /** 釘選在別的地方改了（例如從圖示列移除），重畫釘選按鈕。 */
  refreshPins(): void {
    // 搜尋中不重畫（免得重新搜尋內容），下次重畫時自然更新。
    if (this.#wiki && !this.#input.value.trim()) this.#render();
  }

  #togglePin(path: string): void {
    if (this.#h.pins) {
      if (this.#wiki) this.#h.pins.toggle(this.#wiki, path);
      this.#render();
      return;
    }
    const pinned = this.#prefs.pinned;
    this.#prefs.pinned = pinned.includes(path) ? pinned.filter((p) => p !== path) : [...pinned, path].slice(-PINNED_LIMIT);
    this.#savePrefs();
    this.#render();
  }

  #savePrefs(): void {
    if (this.#wiki) this.#h.savePrefs(this.#wiki.id, this.#prefs);
  }

  /** 樹狀目錄上方的「釘選」與「最近看過」（搜尋時不顯示；已刪除的頁面不列出）。 */
  #renderQuick(show: boolean): void {
    const exists = new Set(flattenPages(this.#pages));
    // 釘選放在別的地方（圖示列）時，面板上只列最近看過。
    const pinned = this.#h.pins ? [] : this.#prefs.pinned.filter((p) => exists.has(p));
    const recent = this.#prefs.recent.filter((p) => exists.has(p) && !pinned.includes(p));
    const groups: HTMLElement[] = [];
    const group = (title: string, paths: string[]) => {
      if (!paths.length) return;
      const box = document.createElement("section");
      const h = document.createElement("h3");
      h.textContent = title;
      const ul = document.createElement("ul");
      for (const path of paths) {
        const li = document.createElement("li");
        li.className = "wiki-row";
        const b = document.createElement("button");
        b.type = "button";
        b.className = "wiki-page";
        b.dataset.path = path;
        b.title = path.slice(1).replaceAll("/", " › ");
        b.draggable = !!(this.#h.link || this.#h.dragData);
        const name = document.createElement("span");
        name.className = "wiki-name";
        name.textContent = pageName(path);
        b.append(name);
        // 只標上一層（完整位置在滑鼠提示裡），一列放得下，清單才整齊。
        const parent = path.slice(0, path.lastIndexOf("/"));
        if (parent) {
          const meta = document.createElement("span");
          meta.className = "wiki-where";
          meta.textContent = pageName(parent);
          b.append(meta);
        }
        if (path === this.#current) b.setAttribute("aria-current", "true");
        b.addEventListener("click", () => {
          if (!this.#wiki) return;
          this.select(path);
          this.#h.open(this.#wiki, path);
        });
        li.append(b, this.#pinButton(path));
        ul.append(li);
      }
      box.append(h, ul);
      groups.push(box);
    };
    group(t("已釘選"), pinned);
    group(t("最近看過"), recent.slice(0, RECENT_LIMIT));
    this.#quick.replaceChildren(...groups);
    this.#quick.hidden = !show || !groups.length;
  }

  #toggle(path: string): void {
    if (this.#expanded.has(path)) this.#expanded.delete(path);
    else this.#expanded.add(path);
    this.#render();
  }

  /** 標示目前開著的頁面（null 表示都沒開）；展開它所在的資料夾，並記到「最近看過」。 */
  select(path: string | null): void {
    this.#current = path;
    if (path && this.#wiki && this.#prefs.recent[0] !== path) {
      this.#prefs.recent = pushRecent(this.#prefs.recent, path, RECENT_LIMIT + PINNED_LIMIT);
      this.#savePrefs();
      if (!this.#input.value.trim()) this.#renderQuick(true);
    }
    if (path) {
      let changed = false;
      for (let i = path.indexOf("/", 1); i > 0; i = path.indexOf("/", i + 1)) {
        const parent = path.slice(0, i);
        if (!this.#expanded.has(parent)) {
          this.#expanded.add(parent);
          changed = true;
        }
      }
      if (changed && !this.#input.value.trim()) this.#render();
    }
    for (const b of [
      ...this.#quick.querySelectorAll<HTMLElement>(".wiki-page"),
      ...this.#list.querySelectorAll<HTMLElement>(".wiki-page"),
      ...this.#content.querySelectorAll<HTMLElement>(".wiki-page"),
    ]) {
      if (b.dataset.path === path) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    }
  }
}
