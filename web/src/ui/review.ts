/**
 * 差異檢視：把一份「提議的新內容」放進編輯器，逐段標出與目前內容的差異，
 * 讓使用者一段一段接受或拒絕。外部變動、AI 建議、版本還原都共用這個元件。
 *
 * 做法是讓主編輯器暫時進入 unifiedMergeView：文件換成提議內容、原內容當作比較基準。
 * 接受一段＝保留新內容；拒絕一段＝還原成原內容。整個過程都在編輯器的復原紀錄裡。
 */
import { getChunks, getOriginalDoc, unifiedMergeView } from "@codemirror/merge";
import { Compartment, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { icon } from "./icons.ts";

export interface ReviewOptions {
  /** 顯示在提示列上的來源說明，例如「磁碟上的版本」。 */
  title: string;
  /** 說明接受／拒絕代表什麼。 */
  hint?: string;
  /** 每一段的按鈕文字，預設為「保留新內容」與「還原」。 */
  acceptLabel?: string;
  rejectLabel?: string;
  /**
   * 比較的基準。省略時是目前編輯器的內容；外部修改時則是修改前的版本
   * （編輯器內容換成新版本，「還原」會回到這個版本）。
   */
  original?: string;
  /** 標記這次檢視的來源，讓呼叫端判斷是否要接續前一次（例如連續的外部修改）。 */
  source?: string;
  /** 檢視結束時呼叫；`changed` 表示最後的內容是否和開始前不同。 */
  onFinish?: (result: { changed: boolean }) => void;
}

function chunkButton(opts: ReviewOptions) {
  return (type: "accept" | "reject", action: (e: MouseEvent) => void): HTMLElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `review-chunk-${type}`;
    b.textContent = type === "accept" ? (opts.acceptLabel ?? "保留新內容") : (opts.rejectLabel ?? "還原");
    b.title = type === "accept" ? "這一段採用新的內容" : "這一段維持原本的內容";
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      action(e);
    });
    return b;
  };
}

export class Review {
  #view!: EditorView;
  #compartment = new Compartment();
  #bar: HTMLElement;
  #active: (ReviewOptions & { before: string; original: string }) | null = null;

  constructor(bar: HTMLElement) {
    this.#bar = bar;
    bar.hidden = true;
  }

  /** 編輯器建立後再接上（擴充要在建立編輯器前放進去）。 */
  attach(view: EditorView): void {
    this.#view = view;
  }

  /** 放進編輯器擴充清單裡的佔位（檢視時才會填入 merge 擴充）。 */
  get extension(): Extension {
    const self = this;
    return [
      this.#compartment.of([]),
      ViewPlugin.define(() => ({
        update(u) {
          if (self.#active && (u.docChanged || u.transactions.length)) self.#renderBar();
        },
      })),
    ];
  }

  get active(): boolean {
    return this.#active !== null;
  }

  /** 進行中的檢視的來源與比較基準。 */
  get current(): { source?: string; original: string } | null {
    return this.#active && { source: this.#active.source, original: this.#active.original };
  }

  /** 開始檢視：目前內容是基準，`proposed` 是新內容。內容相同時直接回傳 false。 */
  start(proposed: string, opts: ReviewOptions): boolean {
    if (this.#active) this.finish();
    const before = this.#view.state.doc.toString();
    const original = opts.original ?? before;
    if (original === proposed) return false;
    this.#active = { ...opts, before, original };
    this.#view.dispatch({
      changes: { from: 0, to: before.length, insert: proposed },
      effects: this.#compartment.reconfigure(
        unifiedMergeView({
          original,
          mergeControls: chunkButton(opts),
          highlightChanges: true,
          gutter: true,
          syntaxHighlightDeletions: true,
        }),
      ),
      userEvent: "input.review",
    });
    this.#renderBar();
    return true;
  }

  /** 保留目前所有的新內容並結束。 */
  acceptAll(): void {
    this.finish();
  }

  /** 全部還原成檢視前的內容並結束。 */
  rejectAll(): void {
    if (!this.#active) return;
    const original = getOriginalDoc(this.#view.state).toString();
    this.#view.dispatch({
      changes: { from: 0, to: this.#view.state.doc.length, insert: original },
      userEvent: "input.review",
    });
    this.finish();
  }

  finish(): void {
    const active = this.#active;
    if (!active) return;
    this.#active = null;
    this.#view.dispatch({ effects: this.#compartment.reconfigure([]) });
    this.#bar.hidden = true;
    active.onFinish?.({ changed: this.#view.state.doc.toString() !== active.before });
  }

  #renderBar(): void {
    const active = this.#active!;
    const chunks = getChunks(this.#view.state)?.chunks ?? [];
    if (chunks.length === 0) {
      // 每一段都處理完了。
      queueMicrotask(() => this.finish());
      return;
    }
    const msg = document.createElement("p");
    msg.append(icon("git-compare"));
    const strong = document.createElement("strong");
    strong.textContent = active.title;
    const count = document.createElement("span");
    count.textContent = `還有 ${chunks.length} 處差異`;
    msg.append(strong, count);
    if (active.hint) {
      const hint = document.createElement("span");
      hint.className = "review-hint";
      hint.textContent = active.hint;
      msg.append(hint);
    }
    const actions = document.createElement("div");
    actions.className = "review-actions";
    const mk = (label: string, run: () => void, primary = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = primary ? "btn btn-primary" : "btn";
      b.textContent = label;
      b.addEventListener("click", run);
      actions.append(b);
    };
    mk(`全部${active.rejectLabel ?? "還原"}`, () => this.rejectAll());
    mk(`全部${active.acceptLabel ?? "保留新內容"}`, () => this.acceptAll(), true);
    this.#bar.replaceChildren(msg, actions);
    this.#bar.hidden = false;
  }
}
