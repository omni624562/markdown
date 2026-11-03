/**
 * 拖曳開檔：把檔案拖進視窗就開啟（Markdown、文字檔、Word 文件、圖片）。
 */
import { readTextFile } from "../files.ts";
import { t } from "../i18n.ts";
import { toast } from "../ui/toast.ts";
import { imageFiles, insertImages } from "./image-paste.ts";
import { dropOnWorkItem, overWorkItem } from "./work-item-attach.ts";
import { app } from "./context.ts";


// 在 init 時建立。
let overlay: HTMLElement;
let dragDepth = 0;

export function initFileDrop(): void {
  overlay = app.$(".drop-overlay");
  const title = overlay.querySelector("strong");
  const detail = overlay.querySelector("span");
  const openText = [title?.textContent ?? "", detail?.textContent ?? ""];
  window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    dragDepth++;
    overlay.hidden = false;
    // 拖到開著的工作項目上：放開是加入附件，不是開檔。
    const attach = overWorkItem(e.target);
    if (title) title.textContent = attach ? t("放開以加入附件") : openText[0];
    if (detail) detail.textContent = attach ? t("檔案會上傳成這個工作項目的附件") : openText[1];
  });
  window.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      overlay.hidden = true;
    }
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    if (dropOnWorkItem(e)) return;
    const files = [...(e.dataTransfer?.files ?? [])];
    const images = imageFiles(e.dataTransfer?.files);
    if (images.length && images.length === files.length) {
      await insertImages(images).catch(app.reportError);
      return;
    }
    const file = files.find((f) => !images.includes(f));
    if (!file) return;
    if (/\.docx$/i.test(file.name)) {
      await app.importDocxData(file.name, await file.arrayBuffer(), null).catch(app.reportError);
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast(t("檔案超過 20 MB，可能不是文字檔。"), { tone: "error" });
      return;
    }
    const text = await readTextFile(file).catch(app.reportError);
    if (text === undefined) return;
    app.openDocument(file.name, text, null);
    toast(t("已開啟「{name}」", { name: file.name }));
  });
}
