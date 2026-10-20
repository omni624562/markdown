/**
 * 資料夾全文搜尋面板：輸入後稍候自動搜尋，結果依檔案分組，點擊即開檔並跳到該行。
 */
import type { SearchResult } from "../desktop.ts";
import { icon } from "./icons.ts";

export interface SearchHandlers {
  search(query: string, caseSensitive: boolean, regex: boolean): Promise<SearchResult>;
  open(path: string, line: number, column: number): void;
}

export class SearchPanel {
  #input: HTMLInputElement;
  #case: HTMLButtonElement;
  #regex: HTMLButtonElement;
  #summary: HTMLElement;
  #results: HTMLElement;
  #handlers: SearchHandlers;
  #timer = 0;
  #seq = 0;

  constructor(el: HTMLElement, handlers: SearchHandlers) {
    this.#handlers = handlers;
    el.innerHTML = `
      <div class="search-box">
        <input type="search" id="search-input" placeholder="在資料夾中搜尋" aria-label="搜尋文字" autocomplete="off" spellcheck="false" />
        <button type="button" class="search-opt" aria-pressed="false" title="區分大小寫" aria-label="區分大小寫">Aa</button>
        <button type="button" class="search-opt" aria-pressed="false" title="使用正規表示式" aria-label="使用正規表示式">.*</button>
      </div>
      <p class="search-summary" role="status"></p>
      <div class="search-results"></div>`;
    this.#input = el.querySelector("input")!;
    [this.#case, this.#regex] = [...el.querySelectorAll<HTMLButtonElement>(".search-opt")];
    this.#summary = el.querySelector(".search-summary")!;
    this.#results = el.querySelector(".search-results")!;

    this.#input.addEventListener("input", () => this.#schedule());
    this.#input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        this.#run();
      }
    });
    for (const b of [this.#case, this.#regex]) {
      b.addEventListener("click", () => {
        b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
        this.#run();
      });
    }
  }

  focus(initial?: string): void {
    if (initial) this.#input.value = initial;
    this.#input.focus();
    this.#input.select();
    if (initial) this.#run();
  }

  /** 檔案有變動時重新搜尋目前的關鍵字。 */
  rerun(): void {
    if (this.#input.value) this.#schedule();
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => this.#run(), 300);
  }

  async #run(): Promise<void> {
    clearTimeout(this.#timer);
    const query = this.#input.value;
    const seq = ++this.#seq;
    if (!query) {
      this.#summary.textContent = "";
      this.#results.replaceChildren();
      return;
    }
    this.#summary.textContent = "搜尋中…";
    let result: SearchResult;
    try {
      result = await this.#handlers.search(
        query,
        this.#case.getAttribute("aria-pressed") === "true",
        this.#regex.getAttribute("aria-pressed") === "true",
      );
    } catch (e) {
      if (seq !== this.#seq) return;
      this.#summary.textContent = e instanceof Error ? e.message : String(e);
      this.#results.replaceChildren();
      return;
    }
    if (seq !== this.#seq) return; // 已經有新的搜尋
    this.#summary.textContent = result.total
      ? `${result.files.length} 個檔案中有 ${result.total} 處符合${result.truncated ? "（結果太多，只顯示前面的部分）" : ""}`
      : "找不到符合的內容";
    this.#results.replaceChildren(
      ...result.files.map((f) => {
        const group = document.createElement("section");
        const head = document.createElement("h3");
        head.append(icon("file-text"));
        head.append(Object.assign(document.createElement("span"), { textContent: f.rel }));
        head.append(Object.assign(document.createElement("small"), { textContent: String(f.matches.length) }));
        head.title = f.path;
        group.append(head);
        for (const m of f.matches) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "search-hit";
          const ln = document.createElement("span");
          ln.className = "search-line";
          ln.textContent = String(m.line);
          b.append(ln);
          const text = document.createElement("span");
          let pos = 0;
          for (const [s, e] of m.ranges) {
            text.append(m.text.slice(pos, s));
            text.append(Object.assign(document.createElement("mark"), { textContent: m.text.slice(s, e) }));
            pos = e;
          }
          text.append(m.text.slice(pos));
          b.append(text);
          b.addEventListener("click", () => this.#handlers.open(f.path, m.line, m.column));
          group.append(b);
        }
        return group;
      }),
    );
  }
}
