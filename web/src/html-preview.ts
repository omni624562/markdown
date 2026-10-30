/**
 * 網頁檔（.html、.htm）的預覽：用 iframe 照網頁本身的樣子顯示（含它自己的 CSS）。
 *
 * 安全：
 * - iframe 的 sandbox 只開 same-origin（讓本程式攔下連結），不允許腳本、表單、彈出視窗、導向主畫面。
 * - 內容另外加一份 CSP：不執行腳本，不載入外部 CSS、字型；圖片照「封鎖遠端圖片」設定。
 * - `<script>`、`<base>`、`<meta http-equiv>`（自動轉址、別的 CSP）先拿掉。
 */

import { blockRemoteImages, stripRemoteCss } from "./remote-images.ts";

/** 檔名是網頁檔嗎。 */
export function isHtmlName(name: string): boolean {
  return /\.html?$/i.test(name);
}

export interface HtmlPreviewOptions {
  /** 不載入網路上的圖片。 */
  blockRemote: boolean;
  /** 相對路徑的圖片換成程式能讀的網址；不換（例如沒有存檔位置）回傳 null。 */
  image?(src: string): string | null;
}

/** 預覽用的完整 HTML（給 iframe 的 srcdoc）。 */
export function prepareHtml(source: string, opts: HtmlPreviewOptions): string {
  const doc = new DOMParser().parseFromString(source, "text/html");
  for (const el of doc.querySelectorAll("script, base, meta[http-equiv], noscript, object, embed, iframe, frame")) el.remove();
  for (const el of doc.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      // onclick 等事件屬性（腳本本來就不會執行，拿掉比較乾淨）。
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
  }
  for (const img of doc.querySelectorAll<HTMLImageElement>("img[src]")) {
    img.removeAttribute("srcset");
    const src = img.getAttribute("src")!;
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)) continue;
    const url = opts.image?.(src);
    if (url) img.setAttribute("src", url);
  }
  if (opts.blockRemote) {
    // 放進畫面之前就拿掉遠端網址（CSP 之外再擋一層）：圖片、CSS 裡的 url()、@import。
    blockRemoteImages(doc);
    for (const style of doc.querySelectorAll("style")) style.textContent = stripRemoteCss(style.textContent ?? "");
    for (const el of doc.querySelectorAll<HTMLElement>("[style]")) el.setAttribute("style", stripRemoteCss(el.getAttribute("style")!));
  }
  const remote = opts.blockRemote ? "" : " https: http:";
  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src data: blob: mdimg: http://mdimg.localhost${remote}`,
    "font-src data:",
    "media-src data:",
    "form-action 'none'",
  ].join("; ");
  doc.head.prepend(csp);
  if (!doc.querySelector("meta[charset]")) {
    const charset = doc.createElement("meta");
    charset.setAttribute("charset", "utf-8");
    doc.head.prepend(charset);
  }
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

/** 預覽區裡的 iframe：內容改變時換掉 srcdoc，並留在原本捲動的位置。 */
export class HtmlPreview {
  readonly el: HTMLIFrameElement;
  #html = "";
  #key = "";
  #scroll = { x: 0, y: 0 };

  /** `follow`：點了網頁裡的連結（`#錨點` 在預覽裡捲動，其他交給程式處理）。 */
  constructor(parent: HTMLElement, follow: (href: string) => void) {
    this.el = document.createElement("iframe");
    this.el.className = "html-preview";
    this.el.setAttribute("sandbox", "allow-same-origin");
    this.el.setAttribute("referrerpolicy", "no-referrer");
    this.el.hidden = true;
    this.el.addEventListener("load", () => {
      const win = this.el.contentWindow;
      const doc = this.el.contentDocument;
      if (!win || !doc) return;
      win.scrollTo(this.#scroll.x, this.#scroll.y);
      doc.addEventListener("click", (e) => {
        const a = (e.target as Element).closest?.("a[href]");
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute("href")!;
        if (href.startsWith("#")) {
          const id = decodeURIComponent(href.slice(1));
          (doc.getElementById(id) ?? doc.getElementsByName(id)[0])?.scrollIntoView();
        } else follow(href);
      });
    });
    parent.append(this.el);
  }

  get shown(): boolean {
    return !this.el.hidden;
  }

  /** `key` 是哪一份文件（換文件時從最上面開始，同一份文件改內容時留在原本的位置）。 */
  show(source: string, key: string, opts: HtmlPreviewOptions): void {
    this.el.hidden = false;
    const html = prepareHtml(source, opts);
    if (html === this.#html && key === this.#key) return;
    const win = this.el.contentWindow;
    this.#scroll = win && this.#html && key === this.#key ? { x: win.scrollX, y: win.scrollY } : { x: 0, y: 0 };
    this.#key = key;
    this.#html = html;
    this.el.srcdoc = html;
  }

  /** 不是網頁檔（或沒有顯示預覽）：藏起來，下次換檔從最上面開始。 */
  hide(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.#html = "";
    this.#key = "";
    this.el.removeAttribute("srcdoc");
  }
}
