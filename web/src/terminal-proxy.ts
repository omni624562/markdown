/**
 * 主畫面這一端的終端機面板（桌面版）。
 *
 * 終端機本身在獨立的 webview（`terminal.html`），疊在這個元素的位置上；這裡只負責留出位置、
 * 調整高度，並透過 Rust 送幾種固定的要求（`term_forward`）。主畫面不能寫入終端機：
 * 開啟的文件萬一夾帶了程式碼，也不能拿終端機執行指令。
 */
import type { Desktop, TermNotice, TermProgram } from "./desktop.ts";
import { t } from "./i18n.ts";
import * as storage from "./storage.ts";

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

  /** 只顯示已安裝的 AI 工具按鈕。 */
  setAvailable(found: { claude: string | null; codex: string | null }): void {
    this.#forward({ kind: "available", claude: !!found.claude, codex: !!found.codex });
  }

  /** 主題或編輯區字級改變後，終端機跟著調整。 */
  applyTheme(): void {
    const root = document.documentElement;
    const fontSize = Number.parseFloat(getComputedStyle(root).getPropertyValue("--editor-font-size")) || 15;
    this.#forward({ kind: "style", theme: root.dataset.theme ?? null, fontSize });
  }

  applyFont(): void {
    this.applyTheme();
  }

  focus(): void {
    this.#forward({ kind: "focus" });
  }

  /** 重新告訴原生端面板的位置（版面或介面縮放改變後）。 */
  relayout(): void {
    cancelAnimationFrame(this.#layoutFrame);
    let done = () => {};
    this.#laidOut = new Promise((resolve) => (done = resolve));
    this.#layoutFrame = requestAnimationFrame(() => {
      if (this.#el.hidden) {
        void this.#d.termLayout(null).catch(() => {}).finally(done);
        return;
      }
      const r = this.#el.getBoundingClientRect();
      // 上緣的 1px 是面板的框線（調整高度的把手也在這裡）。
      const top = r.top + 1;
      const z = this.#zoom();
      const height = this.#stacked ? this.#height() : r.bottom - top;
      void this.#d
        .termLayout({ x: r.left * z, y: top * z, width: r.width * z, height: height * z })
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
