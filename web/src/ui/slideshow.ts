/**
 * 簡報模式：把文件用 `---`（分隔線）切成一頁一頁，全螢幕播放。
 * 文件中沒有分隔線時，每個一級、二級標題開始新的一頁。
 * 內容直接沿用預覽畫面（公式、流程圖、圖片都已經畫好）。
 */
import { t } from "../i18n.ts";

export interface Slide {
  nodes: Node[];
  /** 這一頁從原始碼第幾行開始（找不到時是 0）。 */
  line: number;
}

function startLine(el: Element): number {
  const pos = el.getAttribute("data-sourcepos") ?? el.querySelector("[data-sourcepos]")?.getAttribute("data-sourcepos");
  return pos ? Number(pos.split(":")[0]) || 0 : 0;
}

/** 依分隔線（沒有的話依 H1、H2）切成多頁；空白的頁面略過。 */
export function splitSlides(root: Element): Slide[] {
  const children = [...root.children];
  const byRule = children.some((c) => c.tagName === "HR");
  const slides: Slide[] = [];
  let current: Slide = { nodes: [], line: 0 };
  const flush = () => {
    if (current.nodes.length) slides.push(current);
    current = { nodes: [], line: 0 };
  };
  for (const child of children) {
    if (byRule && child.tagName === "HR") {
      flush();
      continue;
    }
    if (!byRule && (child.tagName === "H1" || child.tagName === "H2") && current.nodes.length) flush();
    if (!current.nodes.length) current.line = startLine(child);
    current.nodes.push(child.cloneNode(true));
  }
  flush();
  return slides;
}

/** 游標所在的行屬於第幾頁。 */
export function slideAtLine(slides: Slide[], line: number): number {
  let index = 0;
  slides.forEach((s, i) => {
    if (s.line && s.line <= line) index = i;
  });
  return index;
}

export class Slideshow {
  #el: HTMLElement;
  #stage: HTMLElement;
  #page: HTMLElement;
  #counter: HTMLElement;
  #slides: Slide[] = [];
  #index = 0;
  #onClose: (() => void) | null = null;
  #hideTimer = 0;

  /** 點了投影片裡的連結（和預覽一樣處理，不讓整個視窗被導走）。 */
  #onLink: (href: string) => void;

  constructor(onLink: (href: string) => void) {
    this.#onLink = onLink;
    this.#el = document.createElement("div");
    this.#el.className = "slideshow";
    this.#el.hidden = true;
    this.#el.setAttribute("role", "dialog");
    this.#el.setAttribute("aria-label", t("簡報"));
    this.#el.tabIndex = -1;
    const tr = {
      prev: t("上一頁"),
      prevTip: t("上一頁（←）"),
      next: t("下一頁"),
      nextTip: t("下一頁（→ 或空白鍵）"),
      exit: t("結束簡報"),
      exitTip: t("結束簡報（Esc）"),
    };
    this.#el.innerHTML = `
      <div class="slide-stage"><article class="slide markdown-body"></article></div>
      <div class="slide-bar">
        <button type="button" class="slide-prev" aria-label="${tr.prev}" title="${tr.prevTip}">‹</button>
        <span class="slide-counter" aria-live="polite"></span>
        <button type="button" class="slide-next" aria-label="${tr.next}" title="${tr.nextTip}">›</button>
        <button type="button" class="slide-exit" aria-label="${tr.exit}" title="${tr.exitTip}">✕</button>
      </div>`;
    this.#stage = this.#el.querySelector(".slide-stage")!;
    this.#page = this.#el.querySelector(".slide")!;
    this.#counter = this.#el.querySelector(".slide-counter")!;
    this.#el.querySelector(".slide-prev")!.addEventListener("click", () => this.go(this.#index - 1));
    this.#el.querySelector(".slide-next")!.addEventListener("click", () => this.go(this.#index + 1));
    this.#el.querySelector(".slide-exit")!.addEventListener("click", () => this.close());
    this.#stage.addEventListener("click", (e) => {
      // 連結（含流程圖裡 SVG 的 <a xlink:href>）交給編輯器處理，不讓整個視窗被導到別的網頁。
      const link = (e.target as Element).closest("a");
      if (link) {
        e.preventDefault();
        const href = link.getAttribute("href") ?? link.getAttributeNS("http://www.w3.org/1999/xlink", "href");
        if (href) this.#onLink(href);
        return;
      }
      // 點影片等不換頁；點左邊三分之一回上一頁，其他地方下一頁。
      if ((e.target as HTMLElement).closest("button, input, video, audio, summary")) return;
      this.go(this.#index + (e.clientX < innerWidth / 3 ? -1 : 1));
    });
    this.#el.addEventListener("keydown", (e) => this.#onKey(e));
    this.#el.addEventListener("mousemove", () => this.#showBar());
    document.addEventListener("fullscreenchange", () => {
      // 按 Esc 離開全螢幕時一起結束簡報。
      if (!document.fullscreenElement && !this.#el.hidden && this.#wasFullscreen) this.close();
    });
    window.addEventListener("resize", () => {
      if (!this.#el.hidden) this.#fit();
    });
    document.body.append(this.#el);
  }

  #wasFullscreen = false;

  get active(): boolean {
    return !this.#el.hidden;
  }

  /** 開始播放 `source`（預覽的內容）；`start` 是從第幾頁開始。 */
  open(slides: Slide[], start: number, onClose?: () => void): void {
    if (!slides.length) return;
    this.#slides = slides;
    this.#onClose = onClose ?? null;
    this.#el.hidden = false;
    this.#el.focus();
    this.#wasFullscreen = false;
    this.#el
      .requestFullscreen?.()
      .then(() => (this.#wasFullscreen = true))
      .catch(() => {
        // 不能全螢幕（例如瀏覽器不允許）時，仍然蓋住整個視窗播放。
      });
    this.go(start);
    this.#showBar();
  }

  close(): void {
    if (this.#el.hidden) return;
    this.#el.hidden = true;
    this.#page.replaceChildren();
    if (document.fullscreenElement === this.#el) void document.exitFullscreen().catch(() => {});
    this.#onClose?.();
  }

  go(index: number): void {
    this.#index = Math.max(0, Math.min(this.#slides.length - 1, index));
    const slide = this.#slides[this.#index];
    this.#page.replaceChildren(...slide.nodes.map((n) => n.cloneNode(true)));
    this.#counter.textContent = `${this.#index + 1} / ${this.#slides.length}`;
    this.#fit();
  }

  /** 內容太多放不下時縮小字級。 */
  #fit(): void {
    const base = Math.max(18, Math.min(innerWidth / 34, innerHeight / 19));
    let size = base;
    this.#page.style.fontSize = `${size}px`;
    const max = this.#stage.clientHeight * 0.92;
    while (this.#page.scrollHeight > max && size > 12) {
      size *= 0.92;
      this.#page.style.fontSize = `${size}px`;
    }
  }

  #showBar(): void {
    this.#el.classList.add("show-bar");
    clearTimeout(this.#hideTimer);
    this.#hideTimer = window.setTimeout(() => this.#el.classList.remove("show-bar"), 2500);
  }

  #onKey(e: KeyboardEvent): void {
    const next = ["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n", "N"];
    const prev = ["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p", "P"];
    if (next.includes(e.key)) this.go(this.#index + 1);
    else if (prev.includes(e.key)) this.go(this.#index - 1);
    else if (e.key === "Home") this.go(0);
    else if (e.key === "End") this.go(this.#slides.length - 1);
    else if (e.key === "Escape") this.close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
}
