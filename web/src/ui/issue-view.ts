/**
 * 工作項目、GitHub issue 開在主要區域的唯讀檢視（蓋在編輯區與預覽上面）：
 * 上方是標題與動作（插入連結、在瀏覽器開啟、重新整理、複製成 Markdown 文件、找字），
 * 內容由預覽同一套流程顯示。Ctrl+F 在內容裡找字，Esc 關閉。
 */
import { formatKeys } from "../commands.ts";
import { t } from "../i18n.ts";
import { icon } from "./icons.ts";

export interface IssueSource {
  /** 辨認是不是同一個（例如 `ado:123`）。 */
  key: string;
  /** 標題前面的小字，例如「Bug 123」「#45」。 */
  label: string;
  title: string;
  webUrl: string;
  /** 「複製成 Markdown 文件」的檔名。 */
  fileName: string;
  /** 讀取內容（Markdown）。 */
  load(): Promise<string>;
  insertLink(): void;
  /** 內容裡的連結（`href` 是原始寫法）：自己處理了就回傳 true，否則用瀏覽器開。 */
  link?(href: string): boolean;
}

export interface IssueViewHooks {
  /** 把 Markdown 顯示在 `into`（預覽同一套流程：移除原始 HTML、程式碼上色、圖片處理）。 */
  render(markdown: string, into: HTMLElement): void;
  open(url: string): void;
  copyAsDocument(name: string, markdown: string): void;
  /** 檢視關閉了（例如清掉側邊欄清單上的標示）。 */
  closed(): void;
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

export class IssueView {
  #workspace: HTMLElement;
  #h: IssueViewHooks;
  #pane: HTMLElement;
  #label: HTMLElement;
  #title: HTMLElement;
  #body: HTMLElement;
  #scroll: HTMLElement;
  #find: HTMLElement;
  #findInput: HTMLInputElement;
  #findCount: HTMLElement;
  #source: IssueSource | null = null;
  #markdown = "";
  #seq = 0;
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
    this.#label = document.createElement("span");
    this.#label.className = "issue-label";
    this.#title = document.createElement("h2");
    this.#title.className = "issue-title";
    heading.append(this.#label, this.#title);
    const actions = document.createElement("div");
    actions.className = "issue-actions";
    const insert = document.createElement("button");
    insert.type = "button";
    insert.className = "btn btn-small btn-primary";
    insert.append(icon("link"), t("插入連結"));
    insert.addEventListener("click", () => this.#source?.insertLink());
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "btn btn-small";
    copy.append(icon("file-plus"), t("複製成 Markdown 文件"));
    copy.title = t("開成一份可以編輯的 Markdown 分頁（修改不會回寫到伺服器）");
    copy.addEventListener("click", () => {
      if (this.#source && this.#markdown) this.#h.copyAsDocument(this.#source.fileName, this.#markdown);
    });
    actions.append(
      insert,
      copy,
      iconButton(t("在內容裡找字"), "search", () => this.openFind(), "Mod-f"),
      iconButton(t("重新整理"), "refresh-cw", () => void this.refresh()),
      iconButton(t("在瀏覽器開啟"), "external-link", () => this.#source && this.#h.open(this.#source.webUrl)),
      iconButton(t("關閉"), "x", () => this.close(), "Escape"),
    );
    head.append(heading, actions);

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
    this.#scroll.append(this.#body);
    // 內容裡的連結用瀏覽器開，不要把整個視窗導走。
    this.#body.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
      if (!a) return;
      e.preventDefault();
      if (this.#source?.link?.(a.getAttribute("href")!)) return;
      if (/^https?:/i.test(a.href)) this.#h.open(a.href);
    });
    pane.append(head, this.#find, this.#scroll);
    pane.addEventListener("keydown", (e) => this.#keydown(e));
    workspace.querySelector(".outline-right")?.before(pane) ?? workspace.append(pane);
    this.#pane = pane;
  }

  get isOpen(): boolean {
    return !this.#pane.hidden;
  }

  /** 開啟（或切換到）一個工作項目、issue。 */
  async show(source: IssueSource): Promise<void> {
    this.#source = source;
    this.#label.textContent = source.label;
    this.#title.textContent = source.title;
    this.#pane.hidden = false;
    this.#workspace.classList.add("issue-open");
    this.#closeFind();
    this.#pane.focus();
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const source = this.#source;
    if (!source) return;
    const seq = ++this.#seq;
    this.#markdown = "";
    const loading = document.createElement("p");
    loading.className = "issue-status";
    loading.textContent = t("讀取中…");
    this.#body.replaceChildren(loading);
    try {
      const md = await source.load();
      if (seq !== this.#seq) return;
      this.#markdown = md;
      this.#h.render(md, this.#body);
      this.#scroll.scrollTop = 0;
      if (!this.#find.hidden) this.#search();
    } catch (e) {
      if (seq !== this.#seq) return;
      loading.textContent = e instanceof Error ? e.message : String(e);
      loading.classList.add("issue-error");
    }
  }

  close(): void {
    if (!this.isOpen) return;
    this.#seq++;
    this.#closeFind();
    this.#pane.hidden = true;
    this.#workspace.classList.remove("issue-open");
    this.#source = null;
    this.#body.replaceChildren();
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
      } else this.close();
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
