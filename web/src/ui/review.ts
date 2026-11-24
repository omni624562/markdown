/**
 * 差異檢視：把一份「提議的新內容」放進編輯器，逐段標出與目前內容的差異，
 * 讓使用者一段一段接受或拒絕。外部變動、AI 建議、版本還原都共用這個元件。
 *
 * 做法是讓主編輯器暫時進入 unifiedMergeView：文件換成提議內容、原內容當作比較基準。
 * 接受一段＝保留新內容；拒絕一段＝還原成原內容。整個過程都在編輯器的復原紀錄裡。
 */
import { getChunks, getOriginalDoc, MergeView, unifiedMergeView } from "@codemirror/merge";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { t } from "../i18n.ts";
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
  /**
   * `side`：左右並排（左邊是比較基準、唯讀，右邊是新內容），每一段只有「還原」按鈕；
   * 結束時把右邊的內容放回編輯器。省略時是上下對照（在編輯器裡標出來）。
   */
  layout?: "stacked" | "side";
  /** 左右並排時兩欄上方的標題（基準、新內容）。 */
  sideLabels?: [string, string];
  /** 檢視結束時呼叫；`changed` 表示最後的內容是否和開始前不同。 */
  onFinish?: (result: { changed: boolean }) => void;
}

function chunkButton(opts: ReviewOptions) {
  return (type: "accept" | "reject", action: (e: MouseEvent) => void): HTMLElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `review-chunk-${type}`;
    b.textContent = type === "accept" ? (opts.acceptLabel ?? t("保留新內容")) : (opts.rejectLabel ?? t("還原"));
    b.title = type === "accept" ? t("這一段採用新的內容") : t("這一段維持原本的內容");
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
  /** 左右並排時的比較畫面（蓋在編輯器上）。 */
  #side: { merge: MergeView; host: HTMLElement } | null = null;

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
    if (opts.layout === "side") {
      this.#startSide(original, proposed, opts);
      this.#renderBar();
      return true;
    }
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

  /**
   * 比較中改了「比較的方式」設定：照新的方式重新顯示同一個比較（目前的內容與已經改回去的段落都保留）。
   * 只有本來就指定了 `layout` 的比較（和舊版本比較）會換；其他的差異檢視一律上下對照，不受影響。
   */
  relayout(layout: "stacked" | "side"): void {
    const active = this.#active;
    if (!active?.layout || active.layout === layout) return;
    // 先清掉進行中的狀態：拿掉比較時編輯器會更新，不能被當成「每一段都處理完了」而結束新的比較。
    this.#active = null;
    // 目前的內容先放回編輯器（左右並排時是右邊；上下對照時文件本來就是目前的內容），再用同樣的基準重新開始。
    if (this.#side) this.#closeSide(true);
    else this.#view.dispatch({ effects: this.#compartment.reconfigure([]) });
    this.#bar.hidden = true;
    this.start(this.#view.state.doc.toString(), { ...active, layout });
  }

  /** 保留目前所有的新內容並結束。 */
  acceptAll(): void {
    this.finish();
  }

  /** 全部還原成檢視前的內容並結束。 */
  rejectAll(): void {
    if (!this.#active) return;
    if (this.#side) {
      this.#setDoc(this.#active.original);
      this.#closeSide(false);
      this.finish();
      return;
    }
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
    if (this.#side) this.#closeSide(true);
    else this.#view.dispatch({ effects: this.#compartment.reconfigure([]) });
    this.#bar.hidden = true;
    active.onFinish?.({ changed: this.#view.state.doc.toString() !== active.before });
  }

  /** 左右並排：左邊唯讀的基準、右邊可以編輯的新內容，蓋在編輯器上（編輯器先藏起來）。 */
  #startSide(original: string, proposed: string, opts: ReviewOptions): void {
    const host = document.createElement("div");
    host.className = "review-side";
    const [left, right] = opts.sideLabels ?? [t("原本"), t("新的")];
    const heads = document.createElement("div");
    heads.className = "review-side-heads";
    heads.append(
      Object.assign(document.createElement("span"), { className: "review-side-old", textContent: left }),
      Object.assign(document.createElement("span"), { className: "review-side-new", textContent: right }),
    );
    const body = document.createElement("div");
    body.className = "review-side-body";
    host.append(heads, body);
    this.#bar.after(host);
    this.#view.dom.closest<HTMLElement>(".editor-pane")?.classList.add("reviewing-side");
    const rerender = EditorView.updateListener.of((u) => {
      if (this.#active && u.docChanged) this.#renderBar();
    });
    const merge = new MergeView({
      a: { doc: original, extensions: [EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false)] },
      b: { doc: proposed, extensions: [EditorView.lineWrapping, rerender] },
      parent: body,
      revertControls: "a-to-b",
      renderRevertControl: () => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "review-chunk-reject";
        b.textContent = opts.rejectLabel ?? t("還原");
        b.title = t("這一段維持原本的內容");
        return b;
      },
      highlightChanges: true,
      gutter: true,
    });
    this.#side = { merge, host };
  }

  /** 收起左右並排；`apply`：把右邊的內容放回編輯器。 */
  #closeSide(apply: boolean): void {
    const side = this.#side!;
    this.#side = null;
    if (apply) this.#setDoc(side.merge.b.state.doc.toString());
    side.merge.destroy();
    side.host.remove();
    this.#view.dom.closest<HTMLElement>(".editor-pane")?.classList.remove("reviewing-side");
  }

  /** 換成 `text`：只換掉頭尾相同以外的部分（游標和捲動位置盡量不動）。 */
  #setDoc(text: string): void {
    const cur = this.#view.state.doc.toString();
    if (text === cur) return;
    let from = 0;
    while (from < cur.length && from < text.length && cur[from] === text[from]) from++;
    let end = 0;
    while (end < cur.length - from && end < text.length - from && cur[cur.length - 1 - end] === text[text.length - 1 - end]) end++;
    this.#view.dispatch({
      changes: { from, to: cur.length - end, insert: text.slice(from, text.length - end) },
      userEvent: "input.review",
    });
  }

  #renderBar(): void {
    const active = this.#active!;
    const chunks = this.#side ? this.#side.merge.chunks : (getChunks(this.#view.state)?.chunks ?? []);
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
    count.textContent = t("還有 {n} 處差異", { n: chunks.length });
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
    mk(t("全部{label}", { label: active.rejectLabel ?? t("還原") }), () => this.rejectAll());
    mk(this.#side ? t("看完了") : t("全部{label}", { label: active.acceptLabel ?? t("保留新內容") }), () => this.acceptAll(), true);
    this.#bar.replaceChildren(msg, actions);
    this.#bar.hidden = false;
  }
}
