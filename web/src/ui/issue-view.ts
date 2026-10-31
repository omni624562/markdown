/**
 * 工作項目、GitHub issue 開在主要區域的唯讀檢視（蓋在編輯區與預覽上面，或並排在右邊）：
 * 上方是位置、標題與動作（最常用的一個用文字按鈕，其他用圖示，少用的收在「更多動作」），
 * 內容由預覽同一套流程顯示。Ctrl+F 在內容裡找字，Esc 回到文件。
 * 每一項是分頁列上的一個分頁（app/item-tabs.ts）；這個檢視一次顯示一個，切換分頁時換上那個分頁的狀態。
 */
import { formatKeys } from "../commands.ts";
import { t } from "../i18n.ts";
import { icon } from "./icons.ts";
import { setupMenu } from "./menu.ts";

/** 內容從哪裡來：標頭用顏色、圖示與文字標示（看得出不是本機的檔案）。 */
export interface IssueOrigin {
  kind: "ado" | "github" | "wiki" | "repo";
  icon: string;
  text: string;
}

/** 標頭上的來源標籤（例如「Azure DevOps Wiki」「唯讀」）。 */
export function sourceBadge(text: string, iconName?: string, className = "source-badge"): HTMLElement {
  const b = document.createElement("span");
  b.className = className;
  if (iconName) b.append(icon(iconName));
  b.append(text);
  return b;
}

export interface IssueSource {
  /** 辨認是不是同一個（例如 `ado:123`）。 */
  key: string;
  origin: IssueOrigin;
  /** 標題前面的小字，例如「Bug 123」「#45」。 */
  label: string;
  title: string;
  webUrl: string;
  /** 「複製成 Markdown 文件」的檔名。 */
  fileName: string;
  /** 讀取內容（Markdown）。 */
  load(): Promise<string>;
  /** 標頭上的位置（例如 Wiki 頁面的上層頁面），點一下切換過去；`open` 沒給的只顯示文字。 */
  crumbs?: { label: string; open?(): void }[];
  insertLink(): void;
  /** 標頭下方的操作列（例如工作項目的狀態、指派給我、留言）。 */
  toolbar?: HTMLElement;
  /** 「編輯」：在分頁裡編輯、存回伺服器（不能編輯的不給）。 */
  edit?(): void;
  /** 「修改記錄」（Wiki 頁面）。 */
  history?(): void;
  /** 「新增子頁面」（Wiki 頁面；不能新增的不給）。 */
  addChild?(): void;
  /** 「刪除這一頁」（Wiki 頁面；不能刪除的不給）。 */
  remove?(): void;
  /** 「放到左側圖示列」：有沒有放、放上去或拿掉（不能放的不給）。 */
  shortcut?: { has(): boolean; toggle(): void };
  /** 內容裡的連結（`href` 是原始寫法）：自己處理了就回傳 true，否則用瀏覽器開。 */
  link?(href: string): boolean;
  /** 內容畫好之後調整樣子（例如工作項目比照 TFS 網頁）；每次重畫都會呼叫。 */
  decorate?(body: HTMLElement): void;
  /** 狀態列上顯示的摘要（例如工作項目的狀態、留言數、更新時間）；還沒讀到時回傳空的。 */
  facts?(): IssueFact[];
}

/** 狀態列上的一項摘要。 */
export interface IssueFact {
  text: string;
  /** 滑鼠提示（完整的說明）。 */
  title?: string;
  /** 前面的狀態圓點（`ado-state-dot` 的顏色，例如 `active`、`closed`）。 */
  dot?: string;
}

export interface IssueViewHooks {
  /** 把 Markdown 顯示在 `into`（預覽同一套流程：移除原始 HTML、程式碼上色、圖片處理）。 */
  render(markdown: string, into: HTMLElement): void;
  open(url: string): void;
  copyAsDocument(name: string, markdown: string): void;
  /** 開啟（或上一頁／下一頁切換到）一個項目，內容讀取之前（例如更新側邊欄清單上的標示）。 */
  opened(source: IssueSource): void;
  /** 內容裡的連結（項目自己沒處理時）：例如儲存庫裡的 Markdown 檔，在這裡開啟；處理了就回傳 true。 */
  follow?(href: string): boolean;
  /** 檢視關閉了（例如清掉側邊欄清單上的標示）。 */
  closed(): void;
  /** 按 Esc：回到文件（分頁留著）；沒給時關閉。 */
  dismiss?(): void;
  /** 按標頭的「關閉」：關掉這個分頁；沒給時關閉檢視。 */
  closeTab?(): void;
  /** 切換「和編輯區並排顯示」。 */
  toggleSide?(): void;
  /** 狀態列上的摘要換了（關閉時是空的）。 */
  facts?(list: IssueFact[]): void;
  /** 本機的離線副本：讀到內容就存一份，連不上時拿來顯示。 */
  offline?: IssueOffline;
}

export interface IssueOffline {
  save(source: IssueSource, markdown: string): void;
  load(source: IssueSource): Promise<{ markdown: string; savedAt: number } | null>;
  /** 有沒有「保留離線」；不能保留的（沒辦法在背景更新）回傳 null，不顯示按鈕。 */
  kept(source: IssueSource): boolean | null;
  /** 切換「保留離線」（`markdown` 是目前顯示的內容）。 */
  toggle(source: IssueSource, markdown: string): void;
}

export interface FindMatch {
  node: Text;
  start: number;
  end: number;
}

/** 在文字節點裡找出所有符合（不分大小寫）。 */
export function findMatches(nodes: Text[], query: string): FindMatch[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const out: FindMatch[] = [];
  for (const node of nodes) {
    const text = (node.nodeValue ?? "").toLowerCase();
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
      out.push({ node, start: i, end: i + q.length });
    }
  }
  return out;
}

function iconButton(label: string, iconName: string, run: () => void, keys?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn icon-only";
  b.title = keys ? t("{label}（{keys}）", { label, keys: formatKeys(keys) }) : label;
  b.setAttribute("aria-label", label);
  b.append(icon(iconName));
  b.addEventListener("click", run);
  return b;
}

/** 支援 CSS Custom Highlight API 時用它標示（不改動內容的 DOM）。 */
const highlights = typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null;

interface HistoryEntry {
  source: IssueSource;
  scroll: number;
}

/** 一個分頁的狀態：顯示的內容、上一頁與下一頁、捲動位置（切換分頁時存下、換回來時還原）。 */
export interface IssueViewState {
  source: IssueSource;
  back: HistoryEntry[];
  forward: HistoryEntry[];
  scroll: number;
}

/** 上一頁、下一頁各記住幾筆。 */
const HISTORY_LIMIT = 50;
/** 記住最近看過幾份內容（上一頁、下一頁、重新開啟時先顯示，背景再更新）。 */
const CACHE_LIMIT = 30;

export class IssueView {
  #workspace: HTMLElement;
  #h: IssueViewHooks;
  #pane: HTMLElement;
  #meta: HTMLElement;
  #label: HTMLElement;
  #title: HTMLElement;
  #body: HTMLElement;
  #scroll: HTMLElement;
  #find: HTMLElement;
  #toolbar: HTMLElement;
  #findInput: HTMLInputElement;
  #findCount: HTMLElement;
  #source: IssueSource | null = null;
  #markdown = "";
  #seq = 0;
  /** 上一頁、下一頁（記住捲動位置）。 */
  #back: HistoryEntry[] = [];
  #forward: HistoryEntry[] = [];
  #restoreScroll: number | null = null;
  #failed = false;
  /** 看過的內容（key → Markdown），最近看的放最後面。 */
  #cache = new Map<string, string>();
  /** 顯示的是之前讀到的內容、這次更新失敗時的提示。 */
  #stale: HTMLElement;
  #backBtn: HTMLButtonElement;
  #forwardBtn: HTMLButtonElement;
  /** 「保留離線」。 */
  #insertBtn: HTMLButtonElement;
  #editBtn: HTMLButtonElement;
  #historyBtn: HTMLButtonElement;
  #sideBtn: HTMLButtonElement | null = null;
  #matches: FindMatch[] = [];
  #current = 0;

  constructor(workspace: HTMLElement, hooks: IssueViewHooks) {
    this.#workspace = workspace;
    this.#h = hooks;
    const pane = document.createElement("section");
    pane.className = "pane issue-pane";
    pane.hidden = true;
    pane.setAttribute("aria-label", t("工作項目內容"));
    pane.tabIndex = -1;

    const head = document.createElement("header");
    head.className = "issue-head";
    const heading = document.createElement("div");
    heading.className = "issue-heading";
    this.#meta = document.createElement("div");
    this.#meta.className = "issue-meta";
    this.#label = document.createElement("span");
    this.#label.className = "issue-label";
    this.#title = document.createElement("h2");
    this.#title.className = "issue-title";
    heading.append(this.#meta, this.#title);
    const nav = document.createElement("div");
    nav.className = "issue-nav";
    this.#backBtn = iconButton(t("返回上一頁"), "arrow-left", () => this.back(), "Alt-←");
    this.#forwardBtn = iconButton(t("前往下一頁"), "arrow-right", () => this.forward(), "Alt-→");
    nav.append(this.#backBtn, this.#forwardBtn);
    const actions = document.createElement("div");
    actions.className = "issue-actions";
    // 主要動作：能編輯的（Wiki 頁面）是「編輯」，其他是「插入連結」；樣式在 #open 依內容切換。
    this.#insertBtn = document.createElement("button");
    this.#insertBtn.type = "button";
    this.#insertBtn.addEventListener("click", () => this.#source?.insertLink());
    this.#editBtn = document.createElement("button");
    this.#editBtn.type = "button";
    this.#editBtn.className = "btn btn-small btn-primary";
    this.#editBtn.append(icon("pencil"), t("編輯"));
    this.#editBtn.title = t("在分頁裡編輯，按 Ctrl+S 存回伺服器");
    this.#editBtn.hidden = true;
    this.#editBtn.addEventListener("click", () => this.#source?.edit?.());
    this.#historyBtn = iconButton(t("修改記錄：誰、什麼時候改了這一頁，改了什麼"), "history", () => this.#source?.history?.());
    this.#historyBtn.hidden = true;
    const more = iconButton(t("更多動作"), "ellipsis", () => {});
    more.id = "issue-more";
    setupMenu(more, null, [
      {
        label: t("新增子頁面"),
        icon: "file-plus",
        when: () => !!this.#source?.addChild,
        run: () => this.#source?.addChild?.(),
      },
      {
        label: t("放到左側圖示列"),
        icon: "pin",
        when: () => !!this.#source?.shortcut,
        checked: () => !!this.#source?.shortcut?.has(),
        run: () => this.#source?.shortcut?.toggle(),
      },
      {
        label: t("複製成 Markdown 文件"),
        icon: "copy",
        run: () => {
          if (this.#source && this.#markdown) this.#h.copyAsDocument(this.#source.fileName, this.#markdown);
        },
      },
      {
        label: t("刪除這一頁…"),
        icon: "trash",
        when: () => !!this.#source?.remove,
        run: () => this.#source?.remove?.(),
      },
      {
        label: t("保留離線"),
        icon: "download",
        when: () => this.#kept() !== null,
        checked: () => !!this.#kept(),
        run: () => {
          if (this.#source && this.#markdown) this.#h.offline?.toggle(this.#source, this.#markdown);
        },
      },
    ]);
    const toggleSide = hooks.toggleSide;
    if (toggleSide) {
      this.#sideBtn = iconButton(t("在文件右邊並排顯示"), "columns-2", () => toggleSide());
      this.#sideBtn.classList.add("issue-side-toggle");
      this.#sideBtn.setAttribute("aria-pressed", "false");
    }
    const sep = document.createElement("span");
    sep.className = "issue-actions-sep";
    sep.setAttribute("aria-hidden", "true");
    actions.append(
      this.#editBtn,
      this.#insertBtn,
      this.#historyBtn,
      iconButton(t("在瀏覽器開啟"), "external-link", () => this.#source && this.#h.open(this.#source.webUrl)),
      more,
      sep,
      ...(this.#sideBtn ? [this.#sideBtn] : []),
      iconButton(t("在內容裡找字"), "search", () => this.openFind(), "Mod-f"),
      iconButton(t("重新整理"), "refresh-cw", () => void this.refresh()),
      iconButton(t("關閉分頁"), "x", () => (hooks.closeTab ? hooks.closeTab() : this.close())),
    );
    head.append(nav, heading, actions);

    this.#find = document.createElement("div");
    this.#find.className = "issue-find";
    this.#find.hidden = true;
    this.#findInput = document.createElement("input");
    this.#findInput.type = "search";
    this.#findInput.placeholder = t("在內容裡找字");
    this.#findInput.setAttribute("aria-label", t("在內容裡找字"));
    this.#findInput.addEventListener("input", () => this.#search());
    this.#findCount = document.createElement("span");
    this.#findCount.className = "issue-find-count";
    this.#findCount.setAttribute("aria-live", "polite");
    this.#find.append(
      this.#findInput,
      this.#findCount,
      iconButton(t("上一個"), "arrow-up", () => this.#step(-1), "Shift-Enter"),
      iconButton(t("下一個"), "arrow-down", () => this.#step(1), "Enter"),
      iconButton(t("關閉找字"), "x", () => this.#closeFind()),
    );

    this.#scroll = document.createElement("div");
    this.#scroll.className = "issue-scroll";
    this.#body = document.createElement("article");
    this.#body.className = "markdown-body issue-body";
    this.#stale = document.createElement("p");
    this.#stale.className = "issue-status issue-stale";
    this.#stale.hidden = true;
    this.#scroll.append(this.#stale, this.#body);
    // 內容裡的連結用瀏覽器開，不要把整個視窗導走。
    // 流程圖裡的連結是 SVG 的 <a xlink:href>，`a[href]` 選不到，所以任何 <a> 都要攔下來。
    this.#body.addEventListener("click", (e) => {
      const a = (e.target as Element).closest("a");
      if (!a) return;
      e.preventDefault();
      const raw = a.getAttribute("href") ?? a.getAttributeNS("http://www.w3.org/1999/xlink", "href");
      if (!raw) return;
      if (this.#source?.link?.(raw)) return;
      let href: string;
      try {
        href = new URL(raw, document.baseURI).href;
      } catch {
        return;
      }
      if (this.#h.follow?.(href)) return;
      if (/^https?:/i.test(href)) this.#h.open(href);
    });
    this.#toolbar = document.createElement("div");
    this.#toolbar.className = "issue-toolbar-host";
    this.#toolbar.hidden = true;
    pane.append(head, this.#toolbar, this.#find, this.#scroll);
    pane.addEventListener("keydown", (e) => this.#keydown(e));
    // 滑鼠的「上一頁」「下一頁」側鍵。
    pane.addEventListener("mouseup", (e) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.button === 3) this.back();
      else this.forward();
    });
    workspace.querySelector(".outline-right")?.before(pane) ?? workspace.append(pane);
    this.#pane = pane;
  }

  get isOpen(): boolean {
    return !this.#pane.hidden;
  }

  /** 焦點在這個檢視裡（並排顯示時，用來分辨 Ctrl+F 要在哪邊找）。 */
  get hasFocus(): boolean {
    return this.#pane.contains(document.activeElement);
  }

  /** 更新「並排顯示」按鈕：並排時按一下改成佔滿整個區域，否則改成並排在文件右邊。 */
  setSide(on: boolean): void {
    if (!this.#sideBtn) return;
    const label = on ? t("佔滿整個區域（不和文件並排）") : t("在文件右邊並排顯示");
    this.#sideBtn.title = label;
    this.#sideBtn.setAttribute("aria-label", label);
    this.#sideBtn.replaceChildren(icon(on ? "maximize-2" : "columns-2"));
  }

  /** 目前分頁的狀態（切換到別的分頁前存下）；沒有開著時回傳 null。 */
  snapshot(): IssueViewState | null {
    if (!this.#source) return null;
    return { source: this.#source, back: [...this.#back], forward: [...this.#forward], scroll: this.#scroll.scrollTop };
  }

  /** 換上一個分頁的狀態（看過的內容先顯示在原本的捲動位置，背景再更新）。 */
  async restore(state: IssueViewState): Promise<void> {
    this.#seq++;
    this.#back = [...state.back];
    this.#forward = [...state.forward];
    this.#restoreScroll = state.scroll;
    await this.#open(state.source);
  }

  /** 開啟（或切換到）一個工作項目、issue、Wiki 頁面；原本開著的記到「上一頁」。 */
  async show(source: IssueSource): Promise<void> {
    if (this.#source && this.#source.key !== source.key) {
      this.#remember(this.#back);
      this.#forward = [];
    }
    await this.#open(source);
  }

  back(): void {
    this.#go(this.#back, this.#forward);
  }

  forward(): void {
    this.#go(this.#forward, this.#back);
  }

  #go(from: HistoryEntry[], to: HistoryEntry[]): void {
    const entry = from.pop();
    if (!entry || !this.#source) return;
    this.#remember(to);
    this.#restoreScroll = entry.scroll;
    void this.#open(entry.source);
  }

  #remember(list: HistoryEntry[]): void {
    if (!this.#source) return;
    list.push({ source: this.#source, scroll: this.#scroll.scrollTop });
    if (list.length > HISTORY_LIMIT) list.shift();
  }

  #updateNav(): void {
    this.#backBtn.disabled = !this.#back.length;
    this.#forwardBtn.disabled = !this.#forward.length;
    const title = (list: HistoryEntry[]) => list[list.length - 1]?.source.title;
    const label = (name: string, list: HistoryEntry[], keys: string) =>
      list.length
        ? t("{label}：{title}（{keys}）", { label: name, title: title(list)!, keys: formatKeys(keys) })
        : t("{label}（{keys}）", { label: name, keys: formatKeys(keys) });
    this.#backBtn.title = label(t("返回上一頁"), this.#back, "Alt-←");
    this.#forwardBtn.title = label(t("前往下一頁"), this.#forward, "Alt-→");
  }

  /** 有沒有「保留離線」；不能保留的回傳 null（「更多動作」裡不列出）。 */
  #kept(): boolean | null {
    return this.#source ? (this.#h.offline?.kept(this.#source) ?? null) : null;
  }

  /** 標頭上的位置：「P.wiki › 產品 › 安裝」，上層頁面可以點。 */
  #crumbs(source: IssueSource): (string | HTMLElement)[] {
    if (!source.crumbs?.length) return [source.label];
    const out: (string | HTMLElement)[] = [];
    source.crumbs.forEach((c, i) => {
      if (i) {
        const sep = document.createElement("span");
        sep.className = "issue-crumb-sep";
        sep.setAttribute("aria-hidden", "true");
        sep.textContent = "›";
        out.push(sep);
      }
      if (c.open) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "issue-crumb";
        b.textContent = c.label;
        b.title = t("開啟「{name}」", { name: c.label });
        const open = c.open;
        b.addEventListener("click", () => open());
        out.push(b);
      } else {
        const span = document.createElement("span");
        span.textContent = c.label;
        out.push(span);
      }
    });
    return out;
  }

  async #open(source: IssueSource): Promise<void> {
    this.#source = source;
    this.#h.opened(source);
    this.#h.facts?.([]);
    this.#updateNav();
    this.#pane.dataset.source = source.origin.kind;
    this.#pane.dataset.sourceName = source.origin.text;
    this.#label.replaceChildren(...this.#crumbs(source));
    // 來源只用一個圖示標示（狀態列和上方的色條也標了來源與「唯讀」），位置一列放完。
    const origin = document.createElement("span");
    origin.className = "issue-origin";
    origin.title = source.origin.text;
    origin.setAttribute("aria-label", source.origin.text);
    origin.append(icon(source.origin.icon));
    this.#meta.replaceChildren(origin, this.#label);
    this.#title.textContent = source.title;
    this.#title.title = source.title;
    this.#toolbar.replaceChildren(...(source.toolbar ? [source.toolbar] : []));
    this.#toolbar.hidden = !source.toolbar;
    this.#editBtn.hidden = !source.edit;
    this.#historyBtn.hidden = !source.history;
    // 有「編輯」時，「插入連結」退成圖示按鈕。
    const label = t("插入連結");
    this.#insertBtn.className = source.edit ? "btn icon-only" : "btn btn-small btn-primary";
    this.#insertBtn.replaceChildren(icon("link"), ...(source.edit ? [] : [label]));
    this.#insertBtn.title = t("在目前的文件插入連到這裡的連結");
    this.#insertBtn.setAttribute("aria-label", label);
    this.#pane.hidden = false;
    this.#workspace.classList.add("issue-open");
    this.#closeFind();
    this.#pane.focus();
    await this.refresh(true);
  }

  /**
   * 向伺服器重新讀取內容。`quiet`：看過的內容先顯示出來，背景讀取，有變動才重畫（捲動位置不變）；
   * 否則先清掉、顯示「讀取中…」（按「重新整理」時）。
   */
  async refresh(quiet = false): Promise<void> {
    const source = this.#source;
    if (!source) return;
    const seq = ++this.#seq;
    const cached = quiet ? this.#cache.get(source.key) : undefined;
    this.#failed = false;
    this.#stale.hidden = true;
    let loading: HTMLElement | null = null;
    if (cached !== undefined) {
      this.#display(cached);
    } else {
      this.#markdown = "";
      loading = document.createElement("p");
      loading.className = "issue-status";
      loading.textContent = t("讀取中…");
      this.#body.replaceChildren(loading);
    }
    try {
      const md = await source.load();
      if (seq !== this.#seq) return;
      this.#cache.delete(source.key);
      this.#cache.set(source.key, md);
      if (this.#cache.size > CACHE_LIMIT) this.#cache.delete(this.#cache.keys().next().value!);
      if (md !== this.#markdown || loading) this.#display(md, cached !== undefined);
      // 內容沒變也要更新摘要（例如「更新於幾分鐘前」）。
      else this.#h.facts?.(source.facts?.() ?? []);
      this.#h.offline?.save(source, md);
    } catch (e) {
      if (seq !== this.#seq) return;
      const message = e instanceof Error ? e.message : String(e);
      // 這次還沒顯示任何內容：有離線副本就先顯示副本。
      const copy = loading ? await this.#h.offline?.load(source).catch(() => null) : null;
      if (seq !== this.#seq) return;
      if (copy) {
        this.#display(copy.markdown);
        loading = null;
      }
      const target = loading ?? this.#stale;
      target.textContent = loading
        ? message
        : copy
          ? t("顯示的是 {time} 存下的離線副本，這次讀取失敗：{message}", { time: new Date(copy.savedAt).toLocaleString(), message })
          : t("顯示的是之前讀到的內容，這次更新失敗：{message}", { message });
      target.classList.add("issue-error");
      target.hidden = false;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn btn-small load-retry";
      retry.append(icon("refresh-cw"), t("重試"));
      retry.addEventListener("click", () => void this.refresh(!loading));
      target.append(retry);
      this.#failed = true;
    }
  }

  /** 顯示內容；`keepScroll`：背景更新時留在原本的位置，否則回到記住的位置（或最上面）。 */
  #display(md: string, keepScroll = false): void {
    const top = this.#scroll.scrollTop;
    this.#markdown = md;
    this.#h.render(md, this.#body);
    this.#decorate();
    this.#h.facts?.(this.#source?.facts?.() ?? []);
    this.#scroll.scrollTop = keepScroll ? top : (this.#restoreScroll ?? 0);
    if (!keepScroll) this.#restoreScroll = null;
    if (!this.#find.hidden) this.#search();
  }

  /** 上次讀取失敗就重新讀取（網路恢復、切回視窗時呼叫）；有之前讀到的內容就留著，背景更新。 */
  retryFailed(): void {
    if (this.isOpen && this.#failed) void this.refresh(true);
  }

  /** 用已經讀到的內容重畫（主題或設定改變時，不用重新向伺服器讀取）。 */
  rerender(): void {
    if (this.isOpen && this.#markdown) {
      this.#h.render(this.#markdown, this.#body);
      this.#decorate();
    }
  }

  #decorate(): void {
    this.#source?.decorate?.(this.#body);
  }

  close(): void {
    if (!this.isOpen) return;
    this.#seq++;
    this.#closeFind();
    this.#pane.hidden = true;
    this.#workspace.classList.remove("issue-open");
    this.#source = null;
    this.#back = [];
    this.#forward = [];
    this.#restoreScroll = null;
    this.#body.replaceChildren();
    this.#h.facts?.([]);
    this.#h.closed();
  }

  /** 開啟找字列（Ctrl+F）。 */
  openFind(): void {
    this.#find.hidden = false;
    const selected = getSelection()?.toString().trim();
    if (selected && !selected.includes("\n") && this.#body.contains(getSelection()?.anchorNode ?? null)) {
      this.#findInput.value = selected;
    }
    this.#findInput.focus();
    this.#findInput.select();
    this.#search();
  }

  #closeFind(): void {
    this.#find.hidden = true;
    this.#matches = [];
    highlights?.delete("issue-find");
    highlights?.delete("issue-find-current");
  }

  #keydown(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (!this.#find.hidden) {
        this.#closeFind();
        this.#pane.focus();
      } else if (this.#h.dismiss) this.#h.dismiss();
      else this.close();
    } else if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      if (e.key === "ArrowLeft") this.back();
      else this.forward();
    } else if (e.key === "Enter" && e.target === this.#findInput) {
      e.preventDefault();
      this.#step(e.shiftKey ? -1 : 1);
    }
  }

  #textNodes(): Text[] {
    const out: Text[] = [];
    const walker = document.createTreeWalker(this.#body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
    return out;
  }

  #search(): void {
    this.#matches = findMatches(this.#textNodes(), this.#findInput.value.trim());
    this.#current = 0;
    this.#paint();
  }

  #step(delta: number): void {
    const n = this.#matches.length;
    if (!n) return;
    this.#current = (this.#current + delta + n) % n;
    this.#paint();
  }

  #range(m: FindMatch): Range {
    const r = document.createRange();
    r.setStart(m.node, m.start);
    r.setEnd(m.node, m.end);
    return r;
  }

  #paint(): void {
    const n = this.#matches.length;
    const q = this.#findInput.value.trim();
    this.#findCount.textContent = !q ? "" : n ? t("{current}／{total}", { current: this.#current + 1, total: n }) : t("沒有結果");
    this.#findCount.classList.toggle("issue-find-none", !!q && !n);
    if (!highlights) return;
    if (!n) {
      highlights.delete("issue-find");
      highlights.delete("issue-find-current");
      return;
    }
    // 目前的符合處在收合的區塊（<details>）裡：展開，才看得到、捲得過去。
    for (let el = this.#matches[this.#current].node.parentElement; el; el = el.parentElement) {
      if (el instanceof HTMLDetailsElement && !el.open) el.open = true;
      // 只顯示前面一段的長內容（例如很長的留言）：整段打開。
      if (el.classList.contains("clamped")) {
        el.classList.remove("clamped");
        if (el.nextElementSibling?.classList.contains("clamp-more")) el.nextElementSibling.remove();
      }
      if (el === this.#body) break;
    }
    const ranges = this.#matches.map((m) => this.#range(m));
    highlights.set("issue-find", new Highlight(...ranges));
    const current = ranges[this.#current];
    highlights.set("issue-find-current", new Highlight(current));
    // 捲到目前的符合處（放在可視範圍中間）。
    const box = current.getBoundingClientRect();
    const view = this.#scroll.getBoundingClientRect();
    if (box.top < view.top + 40 || box.bottom > view.bottom - 40) {
      this.#scroll.scrollTop += box.top - view.top - view.height / 2;
    }
  }
}
