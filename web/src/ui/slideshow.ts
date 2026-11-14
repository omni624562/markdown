/**
 * 簡報模式：把文件用 `---`（分隔線）切成一頁一頁，全螢幕播放。
 * 文件中沒有分隔線時，每個一級、二級標題開始新的一頁。
 * 內容直接沿用預覽畫面（公式、流程圖、圖片都已經畫好）。
 *
 * 字級：一頁放得下就用大字；放不下先縮小，最小縮到大字的一半（還看得清楚），再放不下就接著分成好幾頁
 * （在段落之間分開，很長的清單在項目之間分開，後面的頁面標題加上「（續）」），不會縮成小字又被切掉。
 * 一頁怎麼分、用多大的字在打開時（和視窗大小改變後）算好一次，換頁時直接顯示，不用每次重新量。
 * 單一一塊就比一頁還高（很長的表格、程式碼）時，那一頁可以上下捲動。
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

/** 實際播放的一頁：可能是一段很長的內容切出來的其中一部分。 */
interface Page {
  nodes: Node[];
  line: number;
  /** 字級（px）。 */
  size: number;
  /** 來自第幾段（`Slide`）。 */
  from: number;
}

export interface SlideshowOptions {
  /** 點了投影片裡的連結（和預覽一樣處理，不讓整個視窗被導走）。 */
  onLink(href: string): void;
  /**
   * 切換視窗全螢幕（桌面版用原生的視窗全螢幕）。沒有時用網頁的全螢幕（`requestFullscreen`）。
   */
  fullscreen?(on: boolean): Promise<void>;
}

/** 標題或只有粗體的一行（例如「**第 3 天**」）：不要留在一頁的最後面，和下面的內容放同一頁。 */
function isLabel(el: Element): boolean {
  if (/^H[3-6]$/.test(el.tagName)) return true;
  return el.tagName === "P" && el.childElementCount === 1 && el.firstElementChild!.tagName === "STRONG" && el.textContent!.trim() === el.firstElementChild!.textContent!.trim();
}

export class Slideshow {
  #el: HTMLElement;
  #stage: HTMLElement;
  #page: HTMLElement;
  #counter: HTMLElement;
  #slides: Slide[] = [];
  #pages: Page[] = [];
  #index = 0;
  #onClose: (() => void) | null = null;
  #hideTimer = 0;
  #resizeTimer = 0;
  #layoutSeq = 0;
  #opts: SlideshowOptions;
  /** 用網頁的全螢幕（`requestFullscreen`）進入了全螢幕。 */
  #wasFullscreen = false;

  constructor(opts: SlideshowOptions) {
    this.#opts = opts;
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
        if (href) this.#opts.onLink(href);
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
    // 視窗大小改變（包括剛進入全螢幕）：停下來之後重新分頁，停在原本看的地方。
    window.addEventListener("resize", () => {
      if (this.#el.hidden) return;
      clearTimeout(this.#resizeTimer);
      this.#resizeTimer = window.setTimeout(() => void this.#layout(), 150);
    });
    document.body.append(this.#el);
  }

  get active(): boolean {
    return !this.#el.hidden;
  }

  /** 開始播放 `slides`（預覽的內容）；`start` 是從第幾段開始。 */
  open(slides: Slide[], start: number, onClose?: () => void): void {
    if (!slides.length) return;
    this.#slides = slides;
    this.#pages = [];
    this.#index = 0;
    this.#onClose = onClose ?? null;
    this.#el.hidden = false;
    this.#el.focus();
    this.#wasFullscreen = false;
    if (this.#opts.fullscreen) {
      this.#opts.fullscreen(true).catch(() => {
        // 不能全螢幕時，仍然蓋住整個視窗播放。
      });
    } else {
      this.#el
        .requestFullscreen?.()
        .then(() => (this.#wasFullscreen = true))
        .catch(() => {
          // 不能全螢幕（例如瀏覽器不允許）時，仍然蓋住整個視窗播放。
        });
    }
    void this.#layout(start);
    this.#showBar();
  }

  close(): void {
    if (this.#el.hidden) return;
    this.#el.hidden = true;
    this.#layoutSeq++;
    clearTimeout(this.#resizeTimer);
    this.#page.replaceChildren();
    const onClose = this.#onClose;
    // 全螢幕還沒結束前，頁面其他部分不能取得焦點（游標放不回編輯器），要等離開全螢幕後再交回。
    // 萬一一直沒有離開全螢幕的通知，一秒後照樣交回。
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      onClose?.();
    };
    if (this.#opts.fullscreen) {
      this.#opts.fullscreen(false).then(finish, finish);
    } else if (document.fullscreenElement === this.#el) {
      void document.exitFullscreen().then(finish, finish);
    } else {
      finish();
      return;
    }
    setTimeout(finish, 1000);
  }

  go(index: number): void {
    if (!this.#pages.length) return;
    this.#index = Math.max(0, Math.min(this.#pages.length - 1, index));
    const page = this.#pages[this.#index];
    this.#page.style.fontSize = `${page.size}px`;
    this.#page.replaceChildren(...page.nodes.map((n) => n.cloneNode(true)));
    this.#counter.textContent = `${this.#index + 1} / ${this.#pages.length}`;
    // 一塊就比一頁還高（很長的表格、程式碼）：從上面開始顯示，可以上下捲動。
    this.#stage.scrollTop = 0;
    this.#el.classList.toggle("slide-tall", this.#page.scrollHeight > this.#room());
  }

  /** 一頁可以放的高度（舞台扣掉上下的留白）。 */
  #room(): number {
    const s = getComputedStyle(this.#stage);
    return this.#stage.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom);
  }

  /** 依目前的視窗大小分頁；`start` 是要顯示的段落（沒給時留在原本看的地方）。 */
  async #layout(start?: number): Promise<void> {
    const seq = ++this.#layoutSeq;
    const current = this.#pages[this.#index];
    const from = start ?? current?.from ?? 0;
    const line = start === undefined ? (current?.line ?? 0) : 0;
    const room = this.#room();
    const big = Math.max(18, Math.min(innerWidth / 34, innerHeight / 19));
    const small = Math.max(16, big / 2);
    const pages: Page[] = [];
    this.#el.classList.add("slide-measuring");
    for (const [i, slide] of this.#slides.entries()) {
      this.#page.replaceChildren(...slide.nodes.map((n) => n.cloneNode(true)));
      // 圖片的高度要等讀進來才知道（預覽裡已經讀過，通常馬上就好）。
      await this.#imagesReady();
      if (seq !== this.#layoutSeq) return;
      pages.push(...this.#fit(slide, i, room, big, small));
    }
    this.#el.classList.remove("slide-measuring");
    this.#pages = pages;
    // 停在原本那一段（視窗大小改變時，停在原本看的那一頁的開頭所在的那一頁）。
    let index = pages.findIndex((p) => p.from === from);
    pages.forEach((p, j) => {
      if (p.from === from && line && p.line && p.line <= line) index = j;
    });
    this.go(Math.max(0, index));
  }

  async #imagesReady(): Promise<void> {
    const imgs = [...this.#page.querySelectorAll("img")].filter((img) => !img.complete);
    if (!imgs.length) return;
    const wait = Promise.all(imgs.map((img) => img.decode().catch(() => undefined)));
    await Promise.race([wait, new Promise((r) => setTimeout(r, 1500))]);
  }

  /** 一段內容（已經放在 `#page` 裡）要用多大的字，或要分成幾頁。 */
  #fit(slide: Slide, from: number, room: number, big: number, small: number): Page[] {
    const fits = (size: number) => {
      this.#page.style.fontSize = `${size}px`;
      return this.#page.scrollHeight <= room;
    };
    if (fits(big)) return [{ nodes: slide.nodes, line: slide.line, size: big, from }];
    if (fits(small)) {
      // 放得下的最大字級（二分搜尋，量幾次就好）。
      let lo = small;
      let hi = big;
      for (let k = 0; k < 6; k++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      return [{ nodes: slide.nodes, line: slide.line, size: lo, from }];
    }
    // 小字也放不下：用小字分成好幾頁。
    fits(small);
    return this.#split(room).map((nodes) => ({ nodes, line: lineOf(nodes) || slide.line, size: small, from }));
  }

  /** 把 `#page` 裡的內容（已經是小字）在段落之間（清單在項目之間）分成好幾頁。 */
  #split(room: number): Node[][] {
    const blocks = [...this.#page.children] as HTMLElement[];
    // 每一塊佔的高度（含和下一塊之間的距離）。
    const tops = blocks.map((b) => b.offsetTop);
    const heightOf = (i: number) => (i + 1 < blocks.length ? tops[i + 1] : this.#page.scrollHeight) - tops[i];
    const heading = blocks[0] && /^H[12]$/.test(blocks[0].tagName) ? blocks[0] : null;
    const headingH = heading ? heightOf(0) : 0;
    const pages: Node[][] = [];
    type Entry = { node: Node; h: number; label: boolean };
    let page: Entry[] = [];
    let used = 0;
    const add = (node: Node, h: number, label: boolean) => {
      page.push({ node, h, label });
      used += h;
    };
    const startPage = (carry: Entry[]) => {
      page = [];
      used = 0;
      // 後面的頁面重複這一段的標題（加上「（續）」）。
      if (heading && pages.length) add(continued(heading), headingH, true);
      for (const c of carry) add(c.node, c.h, c.label);
    };
    /** 這一頁只有標題、小標，還沒有內容（不能就這樣成為一頁）。 */
    const bare = () => page.every((e) => e.label);
    const flush = () => {
      if (bare()) return;
      // 標題、粗體的小標不留在一頁的最後面，帶到下一頁。
      const carry: Entry[] = [];
      while (page[page.length - 1].label) carry.unshift(page.pop()!);
      pages.push(page.map((e) => e.node));
      startPage(carry);
    };
    const ctx = { room, used: () => used, bare, add, flush };
    startPage([]);
    blocks.forEach((block, i) => {
      const h = heightOf(i);
      const label = block === heading || isLabel(block);
      if (used + h <= room) return add(block.cloneNode(true), h, label);
      if ((block.tagName === "UL" || block.tagName === "OL") && block.children.length > 1) return this.#splitList(block, ctx);
      flush();
      // 一塊就比一頁還高（表格、程式碼）：和前面的標題放同一頁，那一頁可以捲動。
      add(block.cloneNode(true), h, label);
    });
    if (!bare() || !pages.length) pages.push(page.map((e) => e.node));
    else {
      // 最後只剩小標（後面沒有內容了）：接在前一頁後面，不另外成一頁。
      const rest = page.filter((e) => !(e.node instanceof Element && e.node.classList.contains("slide-cont-head")));
      pages[pages.length - 1].push(...rest.map((e) => e.node));
    }
    return pages;
  }

  /** 很長的清單：在項目之間分開，每一頁放得下的項目各成一份清單（編號的清單接著原本的編號）。 */
  #splitList(
    list: HTMLElement,
    ctx: { room: number; used(): number; bare(): boolean; add(node: Node, h: number, label: boolean): void; flush(): void },
  ): void {
    const items = [...list.children] as HTMLElement[];
    const listBottom = list.offsetTop + list.offsetHeight;
    const startNumber = list.tagName === "OL" ? Number(list.getAttribute("start") ?? 1) : 1;
    let chunk: HTMLElement[] = [];
    let chunkTop = 0;
    let first = 0;
    const emit = (end: number) => {
      if (!chunk.length) return;
      const copy = list.cloneNode(false) as HTMLElement;
      if (list.tagName === "OL") copy.setAttribute("start", String(startNumber + first));
      copy.append(...chunk.map((li) => li.cloneNode(true)));
      ctx.add(copy, end - chunkTop, false);
      chunk = [];
    };
    items.forEach((li, i) => {
      const top = li.offsetTop;
      const bottom = i + 1 < items.length ? items[i + 1].offsetTop : listBottom;
      const start = chunk.length ? chunkTop : top;
      // 加上這一項會超出這一頁：前面的項目留在這一頁，這一項從新的一頁開始。
      if (ctx.used() + (bottom - start) > ctx.room && (chunk.length || !ctx.bare())) {
        emit(top);
        ctx.flush();
      }
      if (!chunk.length) {
        chunkTop = top;
        first = i;
      }
      chunk.push(li);
    });
    emit(listBottom);
  }

  #showBar(): void {
    this.#el.classList.add("show-bar");
    clearTimeout(this.#hideTimer);
    this.#hideTimer = window.setTimeout(() => this.#el.classList.remove("show-bar"), 2500);
  }

  /** 可以捲動的一頁還沒捲到底（或頂）時，往下（上）捲一段，不換頁。 */
  #scroll(dir: 1 | -1): boolean {
    const s = this.#stage;
    if (!this.#el.classList.contains("slide-tall")) return false;
    const left = dir > 0 ? s.scrollHeight - s.clientHeight - s.scrollTop : s.scrollTop;
    if (left <= 1) return false;
    s.scrollBy({ top: dir * s.clientHeight * 0.8 });
    return true;
  }

  #onKey(e: KeyboardEvent): void {
    const next = ["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n", "N"];
    const prev = ["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p", "P"];
    const scrollKeys = ["ArrowDown", "PageDown", " ", "ArrowUp", "PageUp"];
    if (scrollKeys.includes(e.key) && this.#scroll(next.includes(e.key) ? 1 : -1)) {
      // 可以捲動的那一頁：先捲到底才換頁。
    } else if (next.includes(e.key)) this.go(this.#index + 1);
    else if (prev.includes(e.key)) this.go(this.#index - 1);
    else if (e.key === "Home") this.go(0);
    else if (e.key === "End") this.go(this.#pages.length - 1);
    else if (e.key === "Escape") this.close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
}

/** 一頁內容從原始碼第幾行開始。 */
function lineOf(nodes: Node[]): number {
  for (const n of nodes) {
    if (n instanceof Element && !n.classList.contains("slide-cont-head")) {
      const line = startLine(n);
      if (line) return line;
    }
  }
  return 0;
}

/** 分成好幾頁時，後面的頁面重複這一段的標題，加上「（續）」。 */
function continued(heading: Element): Node {
  const copy = heading.cloneNode(true) as HTMLElement;
  copy.classList.add("slide-cont-head");
  copy.removeAttribute("id");
  copy.append(Object.assign(document.createElement("span"), { className: "slide-cont", textContent: t("（續）") }));
  return copy;
}
