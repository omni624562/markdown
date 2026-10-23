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
    img.title = t("已封鎖遠端圖片：{src}\n可以在「設定 → 外觀」關閉「封鎖遠端圖片」", { src });
  }
}

/** HTML 字串版本：用 `<template>` 解析（不會載入任何資源），處理後再轉回字串。 */
export function blockRemoteImagesInHtml(html: string): string {
  if (!/<img\b/i.test(html)) return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  blockRemoteImages(tpl.content);
  return tpl.innerHTML;
}
