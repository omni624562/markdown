/**
 * 主畫面這一端的終端機面板（桌面版）。
 *
 * 終端機本身在獨立的 webview（`terminal.html`），疊在這個元素的位置上；這裡只負責留出位置、
 * 調整高度，並透過 Rust 送幾種固定的要求（`term_forward`）。主畫面不能寫入終端機：
 * 開啟的文件萬一夾帶了程式碼，也不能拿終端機執行指令。
 *
 * 終端機的 webview 疊在主畫面上面，主畫面的選單、對話框打開時會被它蓋住（例如「☰」選單往下長到終端機的位置）。
 * 所以選單或對話框蓋到終端機的位置時，先把終端機藏起來，關掉後再顯示（終端機照常執行，只是暫時看不到）。
 * 通知不算：通知常常出現，每次都藏起終端機會一直閃。
 */
import type { Desktop, TermNotice, TermProgram } from "./desktop.ts";
import { t } from "./i18n.ts";
import * as storage from "./storage.ts";
import { loadAccent } from "./palette.ts";

const HEIGHT = { min: 120, default: 280 };

export class TerminalProxy {
  #el: HTMLElement;
  #d: Desktop;
  #onLayout: () => void;
  #zoom: () => number;
  #layoutFrame = 0;
  /** 最近一次告訴原生端位置的結果（webview 顯示後才能取得鍵盤焦點）。 */
  #laidOut: Promise<void> = Promise.resolve();
  /** Linux：終端機排在主畫面下方（不能疊上去），這個元素只留調整高度的把手。 */
  #stacked = false;
  /** 主畫面的選單或對話框蓋到終端機的位置：終端機暫時藏起來。 */
  #covered = false;
  #coverFrame = 0;

  /**
   * @param onLayout 面板顯示、隱藏或改變高度後（編輯區要重新量尺寸）
   * @param zoom 介面縮放（設定的「介面大小」）
   * @param onCommand 在終端機裡按了全域快速鍵（指令面板、顯示／隱藏終端機）
   */
  constructor(el: HTMLElement, d: Desktop, onLayout: () => void, zoom: () => number, onCommand: (id: string) => void) {
    this.#el = el;
    this.#d = d;
    this.#onLayout = onLayout;
    this.#zoom = zoom;
    const handle = document.createElement("div");
    handle.className = "term-resize";
    handle.role = "separator";
    handle.tabIndex = 0;
    handle.setAttribute("aria-orientation", "horizontal");
    handle.setAttribute("aria-label", t("調整終端機高度"));
    el.replaceChildren(handle);
    el.style.setProperty("--term-height", `${Number(storage.load("terminal-height")) || HEIGHT.default}px`);
    this.#setupResize(handle);
    new ResizeObserver(() => this.relayout()).observe(el);
    window.addEventListener("resize", () => this.relayout());
    // 選單（popover）打開、關閉時有 toggle 事件（不會往上傳，所以在 capture 階段收）；對話框看 open 屬性。
    // 選單在 toggle 之後才定位，等下一個畫面再量。
    const check = () => {
      cancelAnimationFrame(this.#coverFrame);
      this.#coverFrame = requestAnimationFrame(() => this.#checkCovered());
    };
    document.addEventListener("toggle", check, true);
    new MutationObserver(check).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
    void d.onTermNotice((n: TermNotice) => {
      if (n.kind === "show") this.#reveal();
      else if (n.kind === "hide") this.hide();
      else if (n.kind === "command") onCommand(n.id);
    });
  }

  get visible(): boolean {
    return !this.#el.hidden;
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  /** 顯示面板；還沒有分頁時開一個殼層。 */
  show(): void {
    this.#reveal();
    this.#forward({ kind: "show" });
    void this.#laidOut.then(() => this.focus());
  }

  hide(): void {
    if (this.#el.hidden) return;
    this.#el.hidden = true;
    this.#onLayout();
    this.relayout();
  }

  /** 開一個新分頁執行指定的程式。 */
  start(program: TermProgram): void {
    this.#reveal();
    this.#forward({ kind: "start", program });
  }

  /** 把文字貼到終端機中的 Claude Code／Codex 輸入列（不會自己送出）。沒有正在執行的 AI 時先啟動 `preferred`。 */
  sendToAi(text: string, preferred: TermProgram): void {
    this.#reveal();
    this.#forward({ kind: "sendToAi", text, preferred });
  }

  /** 開一個殼層執行 `claude setup-token`。 */
  runSetupToken(): void {
    this.#reveal();
    this.#forward({ kind: "setupToken" });
  }

  /** 開一個殼層執行 `comet setup`（COMET 專案的環境設定），使用者照畫面的指示輸入。 */
  runCometSetup(): void {
    this.#reveal();
    this.#forward({ kind: "cometSetup" });
  }

  /** 只顯示已安裝的 AI 工具按鈕。 */
  setAvailable(found: { claude: string | null; codex: string | null }): void {
    this.#forward({ kind: "available", claude: !!found.claude, codex: !!found.codex });
  }

  /** 主題或編輯區字級改變後，終端機跟著調整。 */
  applyTheme(): void {
    const root = document.documentElement;
    const fontSize = Number.parseFloat(getComputedStyle(root).getPropertyValue("--editor-font-size")) || 15;
    // 配色與強調色也跟著主畫面（終端機的背景、文字、游標用同一組顏色）。
    this.#forward({ kind: "style", theme: root.dataset.theme ?? null, fontSize, palette: root.dataset.palette ?? null, accent: loadAccent() || null });
  }

  applyFont(): void {
    this.applyTheme();
  }

  focus(): void {
    this.#forward({ kind: "focus" });
  }

  /** 有沒有打開的選單或對話框蓋到終端機的位置（通知不算）。 */
  #overlaysCover(): boolean {
    if (this.#el.hidden || this.#stacked) return false;
    const term = this.#el.getBoundingClientRect();
    for (const el of document.querySelectorAll<HTMLElement>(":popover-open, dialog[open]")) {
      if (el.classList.contains("toasts")) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.left < term.right && r.right > term.left && r.top < term.bottom && r.bottom > term.top) return true;
    }
    return false;
  }

  #checkCovered(): void {
    const covered = this.#overlaysCover();
    if (covered === this.#covered) return;
    this.#covered = covered;
    this.relayout();
  }

  /** 重新告訴原生端面板的位置（版面或介面縮放改變後）；被選單或對話框蓋到時先藏起來。 */
  relayout(): void {
    cancelAnimationFrame(this.#layoutFrame);
    let done = () => {};
    this.#laidOut = new Promise((resolve) => (done = resolve));
    this.#layoutFrame = requestAnimationFrame(() => {
      this.#covered = this.#overlaysCover();
      if (this.#el.hidden || this.#covered) {
        void this.#d.termLayout(null).catch(() => {}).finally(done);
        return;
      }
      // 終端機放在面板的內容區：扣掉框線（原本只有上緣 1px，調整高度的把手也在那裡）與內距
      // （區塊樣式「圓角區塊」時面板是圓角的框，終端機往內縮，直角藏在圓角裡面）。
      const r = this.#el.getBoundingClientRect();
      const s = getComputedStyle(this.#el);
      const px = (v: string) => Number.parseFloat(v) || 0;
      const left = r.left + px(s.borderLeftWidth) + px(s.paddingLeft);
      const right = r.right - px(s.borderRightWidth) - px(s.paddingRight);
      const top = r.top + px(s.borderTopWidth) + px(s.paddingTop);
      const bottom = r.bottom - px(s.borderBottomWidth) - px(s.paddingBottom);
      const z = this.#zoom();
      const height = this.#stacked ? this.#height() : bottom - top;
      void this.#d
        .termLayout({ x: left * z, y: top * z, width: (right - left) * z, height: height * z })
        .then((stacked) => {
          if (stacked === this.#stacked) return;
          this.#stacked = stacked;
          this.#el.classList.toggle("stacked", stacked);
          this.#onLayout();
          this.relayout();
        })
        .catch(() => {})
        .finally(done);
    });
  }

  #reveal(): void {
    if (!this.#el.hidden) return;
    this.#el.hidden = false;
    this.#onLayout();
    this.relayout();
    this.applyTheme();
  }

  #forward(request: Parameters<Desktop["termForward"]>[0]): void {
    void this.#d.termForward(request).catch(() => {});
  }

  /** 面板的高度（CSS 像素）。 */
  #height(): number {
    return Number.parseFloat(this.#el.style.getPropertyValue("--term-height")) || HEIGHT.default;
  }

  #setupResize(handle: HTMLElement): void {
    const set = (h: number) => {
      const max = Math.max(HEIGHT.min, window.innerHeight - 220);
      const height = Math.round(Math.min(max, Math.max(HEIGHT.min, h)));
      this.#el.style.setProperty("--term-height", `${height}px`);
      storage.save("terminal-height", String(height));
      if (this.#stacked) this.relayout();
    };
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add("resizing-rows");
      const startY = e.clientY;
      const startH = this.#height();
      const move = (ev: PointerEvent) => set(startH + (startY - ev.clientY));
      const up = () => {
        document.body.classList.remove("resizing-rows");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
    handle.addEventListener("keydown", (e) => {
      const h = this.#height();
      if (e.key === "ArrowUp") set(h + 24);
      else if (e.key === "ArrowDown") set(h - 24);
      else return;
      e.preventDefault();
    });
  }
}
