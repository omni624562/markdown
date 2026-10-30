/**
 * 封鎖遠端圖片（設定「封鎖遠端圖片」）：文件中的 `![](https://…)` 一顯示就會連到對方的伺服器，
 * 對方可以藉此知道你何時開啟文件、你的 IP（類似電子郵件的「已讀回條」）。
 * 開啟這個設定時，遠端圖片在放進畫面「之前」就拿掉網址，所以完全不會發出連線。
 */

import { t } from "./i18n.ts";

/** `http:`、`https:` 或 `//主機/…` 的圖片網址。 */
export function isRemoteImage(src: string): boolean {
  return /^\s*(https?:)?\/\//i.test(src);
}

/** 把 `root` 中的遠端圖片換成提示文字（要在放進畫面之前呼叫，例如 `<template>` 的內容）。 */
export function blockRemoteImages(root: ParentNode): void {
  for (const img of root.querySelectorAll<HTMLImageElement>("img[src]")) {
    const src = img.getAttribute("src")!;
    if (!isRemoteImage(src)) continue;
    img.removeAttribute("src");
    img.removeAttribute("srcset");
    img.dataset.blockedSrc = src;
    img.classList.add("remote-blocked");
    img.alt = img.alt ? t("🖼 {alt}（已封鎖遠端圖片）", { alt: img.alt }) : t("🖼 圖片（已封鎖遠端圖片）");
    img.title = t("已封鎖遠端圖片：{src}\n按一下載入這份文件的遠端圖片；也可以在「設定 → 外觀」關閉「封鎖遠端圖片」", { src });
  }
}

/** 1×1 的透明 GIF。 */
const BLANK_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** CSS 裡的遠端網址（`url(https://…)`、`@import`）換成不會連線的值。 */
export function stripRemoteCss(css: string): string {
  return css
    .replace(/@import\s+[^;]*;?/gi, "")
    .replace(/url\(\s*(['"]?)\s*(?:https?:)?\/\/[^)]*\)/gi, "none");
}

/**
 * 流程圖（Mermaid）的原始碼裡會讓瀏覽器去下載的遠端網址：`themeCSS`、樣式的 `url(…)`、
 * 圖片節點的 `img: "https://…"`、標籤裡的 `<img src="https://…">`。Mermaid 繪圖時會先把 SVG
 * 放進頁面量尺寸，畫完再過濾已經來不及，所以封鎖遠端圖片時先改掉原始碼。連結（`click`、`href`）不受影響。
 */
export function blockRemoteInMermaid(code: string): string {
  // 換成內嵌的 1×1 透明圖片（原本的網址留在 `#` 後面，不會被下載）：Mermaid 的圖片節點會等圖片載入，
  // 換成載不到的網址會畫不出來。
  return stripRemoteCss(code).replace(/\b(src\s*=\s*|img\s*:\s*)(["']?)\s*(?:https?:)?\/\//gi, `$1$2${BLANK_IMAGE}#`);
}

/**
 * 流程圖（Mermaid）畫出的 SVG 裡的遠端資源：`<image href="https://…">`、`themeCSS` 的
 * `url(https://…)` 等。封鎖遠端圖片時，放進畫面之前先拿掉。
 */
export function blockRemoteInSvg(svg: string): string {
  if (!/(?:https?:)?\/\//i.test(svg)) return svg;
  const tpl = document.createElement("template");
  tpl.innerHTML = svg;
  for (const el of tpl.content.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      if (attr.localName === "href" && isRemoteImage(attr.value)) el.removeAttributeNode(attr);
      else if (attr.localName === "style" && /url\(|@import/i.test(attr.value)) attr.value = stripRemoteCss(attr.value);
    }
    if (el.localName === "style" && el.textContent) el.textContent = stripRemoteCss(el.textContent);
  }
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
