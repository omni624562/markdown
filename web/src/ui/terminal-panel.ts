/**
 * 下方的終端機面板（桌面版）：可以開好幾個分頁，執行殼層、Claude Code 或 Codex。
 * AI 透過 MCP 執行的指令也會開一個分頁（由 Rust 端建立）。
 * xterm.js 只在第一次打開面板時才載入。
 */
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WebLinksAddon } from "@xterm/addon-web-links";
import type { Desktop, TermProgram } from "../desktop.ts";
import * as storage from "../storage.ts";
import { icon } from "./icons.ts";
import { toast } from "./toast.ts";

const LABELS: Record<TermProgram, string> = { shell: "終端機", claude: "Claude Code", codex: "Codex" };
const HEIGHT = { min: 120, default: 280 };

interface Session {
  id: number;
  /** `run`：AI 要求執行的單一指令。 */
  program: TermProgram | "run";
  label: string;
  /** 最後一次收到輸出的時間（判斷程式是否已經啟動完成）。 */
  lastOutput: number;
  term: Terminal;
  fit: FitAddon;
  host: HTMLElement;
  exited: boolean;
}

type Xterm = { Terminal: typeof Terminal; FitAddon: typeof FitAddon; WebLinksAddon: typeof WebLinksAddon };
let xterm: Promise<Xterm> | null = null;

function loadXterm(): Promise<Xterm> {
  xterm ??= Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-web-links"),
    import("@xterm/xterm/css/xterm.css"),
  ]).then(([x, f, l]) => ({ Terminal: x.Terminal, FitAddon: f.FitAddon, WebLinksAddon: l.WebLinksAddon }));
  return xterm;
}

/**
 * 終端機的 16 色。xterm 預設的色盤是給深色背景用的，在淺色背景上亮綠、亮黃很刺眼又看不清楚；
 * 淺色用較深、較柔和的顏色（參考 GitHub 淺色主題），深色配合介面的 One Dark 風格。
 */
const ANSI_LIGHT = {
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#7d4e00",
  blue: "#0550ae",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#0969da",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};
const ANSI_DARK = {
  black: "#3f4451",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#d7dae0",
  brightBlack: "#5c6370",
  brightRed: "#ef7b85",
  brightGreen: "#a5d48a",
  brightYellow: "#f0cd8c",
  brightBlue: "#74bbf5",
  brightMagenta: "#d38ce6",
  brightCyan: "#66c6d1",
  brightWhite: "#f0f2f5",
};

export class TerminalPanel {
  #el: HTMLElement;
  #tabs: HTMLElement;
  #body: HTMLElement;
  #toolButtons: Partial<Record<TermProgram, HTMLButtonElement>> = {};
  #d: Desktop;
  #sessions: Session[] = [];
  #active: Session | null = null;
  /** 還沒對應到分頁的輸出（程式啟動得比前端登記分頁還快）。 */
  #early = new Map<number, string[]>();
  /** 還沒對應到分頁就結束的程式（編號 → 結束代碼）。 */
  #exitedEarly = new Map<number, number | null>();
  #resizeTimer = 0;
  #onLayout: () => void;

  constructor(el: HTMLElement, d: Desktop, onLayout: () => void) {
    this.#el = el;
    this.#d = d;
    this.#onLayout = onLayout;
    el.innerHTML = `
      <div class="term-resize" role="separator" aria-orientation="horizontal" aria-label="調整終端機高度" tabindex="0"></div>
      <header class="term-head">
        <div class="term-tabs" role="tablist" aria-label="終端機分頁"></div>
        <div class="term-actions"></div>
      </header>
      <div class="term-body"></div>`;
    this.#tabs = el.querySelector(".term-tabs")!;
    this.#body = el.querySelector(".term-body")!;
    const actions = el.querySelector(".term-actions")!;
    const button = (label: string, iconName: string, run: () => void, iconOnly = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = iconOnly ? "btn icon-only" : "btn";
      b.title = label;
      b.setAttribute("aria-label", label);
      b.append(icon(iconName));
      if (!iconOnly) b.append(Object.assign(document.createElement("span"), { textContent: label }));
      b.addEventListener("click", run);
      actions.append(b);
      return b;
    };
    this.#toolButtons.claude = button("啟動 Claude Code", "sparkles", () => void this.start("claude"));
    this.#toolButtons.codex = button("啟動 Codex", "sparkles", () => void this.start("codex"));
    button("新增終端機", "plus", () => void this.start("shell"), true);
    button("隱藏終端機", "chevron-down", () => this.hide(), true);

    this.#el.style.setProperty("--term-height", `${Number(storage.load("terminal-height")) || HEIGHT.default}px`);
    this.#setupResize(el.querySelector(".term-resize")!);
    new ResizeObserver(() => this.#scheduleFit()).observe(this.#body);

    void d.onTermOutput(({ id, data }) => {
      const s = this.#sessions.find((x) => x.id === id);
      if (s) {
        s.term.write(data);
        s.lastOutput = Date.now();
      } else this.#early.set(id, [...(this.#early.get(id) ?? []), data]);
    });
    void d.onTermAttached(({ id, label }) => void this.#attach(id, label));
    void d.onTermExit(({ id, code }) => {
      const s = this.#sessions.find((x) => x.id === id);
      if (s) this.#markExited(s, code);
      else this.#exitedEarly.set(id, code);
    });
  }

  get visible(): boolean {
    return !this.#el.hidden;
  }

  /** 只顯示已安裝的 AI 工具按鈕。 */
  setAvailable(found: { claude: string | null; codex: string | null }): void {
    for (const t of ["claude", "codex"] as const) {
      const b = this.#toolButtons[t];
      if (b) b.hidden = !found[t];
    }
  }

  toggle(): void {
    if (this.visible) this.hide();
    else void this.show();
  }

  async show(): Promise<void> {
    this.#el.hidden = false;
    this.#onLayout();
    if (!this.#sessions.length) await this.start("shell");
    else this.#activate(this.#active ?? this.#sessions[0]);
  }

  hide(): void {
    this.#el.hidden = true;
    this.#onLayout();
  }

  /** 開一個新分頁執行指定的程式。 */
  async start(program: TermProgram): Promise<Session | null> {
    const view = await this.#createView();
    let id: number;
    try {
      id = await this.#d.termOpen(program, view.term.cols, view.term.rows);
    } catch (e) {
      view.term.dispose();
      view.host.remove();
      toast(e instanceof Error ? e.message : String(e), { tone: "error", duration: 10000 });
      if (!this.#sessions.length) this.hide();
      return null;
    }
    const count = this.#sessions.filter((s) => s.program === program).length;
    return this.#register(id, program, count ? `${LABELS[program]} ${count + 1}` : LABELS[program], view);
  }

  /** 顯示 Rust 端已經啟動的終端機（AI 執行的指令）。焦點留在編輯器，不打斷使用者。 */
  async #attach(id: number, label: string): Promise<void> {
    const view = await this.#createView();
    this.#register(id, "run", label, view, false);
    // 程式可能在前端建立分頁前就結束了。
    if (this.#exitedEarly.has(id)) {
      this.#markExited(this.#sessions.find((s) => s.id === id)!, this.#exitedEarly.get(id) ?? null);
      this.#exitedEarly.delete(id);
    }
  }

  /**
   * 把文字送到終端機中的 Claude Code／Codex 輸入列（用括號貼上模式，不會被當成按鍵指令）。
   * 沒有正在執行的 AI 時，先啟動 `preferred`，等它準備好再送出。
   */
  async sendToAi(text: string, preferred: TermProgram): Promise<boolean> {
    const isAi = (s: Session) => (s.program === "claude" || s.program === "codex") && !s.exited;
    let target = this.#active && isAi(this.#active) ? this.#active : [...this.#sessions].reverse().find(isAi);
    if (!target) {
      const started = await this.start(preferred);
      if (!started) return false;
      target = started;
      await this.#settled(target);
    } else {
      this.#el.hidden = false;
      this.#onLayout();
      this.#activate(target);
    }
    await this.#d.termWrite(target.id, `\x1b[200~${text}\x1b[201~`);
    target.term.focus();
    return true;
  }

  /** 開一個新的終端機執行一行指令；使用者看得到過程，也可以接著操作。 */
  async runInShell(command: string): Promise<void> {
    const s = await this.start("shell");
    if (!s) return;
    await this.#settled(s);
    await this.#d.termWrite(s.id, `${command}\r`);
  }

  /** 等程式開始輸出，而且安靜一小段時間（啟動畫面畫完），最多等 20 秒。 */
  async #settled(s: Session): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 20_000 && !s.exited) {
      if (s.lastOutput && Date.now() - s.lastOutput > 1200) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async #createView(): Promise<{ term: Terminal; fit: FitAddon; host: HTMLElement }> {
    this.#el.hidden = false;
    this.#onLayout();
    const { Terminal, FitAddon, WebLinksAddon } = await loadXterm();
    const host = document.createElement("div");
    host.className = "term-host";
    this.#body.append(host);
    const term = new Terminal({
      ...this.#font(),
      cursorBlink: true,
      allowProposedApi: false,
      scrollback: 5000,
      // 文字和底色太接近時（例如淺色背景上的黃字）自動調深或調淺，維持好讀的對比。
      minimumContrastRatio: 4.5,
      theme: this.#theme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // 網址：Ctrl（⌘）＋點用預設瀏覽器開啟（例如 Claude Code 登入、錯誤訊息裡的連結）。
    term.loadAddon(
      new WebLinksAddon((e, uri) => {
        if (e.ctrlKey || e.metaKey) void this.#d.openExternal(uri).catch(() => toast("無法開啟這個網址。"));
      }),
    );
    term.open(host);
    fit.fit();
    // 有選取文字時 Ctrl+C 是複製，否則照常送出中斷；Ctrl+V 交給瀏覽器貼上。
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !(e.ctrlKey || e.metaKey)) return true;
      const k = e.key.toLowerCase();
      if (k === "c" && (e.shiftKey || term.hasSelection())) {
        void navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      if (k === "v") return false;
      return true;
    });

    return { term, fit, host };
  }

  #register(
    id: number,
    program: Session["program"],
    label: string,
    view: { term: Terminal; fit: FitAddon; host: HTMLElement },
    focus = true,
  ): Session {
    const early = this.#early.get(id) ?? [];
    const session: Session = { id, program, label, lastOutput: early.length ? Date.now() : 0, ...view, exited: false };
    this.#sessions.push(session);
    for (const data of early) view.term.write(data);
    this.#early.delete(id);
    view.term.onData((data) => {
      if (session.exited) this.close(session);
      else void this.#d.termWrite(id, data).catch(() => {});
    });
    this.#activate(session, focus);
    return session;
  }

  #markExited(s: Session, code: number | null): void {
    s.exited = true;
    s.term.write(`\r\n\x1b[2m[程式已結束${code ? `（代碼 ${code}）` : ""}，按任意鍵關閉這個分頁]\x1b[0m\r\n`);
    this.#renderTabs();
  }

  close(session: Session): void {
    if (!session.exited) void this.#d.termClose(session.id).catch(() => {});
    session.term.dispose();
    session.host.remove();
    const i = this.#sessions.indexOf(session);
    this.#sessions.splice(i, 1);
    if (this.#active === session) {
      this.#active = null;
      const next = this.#sessions[Math.min(i, this.#sessions.length - 1)];
      if (next) this.#activate(next);
      else this.hide();
    }
    this.#renderTabs();
  }

  /** 字型跟著編輯區的字級（小一號），中文用台灣的字型。 */
  #font(): { fontFamily: string; fontSize: number; lineHeight: number } {
    const css = getComputedStyle(document.documentElement);
    const editorSize = Number.parseFloat(css.getPropertyValue("--editor-font-size")) || 15;
    return {
      fontFamily: css.getPropertyValue("--font-term").trim() || "monospace",
      fontSize: Math.max(12, editorSize - 1),
      lineHeight: 1.2,
    };
  }

  /** 編輯區字級改變後，終端機一起調整。 */
  applyFont(): void {
    const font = this.#font();
    for (const s of this.#sessions) Object.assign(s.term.options, font);
    this.#scheduleFit();
  }

  /** 主題切換後更新配色。 */
  applyTheme(): void {
    const theme = this.#theme();
    for (const s of this.#sessions) s.term.options.theme = theme;
  }

  focus(): void {
    this.#active?.term.focus();
  }

  #activate(session: Session, focus = true): void {
    this.#active = session;
    for (const s of this.#sessions) s.host.hidden = s !== session;
    this.#renderTabs();
    requestAnimationFrame(() => {
      this.#fit(session);
      if (focus) session.term.focus();
    });
  }

  /** 有沒有正在執行的 Claude Code／Codex 分頁。 */
  get hasAiSession(): boolean {
    return this.#sessions.some((s) => (s.program === "claude" || s.program === "codex") && !s.exited);
  }

  #renderTabs(): void {
    this.#tabs.replaceChildren(
      ...this.#sessions.map((s) => {
        const tab = document.createElement("div");
        tab.className = "term-tab";
        tab.role = "tab";
        tab.tabIndex = s === this.#active ? 0 : -1;
        tab.setAttribute("aria-selected", String(s === this.#active));
        tab.classList.toggle("exited", s.exited);
        tab.append(Object.assign(document.createElement("span"), { textContent: s.label }));
        const close = document.createElement("button");
        close.type = "button";
        close.className = "tab-close";
        close.tabIndex = -1;
        close.setAttribute("aria-label", `關閉「${s.label}」`);
        close.title = "關閉（會結束這個程式）";
        close.append(icon("x"));
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          this.close(s);
        });
        tab.append(close);
        tab.addEventListener("click", () => this.#activate(s));
        return tab;
      }),
    );
  }

  #scheduleFit(): void {
    clearTimeout(this.#resizeTimer);
    this.#resizeTimer = window.setTimeout(() => this.#active && this.#fit(this.#active), 60);
  }

  #fit(s: Session): void {
    if (this.#el.hidden || s.host.hidden) return;
    const { cols, rows } = s.term;
    s.fit.fit();
    if ((s.term.cols !== cols || s.term.rows !== rows) && !s.exited) {
      void this.#d.termResize(s.id, s.term.cols, s.term.rows).catch(() => {});
    }
  }

  /** 配色跟著主題。CSS 變數是 light-dark(…)，xterm 看不懂，先讓瀏覽器算出實際的顏色。 */
  #theme() {
    const probe = document.createElement("span");
    probe.hidden = true;
    this.#el.append(probe);
    const color = (name: string) => {
      probe.style.color = `var(${name})`;
      return getComputedStyle(probe).color || undefined;
    };
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = {
      background: color("--surface"),
      foreground: color("--fg"),
      cursor: color("--accent"),
      cursorAccent: color("--surface"),
      selectionBackground: color("--accent-soft"),
      ...(dark ? ANSI_DARK : ANSI_LIGHT),
    };
    probe.remove();
    return theme;
  }

  #setupResize(handle: HTMLElement): void {
    const set = (h: number) => {
      const max = Math.max(HEIGHT.min, window.innerHeight - 220);
      const height = Math.round(Math.min(max, Math.max(HEIGHT.min, h)));
      this.#el.style.setProperty("--term-height", `${height}px`);
      storage.save("terminal-height", String(height));
    };
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add("resizing-rows");
      const startY = e.clientY;
      const startH = this.#el.getBoundingClientRect().height;
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
      const h = this.#el.getBoundingClientRect().height;
      if (e.key === "ArrowUp") set(h + 24);
      else if (e.key === "ArrowDown") set(h - 24);
      else return;
      e.preventDefault();
    });
  }
}
