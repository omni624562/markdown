/**
 * 封鎖遠端圖片（設定「封鎖遠端圖片」）：文件中的 `![](https://…)` 一顯示就會連到對方的伺服器，
 * 對方可以藉此知道你何時開啟文件、你的 IP（類似電子郵件的「已讀回條」）。
 * 開啟這個設定時，遠端圖片在放進畫面「之前」就拿掉網址，所以完全不會發出連線。
 *
 * 「是不是遠端」照瀏覽器實際解析的結果判斷，不比對字串：`https:主機/…`（少了 `//`）、`\\主機\…`、
 * `/\主機` 這些寫法瀏覽器一樣會連出去。CSS 也一樣，跳脫字元（`\68ttps`）、`image-set()` 都算。
 */

import { t } from "./i18n.ts";

/** 本程式自己提供圖片的網址（Windows 上的 mdimg 協定是 `http://mdimg.localhost`），不算遠端。 */
const APP_ORIGINS = new Set(["http://mdimg.localhost", "https://mdimg.localhost"]);

/** 解析相對網址的基準：目前的頁面（`http://tauri.localhost`、`tauri://localhost` 或網頁版的網址）。 */
function pageBase(): string {
  return typeof document === "undefined" ? "http://localhost/" : document.baseURI;
}

/**
 * 這個網址放進畫面（圖片、CSS）會不會連到別的伺服器：照 `base` 解析成完整網址，
 * 是 http(s) 而且不是本程式自己的網址就算遠端。解析失敗的網址不會發出連線。
 */
export function isRemoteUrl(src: string, base = pageBase()): boolean {
  let url: URL;
  try {
    url = new URL(src, base);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.origin !== new URL(base).origin && !APP_ORIGINS.has(url.origin);
}

/**
 * `srcset` 裡有沒有遠端網址。逗號可以是網址的一部分，所以每個空白或逗號後面都當成可能的開頭檢查（寧可多擋）。
 */
export function srcsetIsRemote(srcset: string, base = pageBase()): boolean {
  for (let i = 0; i < srcset.length; i++) {
    if (/[\s,]/.test(srcset[i]) || (i > 0 && !/[\s,]/.test(srcset[i - 1]))) continue;
    const url = /^\S*/.exec(srcset.slice(i))![0].replace(/,+$/, "");
    if (isRemoteUrl(url, base)) return true;
  }
  return false;
}

/** CSS 的跳脫字元（`\68`、`\h`）換回原本的字，只用來判斷，不寫回去。 */
function unescapeCss(css: string): string {
  return css.replace(/\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?|(\r\n|[\r\n\f])|([\s\S]))/gi, (_, hex, newline, ch) => {
    if (newline) return "";
    if (!hex) return ch;
    const code = parseInt(hex, 16);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\ufffd" : String.fromCodePoint(code);
  });
}

/** 會下載東西的 CSS 函式與規則（寧可多擋：`image()`、`src()` 目前沒有瀏覽器支援，也算）。 */
const LOADING_FUNCTIONS = /@import|(?:image-set|image|cross-fade|src)\(/;
/**
 * 瀏覽器實際會下載的寫法（`url(…)` 另外判斷）。流程圖的每一行分不出是 CSS 還是文字，只看這些，
 * 免得循序圖的訊息「build image(s)」被改掉。
 */
const FETCHING_FUNCTIONS = /@import|image-set\(/;

/**
 * 這段 CSS 會不會讓瀏覽器去下載東西：`url(…)`（文件內的 `#id` 與內嵌的 `data:` 除外）、`image-set()`、
 * `image()`、`cross-fade()`、`src()`、`@import`，跳脫字元寫成的也算。寧可多擋：不管寫在哪裡（字串、註解）都算。
 */
export function cssLoadsRemote(css: string, functions = LOADING_FUNCTIONS): boolean {
  if (!/[\\(@]/.test(css)) return false;
  const text = unescapeCss(css).toLowerCase();
  if (functions.test(text)) return true;
  for (const m of text.matchAll(/url\(\s*["']?\s*/g)) {
    if (!/^(?:#|data:)/.test(text.slice(m.index + m[0].length))) return true;
  }
  return false;
}

/**
 * 拿掉 CSS（`<style>` 的內容或 `style` 屬性）裡會下載東西的宣告（見 `cssLoadsRemote`）。
 * 用 `;`、`{`、`}` 粗略切開，拿掉有問題的段落；切錯（例如字串裡有分號）而整段仍有問題時，整段都不要。
 */
export function stripRemoteCss(css: string): string {
  if (!cssLoadsRemote(css)) return css;
  const out = css.replace(/[^;{}]+/g, (part) => (cssLoadsRemote(part) ? "" : part));
  return cssLoadsRemote(out) ? "" : out;
}

/** 把 `root` 中的遠端圖片換成提示文字（要在放進畫面之前呼叫，例如 `<template>` 的內容）。 */
export function blockRemoteImages(root: ParentNode): void {
  for (const img of root.querySelectorAll<HTMLImageElement>("img[src]")) {
    const src = img.getAttribute("src")!;
    if (!isRemoteUrl(src)) continue;
    img.removeAttribute("src");
    img.removeAttribute("srcset");
    img.dataset.blockedSrc = src;
    img.classList.add("remote-blocked");
    img.alt = img.alt ? t("🖼 {alt}（已封鎖遠端圖片）", { alt: img.alt }) : t("🖼 圖片（已封鎖遠端圖片）");
    img.title = t("已封鎖遠端圖片：{src}\n按一下載入這份文件的遠端圖片；也可以在「設定 → 外觀」關閉「封鎖遠端圖片」", { src });
  }
  for (const el of root.querySelectorAll("[srcset]")) {
    if (srcsetIsRemote(el.getAttribute("srcset")!)) el.removeAttribute("srcset");
  }
}

/** 1×1 的透明 GIF。 */
const BLANK_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** 會載入網址的屬性（`xlink:href` 的 localName 也是 `href`；`<a>` 的 href 是連結，不算）。 */
const URL_ATTRS = new Set(["src", "href", "background", "poster", "data", "lowsrc", "dynsrc"]);

/** 屬性名稱與等號（任何名稱：`fill`、`mask`、`cursor` 等 SVG 屬性也可以寫 `url(…)`）。 */
const ATTR_NAME = /(?<![\w:.-])([a-z][\w:.-]*)\s*=\s*/gi;
/** 屬性值：不加引號的和 HTML 一樣到空白或 `>` 為止（中間的 `'` 也算在值裡；`"` 是 Mermaid 標籤的結尾）。 */
const ATTR_VALUE = /"[^"]*"?|'[^']*'?|[^\s>"]*/y;

/**
 * 這個屬性值會不會連到遠端。值裡有字元參照（`&#104;`、Mermaid 自己的 `#104;`，Mermaid 放進標籤前會換回原本的字）
 * 或反斜線時看不出真正的網址，一律當成遠端。
 */
function attrLoadsRemote(attr: string, value: string, hrefLoads: boolean): boolean {
  const encoded = /[&\\]|#\w+;/.test(value);
  switch (attr) {
    case "src":
    case "background":
    case "poster":
    case "data":
    case "lowsrc":
    case "dynsrc":
      return encoded || isRemoteUrl(value);
    case "srcset":
      return encoded || srcsetIsRemote(value);
    case "href":
    case "xlink:href":
      return hrefLoads && (encoded || isRemoteUrl(value));
    case "style":
      return /&|#\w+;/.test(value) || cssLoadsRemote(value);
    default:
      return cssLoadsRemote(value) || (/&|#\w+;/.test(value) && /[(]|&#|#\d+;|par/i.test(value));
  }
}

/**
 * 流程圖原始碼裡標籤的屬性：會連到遠端的值換掉（`src` 換成透明圖片，其他清空）。連結（`<a href>`）只有圖裡有
 * `<image>` 這類會用 href 載入的標籤時才處理。每個 `名稱=` 都檢查，不會因為前一個屬性的值把後面的字吃掉而漏看
 * （例如 `title='x <img src=…>'` 放在標籤外面時，裡面的 `<img>` 是真的標籤）；重疊的範圍合併成一段。
 */
function blockRemoteAttrs(code: string): string {
  const hrefLoads = /<(?:image|feimage|use|link|base)\b/i.test(code);
  const cuts: { start: number; end: number; text: string }[] = [];
  for (const m of code.matchAll(ATTR_NAME)) {
    const start = m.index + m[0].length;
    ATTR_VALUE.lastIndex = start;
    const quoted = ATTR_VALUE.exec(code)![0];
    const q = /^["']/.test(quoted) ? quoted[0] : "";
    const value = q ? quoted.slice(1, quoted.length > 1 && quoted.endsWith(q) ? -1 : undefined) : quoted;
    const attr = m[1].toLowerCase();
    if (!attrLoadsRemote(attr, value, hrefLoads)) continue;
    const quote = q || "'";
    const text = `${quote}${attr === "src" ? BLANK_IMAGE : ""}${quote}`;
    const last = cuts.at(-1);
    if (last && start < last.end) last.end = Math.max(last.end, start + quoted.length);
    else cuts.push({ start, end: start + quoted.length, text });
  }
  let out = code;
  for (const { start, end, text } of cuts.reverse()) out = out.slice(0, start) + text + out.slice(end);
  return out;
}

/**
 * 圖片節點（`A@{ img: "…" }`，YAML）與循序圖的 `properties A: {"icon": "…"}`（JSON）：先拿掉反斜線與 Tab
 * （`\x68ttps:` 這類跳脫寫法），再把裡面所有遠端網址換成內嵌的透明圖片（Mermaid 的圖片節點會等圖片載入，
 * 換成載不到的網址會畫不出來）。區塊的範圍和 Mermaid 一樣：`@{` 到引號外的 `}`。
 */
function blockRemoteData(code: string): string {
  return code.replace(/@\{(?:"[^"]*"|[^"}])*\}?|^[ \t]*properties\b.*$/gim, (block) =>
    block.replace(/[\\\t]/g, "").replace(/[^\s,{}[\]"']*(?:https?:(?=\S)|\/\/(?=[^\s/]))[^\s,{}[\]"']*/gi, BLANK_IMAGE),
  );
}

/**
 * 每一行裡會下載東西的 CSS（`style`、`classDef` 的樣式、`%%{init}%%` 的 `themeCSS` 等）：拿掉反斜線
 * （CSS 跳脫字元），再把 `url(…)`、`image-set(…)` 這類函式改名成沒有作用的 `none(…)`。
 * CSS 的宣告一定是 `屬性:值`，所以只看每行第一個冒號之後（標籤文字「docker image(s)」不受影響）。
 */
function blockRemoteCssLines(code: string): string {
  return code.replace(/^([^\n:]*:)(.*)$/gm, (line, head: string, css: string) => {
    if (!cssLoadsRemote(css, FETCHING_FUNCTIONS)) return line;
    const out = css
      .replace(/\\/g, "")
      .replace(/url\((?!\s*["']?\s*(?:#|data:))/gi, "none(")
      .replace(/(?:image-set|image|cross-fade|src)\(/gi, "none(")
      .replace(/@import/gi, "@none");
    return head + (cssLoadsRemote(out, FETCHING_FUNCTIONS) ? "" : out);
  });
}

/**
 * 流程圖（Mermaid）的原始碼裡會讓瀏覽器去下載的遠端網址：標籤裡的 `<img src>`、`<image href>`、`style`，
 * 圖片節點的 `img`、循序圖的 `icon`、樣式的 `url(…)`。Mermaid 繪圖時會先把 SVG 放進頁面量尺寸，
 * 畫完再過濾已經來不及，所以封鎖遠端圖片時先改掉原始碼（`themeCSS`、`fontFamily` 另外在 Mermaid 的設定擋掉，
 * 見 plugins/mermaid.ts）。連結（`click`、`href`）不受影響。
 */
export function blockRemoteInMermaid(code: string): string {
  return blockRemoteCssLines(blockRemoteAttrs(blockRemoteData(code)));
}

/** 拿掉元素上會連到遠端的屬性與樣式（`<style>` 的內容也是）。 */
function blockRemoteInElement(el: Element): void {
  for (const attr of [...el.attributes]) {
    const name = attr.localName.toLowerCase();
    if (name === "srcset") {
      if (srcsetIsRemote(attr.value)) el.removeAttributeNode(attr);
    } else if (URL_ATTRS.has(name)) {
      if (!(name === "href" && el.localName === "a") && isRemoteUrl(attr.value)) el.removeAttributeNode(attr);
    } else if (name === "style") {
      const css = stripRemoteCss(attr.value);
      if (css === attr.value) continue;
      if (css.trim()) attr.value = css;
      else el.removeAttributeNode(attr);
    } else if (cssLoadsRemote(attr.value)) {
      // fill、mask、cursor 等 SVG 屬性也可以寫 url(…)。
      el.removeAttributeNode(attr);
    }
  }
  if (el.localName === "style" && el.textContent) {
    const css = stripRemoteCss(el.textContent);
    if (css !== el.textContent) el.textContent = css;
  }
}

/**
 * 流程圖（Mermaid）畫出的 SVG 裡的遠端資源：`<image href>`、`<img src>`、`srcset`、`style`、`<style>`、
 * 屬性裡的 `url(…)`。封鎖遠端圖片時，放進畫面之前先拿掉（用 `<template>` 解析，不會載入任何資源）。
 */
export function blockRemoteInSvg(svg: string): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = svg;
  for (const el of tpl.content.querySelectorAll("*")) blockRemoteInElement(el);
  return tpl.innerHTML;
}

/** HTML 字串版本：用 `<template>` 解析（不會載入任何資源），處理後再轉回字串。 */
export function blockRemoteImagesInHtml(html: string): string {
  if (!/<img\b/i.test(html)) return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  blockRemoteImages(tpl.content);
  return tpl.innerHTML;
}
