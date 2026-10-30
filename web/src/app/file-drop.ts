/**
 * 拖曳開檔：把檔案拖進視窗就開啟（Markdown、文字檔、Word 文件、圖片）。
 */
import { readTextFile } from "../files.ts";
import { t } from "../i18n.ts";
import { toast } from "../ui/toast.ts";
import { imageFiles, insertImages } from "./image-paste.ts";
import { app } from "./context.ts";


// 在 init 時建立。
let overlay: HTMLElement;
let dragDepth = 0;

export function initFileDrop(): void {
  overlay = app.$(".drop-overlay");
  window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    dragDepth++;
    overlay.hidden = false;
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
