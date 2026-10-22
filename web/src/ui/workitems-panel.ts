/**
 * 側邊欄的「工作項目」（Azure DevOps）：列出指派給我、還沒結束的工作項目，
 * 可以搜尋標題或輸入編號；點一下看內容，再插入連結到文件或在瀏覽器開啟。
 */
import type { AdoWorkItem, AdoWorkItemDetail } from "../desktop.ts";
import { icon } from "./icons.ts";

export interface WorkItemsHandlers {
  list(search: string): Promise<AdoWorkItem[]>;
  detail(id: number): Promise<AdoWorkItemDetail>;
  insert(item: AdoWorkItem): void;
  open(url: string): void;
}

/** 工作項目的說明是 HTML：轉成純文字顯示（在不會執行程式、不會載入圖片的文件裡解析）。 */
function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll("script, style, template")) el.remove();
  for (const br of doc.querySelectorAll("br")) br.replaceWith("\n");
  for (const el of doc.querySelectorAll("p, div, li, tr, h1, h2, h3, h4, h5, h6")) el.append("\n");
  for (const li of doc.querySelectorAll("li")) li.prepend("・");
  return (doc.body.textContent ?? "").replace(/ /g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getMonth() + 1}/${d.getDate()}`;
}

export class WorkItemsPanel {
  #el: HTMLElement;
  #h: WorkItemsHandlers;
  #input: HTMLInputElement;
  #status: HTMLElement;
  #list: HTMLUListElement;
  #detail: HTMLElement;
  #seq = 0;
  #timer = 0;
  #loaded = false;

  constructor(el: HTMLElement, handlers: WorkItemsHandlers) {
    this.#el = el;
    this.#h = handlers;
    el.classList.add("workitems");
    this.#input = document.createElement("input");
    this.#input.type = "search";
    this.#input.className = "workitems-search";
    this.#input.placeholder = "搜尋標題，或輸入編號";
    this.#input.setAttribute("aria-label", "搜尋工作項目");
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

  /** 連線狀態改變時清掉舊的內容。 */
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
    this.#status.textContent = "讀取中…";
    try {
      const items = await this.#h.list(search);
      if (seq !== this.#seq) return;
      this.#status.textContent = items.length
        ? search
          ? `找到 ${items.length} 個工作項目`
          : `指派給你、還沒結束的工作項目（${items.length}）`
        : search
          ? "找不到符合的工作項目"
          : "目前沒有指派給你、還沒結束的工作項目";
      this.#list.replaceChildren(...items.map((it) => this.#row(it)));
    } catch (e) {
      if (seq !== this.#seq) return;
      this.#status.textContent = e instanceof Error ? e.message : String(e);
      this.#list.replaceChildren();
    }
  }

  #row(item: AdoWorkItem): HTMLLIElement {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "workitem";
    b.title = `${item.kind} ${item.id}：${item.title}`;
    const top = document.createElement("span");
    top.className = "workitem-meta";
    top.textContent = [`${item.kind} ${item.id}`, item.state, when(item.changed)].filter(Boolean).join("・");
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

  async #open(item: AdoWorkItem): Promise<void> {
    this.#input.hidden = true;
    this.#status.hidden = true;
    this.#list.hidden = true;
    this.#detail.hidden = false;
    const seq = ++this.#seq;

    const back = document.createElement("button");
    back.type = "button";
    back.className = "btn btn-small workitems-back";
    back.append(icon("arrow-left"), "返回清單");
    back.addEventListener("click", () => {
      this.#seq++;
      this.#showList();
      this.#el.querySelector<HTMLElement>(".workitem")?.focus();
    });
    const h = document.createElement("h3");
    h.textContent = item.title;
    const meta = document.createElement("p");
    meta.className = "workitem-meta";
    meta.textContent = [`${item.kind} ${item.id}`, item.state, item.project].filter(Boolean).join("・");
    const actions = document.createElement("div");
    actions.className = "workitems-actions";
    const insert = document.createElement("button");
    insert.type = "button";
    insert.className = "btn btn-small btn-primary";
    insert.append(icon("link"), "插入連結");
    insert.title = `在文件的游標位置插入 [#${item.id} 標題](網址)`;
    insert.addEventListener("click", () => this.#h.insert(item));
    const open = document.createElement("button");
    open.type = "button";
    open.className = "btn btn-small";
    open.append(icon("external-link"), "在瀏覽器開啟");
    open.addEventListener("click", () => this.#h.open(item.webUrl));
    actions.append(insert, open);
    const body = document.createElement("div");
    body.className = "workitem-body";
    body.textContent = "讀取中…";
    this.#detail.replaceChildren(back, h, meta, actions, body);
    back.focus();

    try {
      const d = await this.#h.detail(item.id);
      if (seq !== this.#seq) return;
      if (d.assignedTo) meta.textContent += `・指派給 ${d.assignedTo}`;
      const parts: HTMLElement[] = [];
      const section = (title: string, html: string | null) => {
        const text = html ? htmlToText(html) : "";
        if (!text) return;
        const t = document.createElement("h4");
        t.textContent = title;
        const p = document.createElement("p");
        p.className = "workitem-text";
        p.textContent = text;
        parts.push(t, p);
      };
      section("說明", d.description);
      section(d.kind === "Bug" ? "重現步驟" : "驗收條件", d.details);
      if (!parts.length) {
        const p = document.createElement("p");
        p.className = "workitems-status";
        p.textContent = "沒有說明";
        parts.push(p);
      }
      body.replaceChildren(...parts);
    } catch (e) {
      if (seq !== this.#seq) return;
      body.textContent = e instanceof Error ? e.message : String(e);
    }
  }
}
