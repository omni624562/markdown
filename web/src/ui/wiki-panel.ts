/**
 * 側邊欄的 Azure DevOps Wiki：選一個 Wiki、看頁面樹狀目錄（可以搜尋頁面名稱），
 * 點一下頁面在主要區域以唯讀方式開啟。
 */
import { t } from "../i18n.ts";
import { flattenPages, pageName, pushRecent } from "../wiki-text.ts";
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

export class WikiPanel<W extends WikiInfo> {
  #h: WikiPanelHooks<W>;
  #select: HTMLSelectElement;
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
    bar.append(this.#select);
    this.#input = document.createElement("input");
    this.#input.type = "search";
    this.#input.className = "workitems-search";
    this.#input.placeholder = t("搜尋頁面名稱");
    this.#input.setAttribute("aria-label", t("搜尋頁面名稱"));
    this.#input.addEventListener("input", () => this.#render());
    this.#status = document.createElement("p");
    this.#status.className = "workitems-status";
    this.#list = document.createElement("ul");
    this.#list.className = "wiki-tree";
    this.#list.setAttribute("role", "tree");
    this.#quick = document.createElement("div");
    this.#quick.className = "wiki-quick";
    this.#quick.hidden = true;
    el.append(bar, this.#input, this.#status, this.#quick, this.#list);
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
    this.#prefs = wiki ? this.#h.prefs(wiki.id) : { recent: [], pinned: [] };
    this.#list.replaceChildren();
    this.#quick.hidden = true;
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
      return;
    }
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
    li.append(toggle, b, this.#pinButton(page.path));
    return li;
  }

  /** 釘選／取消釘選的按鈕（滑鼠移到列上才出現；已釘選的一直顯示）。 */
  #pinButton(path: string): HTMLButtonElement {
    const pinned = this.#prefs.pinned.includes(path);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wiki-pin";
    b.classList.toggle("pinned", pinned);
    const label = pinned ? t("取消釘選") : t("釘選這一頁");
    b.title = label;
    b.setAttribute("aria-label", label);
    b.setAttribute("aria-pressed", String(pinned));
    b.append(icon(pinned ? "pin-off" : "pin"));
    b.addEventListener("click", () => this.#togglePin(path));
    return b;
  }

  #togglePin(path: string): void {
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
    const pinned = this.#prefs.pinned.filter((p) => exists.has(p));
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
        b.title = path;
        const name = document.createElement("span");
        name.className = "wiki-name";
        name.textContent = pageName(path);
        b.append(name);
        const where = path.slice(1, path.lastIndexOf("/"));
        if (where) {
          const meta = document.createElement("span");
          meta.className = "wiki-where";
          meta.textContent = where;
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
    for (const b of [...this.#quick.querySelectorAll<HTMLElement>(".wiki-page"), ...this.#list.querySelectorAll<HTMLElement>(".wiki-page")]) {
      if (b.dataset.path === path) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    }
  }
}
