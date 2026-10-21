/**
 * 待辦總覽：把資料夾中所有文件的 `- [ ]` 集中列出，可以依負責人篩選、依檔案或截止日排列，
 * 直接在這裡勾選完成；點文字跳到那一行。
 */
import { type Task, isoDate, plainTaskText } from "../doc-index.ts";
import type { IndexedDoc } from "../workspace-index.ts";
import { icon } from "./icons.ts";

export interface TaskItem extends Task {
  doc: IndexedDoc;
}

export interface TasksHandlers {
  /** 目前所有文件（呼叫前已經更新索引）。 */
  docs(): Promise<IndexedDoc[]>;
  open(doc: IndexedDoc, line: number): void;
  toggle(item: TaskItem, done: boolean): Promise<void>;
  /** 沒有任何待辦時顯示的說明。 */
  emptyHint(): string;
}

type Show = "open" | "all";
type Order = "file" | "due";

export class TasksPanel {
  #el: HTMLElement;
  #handlers: TasksHandlers;
  #summary: HTMLElement;
  #list: HTMLElement;
  #owner: HTMLSelectElement;
  #show: Show = "open";
  #order: Order = "file";
  #items: TaskItem[] = [];
  #seq = 0;

  constructor(el: HTMLElement, handlers: TasksHandlers) {
    this.#el = el;
    this.#handlers = handlers;
    el.innerHTML = `
      <div class="tasks-filters">
        <div class="segmented" role="group" aria-label="顯示">
          <button type="button" data-show="open" aria-pressed="true">未完成</button>
          <button type="button" data-show="all" aria-pressed="false">全部</button>
        </div>
        <select class="tasks-owner" aria-label="負責人"><option value="">所有人</option></select>
        <select class="tasks-order" aria-label="排列方式">
          <option value="file">依檔案</option>
          <option value="due">依截止日</option>
        </select>
      </div>
      <p class="search-summary tasks-summary" role="status"></p>
      <div class="tasks-list"></div>`;
    this.#summary = el.querySelector(".tasks-summary")!;
    this.#list = el.querySelector(".tasks-list")!;
    this.#owner = el.querySelector(".tasks-owner")!;
    for (const b of el.querySelectorAll<HTMLButtonElement>("[data-show]")) {
      b.addEventListener("click", () => {
        this.#show = b.dataset.show as Show;
        for (const x of el.querySelectorAll("[data-show]")) x.setAttribute("aria-pressed", String(x === b));
        this.#render();
      });
    }
    this.#owner.addEventListener("change", () => this.#render());
    el.querySelector<HTMLSelectElement>(".tasks-order")!.addEventListener("change", (e) => {
      this.#order = (e.target as HTMLSelectElement).value as Order;
      this.#render();
    });
  }

  /** 重新讀取所有文件的待辦。 */
  async refresh(): Promise<void> {
    const seq = ++this.#seq;
    let docs: IndexedDoc[];
    try {
      docs = await this.#handlers.docs();
    } catch (e) {
      this.#summary.textContent = `無法讀取待辦：${e instanceof Error ? e.message : e}`;
      return;
    }
    if (seq !== this.#seq) return;
    this.#items = docs.flatMap((doc) => doc.info.tasks.map((t) => ({ ...t, doc })));
    const owners = [...new Set(this.#items.flatMap((t) => t.owners))].sort((a, b) => a.localeCompare(b, "zh-Hant"));
    const current = this.#owner.value;
    this.#owner.replaceChildren(new Option("所有人", ""), ...owners.map((o) => new Option(`@${o}`, o)));
    this.#owner.value = owners.includes(current) ? current : "";
    this.#owner.hidden = owners.length === 0;
    this.#render();
  }

  #render(): void {
    const today = isoDate(new Date());
    const owner = this.#owner.value;
    const items = this.#items.filter((t) => (this.#show === "all" || !t.done) && (!owner || t.owners.includes(owner)));
    const open = this.#items.filter((t) => !t.done && (!owner || t.owners.includes(owner)));
    const overdue = open.filter((t) => t.due && t.due < today).length;
    this.#summary.textContent = this.#items.length
      ? `${open.length} 項未完成` + (overdue ? `，${overdue} 項已過截止日` : "") + (this.#show === "all" ? `，共 ${items.length} 項` : "")
      : this.#handlers.emptyHint();
    this.#list.replaceChildren();
    if (this.#order === "due") {
      const sorted = [...items].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.doc.rel.localeCompare(b.doc.rel));
      const ul = document.createElement("ul");
      ul.append(...sorted.map((t) => this.#row(t, today, true)));
      this.#list.append(ul);
      return;
    }
    const groups = new Map<IndexedDoc, TaskItem[]>();
    for (const t of items) groups.set(t.doc, [...(groups.get(t.doc) ?? []), t]);
    for (const [doc, tasks] of groups) {
      const section = document.createElement("section");
      const h = document.createElement("h3");
      const name = document.createElement("span");
      name.textContent = doc.rel;
      name.title = doc.path ?? doc.rel;
      const count = document.createElement("small");
      count.textContent = String(tasks.length);
      h.append(icon("file-text"), name, count);
      const ul = document.createElement("ul");
      ul.append(...tasks.map((t) => this.#row(t, today, false)));
      section.append(h, ul);
      this.#list.append(section);
    }
  }

  #row(t: TaskItem, today: string, showFile: boolean): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "task-row";
    li.classList.toggle("done", t.done);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = t.done;
    box.setAttribute("aria-label", t.done ? "標成未完成" : "標成完成");
    box.addEventListener("change", () => {
      box.disabled = true;
      this.#handlers
        .toggle(t, box.checked)
        .then(() => this.refresh())
        .catch((e) => {
          box.checked = t.done;
          box.disabled = false;
          this.#summary.textContent = e instanceof Error ? e.message : String(e);
        });
    });
    const text = document.createElement("button");
    text.type = "button";
    text.className = "task-text";
    text.title = `${t.doc.rel}：第 ${t.line} 行`;
    const plain = plainTaskText(t.text);
    // @負責人另外上色
    for (const part of plain.split(/((?<=^|[\s，、：:（(])@[\p{L}\p{N}_-]+)/u)) {
      if (!part) continue;
      if (part.startsWith("@")) {
        const s = document.createElement("span");
        s.className = "task-owner";
        s.textContent = part;
        text.append(s);
      } else text.append(part);
    }
    text.addEventListener("click", () => this.#handlers.open(t.doc, t.line));
    li.append(box, text);
    const meta = document.createElement("span");
    meta.className = "task-meta";
    if (t.due) {
      const due = document.createElement("span");
      due.className = "task-due";
      if (!t.done && t.due < today) due.classList.add("overdue");
      else if (!t.done && t.due === today) due.classList.add("today");
      due.textContent = t.due === today ? "今天" : t.due.slice(5).replace("-", "/");
      due.title = `截止日 ${t.due}`;
      meta.append(due);
    }
    if (showFile) {
      const file = document.createElement("span");
      file.className = "task-file";
      file.textContent = t.doc.rel.replace(/\.(md|markdown)$/i, "");
      meta.append(file);
    }
    if (meta.childElementCount) li.append(meta);
    return li;
  }

  get element(): HTMLElement {
    return this.#el;
  }
}
