/**
 * 待辦總覽：把資料夾中所有文件的 `- [ ]` 集中列出，可以依負責人篩選、依檔案或截止日排列，
 * 直接在這裡勾選完成；點文字跳到那一行。
 */
import { type Task, isoDate, plainTaskText } from "../doc-index.ts";
import type { IndexedDoc } from "../workspace-index.ts";
import { t } from "../i18n.ts";
import { icon } from "./icons.ts";
import { collator } from "../collator.ts";

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
  /** 上次顯示的待辦內容（判斷要不要重建清單）。 */
  #key = "";
  #seq = 0;

  constructor(el: HTMLElement, handlers: TasksHandlers) {
    this.#el = el;
    this.#handlers = handlers;
    const tr = {
      show: t("顯示"),
      open: t("未完成"),
      all: t("全部"),
      owner: t("負責人"),
      everyone: t("所有人"),
      order: t("排列方式"),
      byFile: t("依檔案"),
      byDue: t("依截止日"),
    };
    el.innerHTML = `
      <div class="tasks-filters">
        <div class="segmented" role="group" aria-label="${tr.show}">
          <button type="button" data-show="open" aria-pressed="true">${tr.open}</button>
          <button type="button" data-show="all" aria-pressed="false">${tr.all}</button>
        </div>
        <select class="tasks-owner" aria-label="${tr.owner}"><option value="">${tr.everyone}</option></select>
        <select class="tasks-order" aria-label="${tr.order}">
          <option value="file">${tr.byFile}</option>
          <option value="due">${tr.byDue}</option>
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
      this.#summary.textContent = t("無法讀取待辦：{error}", { error: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (seq !== this.#seq) return;
    const items = docs.flatMap((doc) => doc.info.tasks.map((t) => ({ ...t, doc })));
    // 待辦沒有變（打字多半不會改到待辦）：不重建清單，捲動位置與焦點也不會跳掉。
    const key = JSON.stringify(items.map((t) => [t.doc.path, t.doc.rel, t.line, t.done, t.text, t.due, t.owners]));
    if (key === this.#key && this.#list.childElementCount) return;
    this.#key = key;
    this.#items = items;
    const owners = [...new Set(this.#items.flatMap((t) => t.owners))].sort(collator.compare);
    const current = this.#owner.value;
    this.#owner.replaceChildren(new Option(t("所有人"), ""), ...owners.map((o) => new Option(`@${o}`, o)));
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
      ? t("{n} 項未完成", { n: open.length }) +
        (overdue ? t("，{n} 項已過截止日", { n: overdue }) : "") +
        (this.#show === "all" ? t("，共 {n} 項", { n: items.length }) : "")
      : this.#handlers.emptyHint();
    this.#list.replaceChildren();
    if (this.#order === "due") {
      const sorted = [...items].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || collator.compare(a.doc.rel, b.doc.rel));
      const ul = document.createElement("ul");
      ul.append(...sorted.map((t) => this.#row(t, today, true)));
      this.#list.append(ul);
      return;
    }
    const groups = new Map<IndexedDoc, TaskItem[]>();
    for (const t of items) {
      const list = groups.get(t.doc);
      if (list) list.push(t);
      else groups.set(t.doc, [t]);
    }
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

  #row(item: TaskItem, today: string, showFile: boolean): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "task-row";
    li.classList.toggle("done", item.done);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = item.done;
    box.setAttribute("aria-label", item.done ? t("標成未完成") : t("標成完成"));
    box.addEventListener("change", () => {
      box.disabled = true;
      this.#handlers
        .toggle(item, box.checked)
        .then(() => this.refresh())
        .catch((e) => {
          box.checked = item.done;
          box.disabled = false;
          this.#summary.textContent = e instanceof Error ? e.message : String(e);
        });
    });
    const text = document.createElement("button");
    text.type = "button";
    text.className = "task-text";
    text.title = t("{file}：第 {line} 行", { file: item.doc.rel, line: item.line });
    const plain = plainTaskText(item.text);
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
    text.addEventListener("click", () => this.#handlers.open(item.doc, item.line));
    li.append(box, text);
    const meta = document.createElement("span");
    meta.className = "task-meta";
    if (item.due) {
      const due = document.createElement("span");
      due.className = "task-due";
      if (!item.done && item.due < today) due.classList.add("overdue");
      else if (!item.done && item.due === today) due.classList.add("today");
      due.textContent = item.due === today ? t("今天") : item.due.slice(5).replace("-", "/");
      due.title = t("截止日 {date}", { date: item.due });
      meta.append(due);
    }
    if (showFile) {
      const file = document.createElement("span");
      file.className = "task-file";
      file.textContent = item.doc.rel.replace(/\.(md|markdown)$/i, "");
      meta.append(file);
    }
    if (meta.childElementCount) li.append(meta);
    return li;
  }

  get element(): HTMLElement {
    return this.#el;
  }
}
