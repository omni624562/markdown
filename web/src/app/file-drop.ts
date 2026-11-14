/**
 * 拖曳開檔：把檔案拖進視窗就開啟（Markdown、文字檔、Word 文件、圖片）。
 * 拖的是選取的文字（從預覽、編輯區、其他程式）時不管它：放到助理的輸入框、編輯區、搜尋框等可以輸入的地方，
 * 由瀏覽器（編輯區由 CodeMirror）照常放進去；放在其他地方不做任何事（不會因為拖了一個連結而整個視窗被導走）。
 */
import { readTextFile } from "../files.ts";
import { t } from "../i18n.ts";
import { toast } from "../ui/toast.ts";
import { imageFiles, insertImages } from "./image-paste.ts";
import { dropOnWorkItem, overWorkItem } from "./work-item-attach.ts";
import { app } from "./context.ts";
import { importDocxData } from "./activity-bar.ts";
import { reportError } from "./git-actions.ts";


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
    if (!e.dataTransfer?.types.includes("Files")) {
      if (!editable(e.target)) e.preventDefault();
      return;
    }
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    if (dropOnWorkItem(e)) return;
    const files = [...(e.dataTransfer?.files ?? [])];
    const images = imageFiles(e.dataTransfer?.files);
    if (images.length && images.length === files.length) {
      await insertImages(images).catch(reportError);
      return;
    }
    const file = files.find((f) => !images.includes(f));
    if (!file) return;
    if (/\.docx$/i.test(file.name)) {
      await importDocxData(file.name, await file.arrayBuffer(), null).catch(reportError);
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast(t("檔案超過 20 MB，可能不是文字檔。"), { tone: "error" });
      return;
    }
    const text = await readTextFile(file).catch(reportError);
    if (text === undefined) return;
    app.openDocument(file.name, text, null);
    toast(t("已開啟「{name}」", { name: file.name }));
  });
}

/** 放開的地方可以輸入文字（輸入框、編輯區）：拖過來的文字交給它自己放進去。 */
function editable(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("input, textarea, [contenteditable=''], [contenteditable='true'], .cm-content");
}
