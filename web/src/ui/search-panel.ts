/**
 * 資料夾全文搜尋面板：輸入後稍候自動搜尋，結果依檔案分組，點擊即開檔並跳到該行。
 */
import type { ReplaceResult, SearchResult } from "../desktop.ts";
import { t } from "../i18n.ts";
import { choose } from "./choice.ts";
import { icon } from "./icons.ts";

export interface SearchHandlers {
  search(query: string, caseSensitive: boolean, regex: boolean): Promise<SearchResult>;
  open(path: string, line: number, column: number): void;
  /** 全部取代（呼叫前已經請使用者確認）。 */
  replace(query: string, replacement: string, caseSensitive: boolean, regex: boolean): Promise<ReplaceResult>;
}

export class SearchPanel {
  #input: HTMLInputElement;
  #case: HTMLButtonElement;
  #regex: HTMLButtonElement;
  #summary: HTMLElement;
  #replaceRow: HTMLElement;
  #replaceInput: HTMLInputElement;
  #toggle: HTMLButtonElement;
  #last: SearchResult | null = null;
  #results: HTMLElement;
  #handlers: SearchHandlers;
  #timer = 0;
  #seq = 0;

  constructor(el: HTMLElement, handlers: SearchHandlers) {
    this.#handlers = handlers;
    const tr = {
      showReplace: t("顯示取代"),
      placeholder: t("在資料夾中搜尋"),
      text: t("搜尋文字"),
      matchCase: t("區分大小寫"),
      regex: t("使用正規表示式"),
      replaceWith: t("取代為"),
      replaceInFiles: t("在所有檔案中取代"),
      replaceAll: t("全部取代"),
    };
    el.innerHTML = `
      <div class="search-box">
        <button type="button" class="search-toggle" aria-expanded="false" title="${tr.showReplace}" aria-label="${tr.showReplace}">›</button>
        <input type="search" id="search-input" placeholder="${tr.placeholder}" aria-label="${tr.text}" autocomplete="off" spellcheck="false" />
        <button type="button" class="search-opt" aria-pressed="false" title="${tr.matchCase}" aria-label="${tr.matchCase}">Aa</button>
        <button type="button" class="search-opt" aria-pressed="false" title="${tr.regex}" aria-label="${tr.regex}">.*</button>
      </div>
      <div class="search-box replace-row" hidden>
        <input type="text" placeholder="${tr.replaceWith}" aria-label="${tr.replaceWith}" autocomplete="off" spellcheck="false" />
        <button type="button" class="btn replace-all" title="${tr.replaceInFiles}">${tr.replaceAll}</button>
      </div>
      <p class="search-summary" role="status"></p>
      <div class="search-results"></div>`;
    this.#input = el.querySelector("#search-input")!;
    this.#toggle = el.querySelector(".search-toggle")!;
    this.#replaceRow = el.querySelector(".replace-row")!;
    this.#replaceInput = this.#replaceRow.querySelector("input")!;
    this.#toggle.addEventListener("click", () => this.#showReplace(this.#replaceRow.hidden));
    this.#replaceRow.querySelector(".replace-all")!.addEventListener("click", () => void this.#replaceAll());
    this.#replaceInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void this.#replaceAll();
      }
    });
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

  /** 顯示取代欄（指令「在資料夾中取代」）。 */
  showReplace(): void {
    this.#showReplace(true);
    (this.#input.value ? this.#replaceInput : this.#input).focus();
  }

  #showReplace(show: boolean): void {
    this.#replaceRow.hidden = !show;
    this.#toggle.setAttribute("aria-expanded", String(show));
    this.#toggle.textContent = show ? "⌄" : "›";
  }

  async #replaceAll(): Promise<void> {
    const query = this.#input.value;
    if (!query) {
      this.#input.focus();
      return;
    }
    await this.#run();
    const found = this.#last;
    if (!found?.total) return;
    const replacement = this.#replaceInput.value;
    const ok = await choose(
      t("全部取代？"),
      t("要把 {files}中的 {n} 處「{query}」取代為「{replacement}」嗎？取代前的內容會記在每個檔案的版本記錄中，可以還原；有未存檔變更的分頁會略過。", {
        files: t("{n} 個檔案", { n: found.files.length }),
        n: found.total,
        query,
        replacement,
      }),
      [
        { id: "replace", label: t("全部取代"), primary: true },
        { id: "cancel", label: t("取消") },
      ],
    );
    if (ok !== "replace") return;
    try {
      const r = await this.#handlers.replace(query, replacement, this.#flag(this.#case), this.#flag(this.#regex));
      this.#summary.textContent =
        t("已在 {files}中取代 {n} 處", { files: t("{n} 個檔案", { n: r.files }), n: r.replacements }) +
        (r.skipped.length ? t("；{n} 個有未存檔變更的檔案已略過", { n: r.skipped.length }) : "") +
        (r.failed.length ? t("；{n} 個檔案無法處理：{files}", { n: r.failed.length, files: r.failed.join(t("、")) }) : "");
    } catch (e) {
      this.#summary.textContent = e instanceof Error ? e.message : String(e);
      return;
    }
    // 重新搜尋，結果應該是空的（或剩下略過的檔案）。
    const summary = this.#summary.textContent;
    await this.#run();
    this.#summary.textContent = summary;
  }

  #flag(b: HTMLButtonElement): boolean {
    return b.getAttribute("aria-pressed") === "true";
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
      this.#last = null;
      this.#summary.textContent = "";
      this.#results.replaceChildren();
      return;
    }
    this.#summary.textContent = t("搜尋中…");
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
    this.#last = result;
    this.#summary.textContent = result.total
      ? t("{files}中有 {n} 處符合", { files: t("{n} 個檔案", { n: result.files.length }), n: result.total }) +
        (result.truncated ? t("（結果太多，只顯示前面的部分）") : "")
      : t("找不到符合的內容");
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
