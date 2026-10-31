/**
 * 工作項目的「附件」段落：清單換成檔案小方塊（副檔名或縮圖、檔名、大小與時間），
 * 點小方塊就開啟（會自己執行的檔案改成另存），右邊是「另存新檔」。內容還是同一份 Markdown（複製成文件時是附件連結清單）。
 */
import { attachmentKind, extLabel } from "../attachments.ts";
import { t } from "../i18n.ts";
import { icon } from "./icons.ts";

export interface AttachmentHandlers {
  open(href: string): void;
  save(href: string): void;
  /** 圖片的縮圖（data: 網址）。 */
  thumb(href: string): Promise<string>;
}

/** 「附件（{n}）」標題：任何數字都算（單複數的翻譯也都比對）。 */
function isAttachmentsTitle(text: string): boolean {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const forms = [1, 2].map((n) => escape(t("附件（{n}）", { n: 987650 + n })).replace(String(987650 + n), "\\d+"));
  return new RegExp(`^(?:${forms.join("|")})$`).test(text.trim());
}

/** 檔案類型的顏色（副檔名小方塊）。 */
function tone(name: string): string {
  if (/\.(xlsx?|csv|ods)$/i.test(name)) return "sheet";
  if (/\.(docx?|odt|rtf)$/i.test(name)) return "doc";
  if (/\.pdf$/i.test(name)) return "pdf";
  if (/\.(pptx?|odp)$/i.test(name)) return "slide";
  if (/\.(zip|7z|rar|tar|gz)$/i.test(name)) return "zip";
  return attachmentKind(name) === "text" ? "text" : "other";
}

export function decorateAttachments(body: HTMLElement, h: AttachmentHandlers): void {
  const title = [...body.querySelectorAll("h2")].find((el) => isAttachmentsTitle(el.textContent ?? ""));
  const list = title?.nextElementSibling;
  if (!list || list.tagName !== "UL") return;
  const grid = document.createElement("div");
  grid.className = "ado-atts";
  for (const li of list.querySelectorAll(":scope > li")) {
    const a = li.querySelector<HTMLAnchorElement>("a[href]");
    if (!a) continue;
    const href = a.getAttribute("href")!;
    const name = a.textContent ?? "";
    const meta = (li.textContent ?? "").slice(name.length).replace(/^・/, "").trim();
    const kind = attachmentKind(name);
    const tile = document.createElement("div");
    tile.className = "ado-att";
    const badge = document.createElement("span");
    badge.className = `ado-att-icon ${tone(name)}`;
    badge.textContent = extLabel(name);
    if (kind === "image") {
      badge.classList.add("thumb");
      void h
        .thumb(href)
        .then((src) => {
          badge.textContent = "";
          badge.style.backgroundImage = `url("${src}")`;
        })
        .catch(() => {});
    }
    const text = document.createElement("span");
    text.className = "ado-att-text";
    const link = document.createElement("a");
    link.className = "ado-att-name";
    link.href = href;
    link.textContent = name;
    link.title = name;
    const small = document.createElement("small");
    small.textContent = meta;
    text.append(link, small);
    // 整個小方塊都可以點：開啟（圖片放大）；會自己執行的檔案為了安全只能另存。
    tile.title =
      kind === "image" ? t("按一下放大") : kind === "runnable" ? t("按一下另存新檔（為了安全不直接開啟）") : t("按一下開啟");
    tile.addEventListener("click", (e) => {
      if ((e.target as Element).closest(".ado-att-btn")) return;
      e.preventDefault();
      e.stopPropagation();
      if (kind === "runnable") h.save(href);
      else h.open(href);
    });
    const save = document.createElement("button");
    save.type = "button";
    save.className = "ado-att-btn icon-only";
    save.title = t("另存新檔");
    save.setAttribute("aria-label", t("另存「{name}」", { name }));
    save.append(icon("download"));
    save.addEventListener("click", () => h.save(href));
    tile.append(badge, text, save);
    grid.append(tile);
  }
  list.replaceWith(grid);
}
