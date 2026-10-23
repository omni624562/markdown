/**
 * 點圖片放大檢視：圖片縮放到畫面大小；點圖片切換成原始大小（可以捲動），
 * 點旁邊或按 Esc 關閉。即時預覽中可以按「編輯原始碼」回到圖片的 Markdown。
 */
import { t } from "../i18n.ts";

let el: HTMLDialogElement | null = null;

export function openLightbox(src: string, alt: string, editSource?: () => void): void {
  el?.remove();
  const dialog = document.createElement("dialog");
  dialog.className = "lightbox";
  dialog.setAttribute("aria-label", alt ? t("圖片：{name}", { name: alt }) : t("圖片"));
  const img = document.createElement("img");
  img.src = src;
  img.alt = alt;
  img.title = t("按一下切換原始大小");
  const bar = document.createElement("div");
  bar.className = "lightbox-bar";
  const caption = document.createElement("span");
  caption.textContent = alt;
  bar.append(caption);
  if (editSource) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = t("編輯原始碼");
    edit.addEventListener("click", () => {
      dialog.close();
      editSource();
    });
    bar.append(edit);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = t("關閉");
  close.addEventListener("click", () => dialog.close());
  bar.append(close);
  dialog.append(img, bar);
  img.addEventListener("click", (e) => {
    e.stopPropagation();
    dialog.classList.toggle("actual-size");
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (el === dialog) el = null;
  });
  document.body.append(dialog);
  el = dialog;
  dialog.showModal();
  close.focus();
}
