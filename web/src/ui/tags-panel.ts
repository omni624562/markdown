/**
 * 標籤面板：列出資料夾中所有文件的 `#標籤`（依使用次數排列），點標籤展開有這個標籤的文件。
 */
import { t } from "../i18n.ts";
import type { IndexedDoc } from "../workspace-index.ts";
import { icon } from "./icons.ts";
import { collator } from "../collator.ts";

export interface TagsHandlers {
  docs(): Promise<IndexedDoc[]>;
  open(doc: IndexedDoc, line: number): void;
  emptyHint(): string;
}

/** 標籤第一次出現在第幾行。 */
export function tagLine(text: string, tag: string): number {
  const lines = text.split("\n");
  // i18n-ignore：比對中文標點的正規表示式
  const re = new RegExp(`(^|[\\s，、。；：（「『【])#${tag.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")}(?![\\p{L}\\p{N}_/-])`, "u");
  const i = lines.findIndex((l) => re.test(l));
  return i < 0 ? 1 : i + 1;
}

export class TagsPanel {
  #handlers: TagsHandlers;
  #filter: HTMLInputElement;
  #summary: HTMLElement;
  #list: HTMLElement;
  #tags = new Map<string, IndexedDoc[]>();
  #open = new Set<string>();
  #seq = 0;

  constructor(el: HTMLElement, handlers: TagsHandlers) {
    this.#handlers = handlers;
    const filter = t("篩選標籤");
    el.innerHTML = `
      <div class="search-box"><input type="search" placeholder="${filter}" aria-label="${filter}" autocomplete="off" spellcheck="false" /></div>
      <p class="search-summary tags-summary" role="status"></p>
      <ul class="tags-list"></ul>`;
    this.#filter = el.querySelector("input")!;
    this.#summary = el.querySelector(".tags-summary")!;
    this.#list = el.querySelector(".tags-list")!;
    this.#filter.addEventListener("input", () => this.#render());
  }

  async refresh(): Promise<void> {
    const seq = ++this.#seq;
    let docs: IndexedDoc[];
    try {
      docs = await this.#handlers.docs();
    } catch (e) {
      this.#summary.textContent = t("無法讀取標籤：{error}", { error: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (seq !== this.#seq) return;
    this.#tags.clear();
    for (const doc of docs) {
      for (const tag of doc.info.tags) {
        const list = this.#tags.get(tag);
        if (list) list.push(doc);
        else this.#tags.set(tag, [doc]);
      }
    }
    this.#render();
  }

  /** 展開某個標籤（Ctrl＋點文件中的標籤時）。 */
  async select(tag: string): Promise<void> {
    this.#filter.value = "";
    this.#open.add(tag);
    await this.refresh();
    this.#list.querySelector<HTMLElement>(`[data-tag="${CSS.escape(tag)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  #render(): void {
    const q = this.#filter.value.trim().replace(/^#/, "").toLowerCase();
    const tags = [...this.#tags]
      .filter(([t]) => !q || t.toLowerCase().includes(q))
      .sort(([a, x], [b, y]) => y.length - x.length || collator.compare(a, b));
    this.#summary.textContent = this.#tags.size
      ? q
        ? t("{n} 個標籤符合", { n: tags.length })
        : t("{n} 個標籤", { n: this.#tags.size })
      : this.#handlers.emptyHint();
    this.#list.replaceChildren(
      ...tags.map(([tag, docs]) => {
        const li = document.createElement("li");
        li.dataset.tag = tag;
        const open = this.#open.has(tag);
        const head = document.createElement("button");
        head.type = "button";
        head.className = "tag-head";
        head.setAttribute("aria-expanded", String(open));
        const name = document.createElement("span");
        name.className = "tag";
        name.textContent = `#${tag}`;
        const count = document.createElement("small");
        count.textContent = String(docs.length);
        head.append(icon(open ? "chevron-down" : "chevron-right"), name, count);
        head.addEventListener("click", () => {
          if (this.#open.has(tag)) this.#open.delete(tag);
          else this.#open.add(tag);
          this.#render();
        });
        li.append(head);
        if (open) {
          const ul = document.createElement("ul");
          for (const doc of docs) {
            const item = document.createElement("li");
            const b = document.createElement("button");
            b.type = "button";
            b.className = "tag-doc";
            b.title = doc.path ?? doc.rel;
            b.append(icon("file-text"), doc.rel.replace(/\.(md|markdown)$/i, ""));
            b.addEventListener("click", () => this.#handlers.open(doc, tagLine(doc.text, tag)));
            item.append(b);
            ul.append(item);
          }
          li.append(ul);
        }
        return li;
      }),
    );
  }
}
