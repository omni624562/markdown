/**
 * 側邊欄的議題清單：Azure DevOps 的工作項目、GitHub 的 Issues 共用。
 * 可以搜尋標題或輸入編號；點一下看內容，再插入連結到文件或在瀏覽器開啟。
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

export interface IssueSection {
  title: string;
  text: string;
}

export interface IssueDetail {
  /** 補在標題下方的資訊，例如「指派給 王小明」。 */
  meta: string;
  sections: IssueSection[];
}

export interface IssuesHandlers<T extends IssueSummary> {
  list(search: string): Promise<T[]>;
  detail(item: T): Promise<IssueDetail>;
  insert(item: T): void;
  open(url: string): void;
  /** 狀態列文字：`count` 是結果數量，`search` 是搜尋文字（空白表示預設清單）。 */
  status(count: number, search: string): string;
  placeholder: string;
}

/** HTML 轉成純文字顯示（在不會執行程式、不會載入圖片的文件裡解析）。 */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll("script, style, template")) el.remove();
  for (const br of doc.querySelectorAll("br")) br.replaceWith("\n");
  for (const el of doc.querySelectorAll("p, div, li, tr, h1, h2, h3, h4, h5, h6")) el.append("\n");
  for (const li of doc.querySelectorAll("li")) li.prepend("・");
  return (doc.body.textContent ?? "").replace(/ /g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** 「10/20」這樣的短日期。 */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getMonth() + 1}/${d.getDate()}`;
}

export class IssuesPanel<T extends IssueSummary> {
  #el: HTMLElement;
  #h: IssuesHandlers<T>;
  #input: HTMLInputElement;
  #status: HTMLElement;
  #list: HTMLUListElement;
  #detail: HTMLElement;
  #seq = 0;
  #timer = 0;
  #loaded = false;

  constructor(el: HTMLElement, handlers: IssuesHandlers<T>) {
    this.#el = el;
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
    this.#detail = document.createElement("div");
    this.#detail.className = "workitems-detail";
    this.#detail.hidden = true;
    el.append(this.#input, this.#status, this.#list, this.#detail);
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
    this.#showList();
  }

  async refresh(): Promise<void> {
    this.#loaded = true;
    this.#showList();
    const seq = ++this.#seq;
    const search = this.#input.value.trim();
    this.#status.textContent = t("讀取中…");
    try {
      const items = await this.#h.list(search);
      if (seq !== this.#seq) return;
      this.#status.textContent = this.#h.status(items.length, search);
      this.#list.replaceChildren(...items.map((it) => this.#row(it)));
    } catch (e) {
      if (seq !== this.#seq) return;
      this.#status.textContent = e instanceof Error ? e.message : String(e);
      this.#list.replaceChildren();
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
    top.textContent = item.meta;
    const title = document.createElement("span");
    title.className = "workitem-title";
    title.textContent = item.title;
    b.append(top, title);
    b.addEventListener("click", () => void this.#open(item));
    li.append(b);
    return li;
  }

  #showList(): void {
    this.#detail.hidden = true;
    this.#detail.replaceChildren();
    this.#input.hidden = false;
    this.#status.hidden = false;
    this.#list.hidden = false;
  }

  async #open(item: T): Promise<void> {
    this.#input.hidden = true;
    this.#status.hidden = true;
    this.#list.hidden = true;
    this.#detail.hidden = false;
    const seq = ++this.#seq;

    const back = document.createElement("button");
    back.type = "button";
    back.className = "btn btn-small workitems-back";
    back.append(icon("arrow-left"), t("返回清單"));
    back.addEventListener("click", () => {
      this.#seq++;
      this.#showList();
      this.#el.querySelector<HTMLElement>(".workitem")?.focus();
    });
    const h = document.createElement("h3");
    h.textContent = item.title;
    const meta = document.createElement("p");
    meta.className = "workitem-meta";
    meta.textContent = item.meta;
    const actions = document.createElement("div");
    actions.className = "workitems-actions";
    const insert = document.createElement("button");
    insert.type = "button";
    insert.className = "btn btn-small btn-primary";
    insert.append(icon("link"), t("插入連結"));
    insert.title = t("在文件的游標位置插入 [#{id} 標題](網址)", { id: item.id });
    insert.addEventListener("click", () => this.#h.insert(item));
    const open = document.createElement("button");
    open.type = "button";
    open.className = "btn btn-small";
    open.append(icon("external-link"), t("在瀏覽器開啟"));
    open.addEventListener("click", () => this.#h.open(item.webUrl));
    actions.append(insert, open);
    const body = document.createElement("div");
    body.className = "workitem-body";
    body.textContent = t("讀取中…");
    this.#detail.replaceChildren(back, h, meta, actions, body);
    back.focus();

    try {
      const d = await this.#h.detail(item);
      if (seq !== this.#seq) return;
      if (d.meta) meta.textContent += `・${d.meta}`;
      const parts: HTMLElement[] = [];
      for (const s of d.sections) {
        if (!s.text.trim()) continue;
        const heading = document.createElement("h4");
        heading.textContent = s.title;
        const p = document.createElement("p");
        p.className = "workitem-text";
        p.textContent = s.text.trim();
        parts.push(heading, p);
      }
      if (!parts.length) {
        const p = document.createElement("p");
        p.className = "workitems-status";
        p.textContent = t("沒有說明");
        parts.push(p);
      }
      body.replaceChildren(...parts);
    } catch (e) {
      if (seq !== this.#seq) return;
      body.textContent = e instanceof Error ? e.message : String(e);
    }
  }
}
