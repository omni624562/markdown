/**
 * 拖曳開檔：把檔案拖進視窗就開啟（Markdown、文字檔、Word 文件、圖片）。
 * 拖的是選取的文字（從預覽、編輯區、其他程式）時不管它：放到助理的輸入框、編輯區、搜尋框等可以輸入的地方，
 * 由瀏覽器（編輯區由 CodeMirror）照常放進去；放在其他地方不做任何事（不會因為拖了一個連結而整個視窗被導走）。
 */
import { desktop } from "../desktop.ts";
import { fromDesktop, readTextFile } from "../files.ts";
import { t } from "../i18n.ts";
import { toast } from "../ui/toast.ts";
import { imageFiles, insertImages } from "./image-paste.ts";
import { dropOnWorkItem, overWorkItem } from "./work-item-attach.ts";
import { overAssistantInput } from "./assistant.ts";
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
    // 拖到助理的輸入區上：放開是附到問題上（圖片、PDF）。
    const ask = !attach && overAssistantInput(e.target);
    if (title) title.textContent = attach ? t("放開以加入附件") : ask ? t("放開以附到問題上") : openText[0];
    if (detail) detail.textContent = attach ? t("檔案會上傳成這個工作項目的附件") : ask ? t("圖片或 PDF 會和問題一起送給助理") : openText[1];
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
    // 桌面版（Windows）：問原生端這個檔案原本的路徑，和「開啟檔案」一樣開起來——存檔直接存回原處，
    // 另存新檔也從它所在的資料夾開始。拿不到路徑（其他平台、網頁版）才用檔案內容開成新文件。
    const opened = await openWithPath(files, files.indexOf(file)).catch((e) => String(e instanceof Error ? e.message : e));
    if (opened === true) return;
    if (file.size > 20 * 1024 * 1024) {
      toast(t("檔案超過 20 MB，可能不是文字檔。"), { tone: "error" });
      return;
    }
    const text = await readTextFile(file).catch(reportError);
    if (text === undefined) return;
    app.openDocument(file.name, text, null);
    // 應該拿得到原本的位置卻拿不到：說清楚（存檔會問要存到哪裡）和原因，不要默默變成新文件。
    if (typeof opened === "string") toast(t("已開啟「{name}」，但拿不到它原本的位置（{why}）：存檔時要選位置", { name: file.name, why: opened }), { tone: "error", duration: 15000 });
    else toast(t("已開啟「{name}」", { name: file.name }));
  });
}

/** WebView2 把檔案物件交給原生端的管道（其他瀏覽器核心沒有）。 */
interface WebViewHost {
  postMessageWithAdditionalObjects?(message: unknown, objects: ArrayLike<File>): void;
}

/**
 * 依原本的路徑開啟拖進來的第 `index` 個檔案。把檔案物件交給原生端（它才問得到路徑），再請它開啟；
 * 回傳有沒有開成功；這個平台本來就沒有這個機制時是 false，應該拿得到卻失敗時丟出原因。
 */
async function openWithPath(files: File[], index: number): Promise<boolean> {
  const host = (window as { chrome?: { webview?: WebViewHost } }).chrome?.webview;
  if (!desktop || index < 0) return false;
  if (!host?.postMessageWithAdditionalObjects) {
    // Windows 的桌面版應該要有；沒有就是 WebView2 太舊或管道被關掉。
    if (/Windows/.test(navigator.userAgent)) throw new Error(host ? t("這個版本的 WebView2 不能交出檔案") : t("沒有 WebView2 的管道"));
    return false;
  }
  const id = `drop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  host.postMessageWithAdditionalObjects({ omarkerDrop: id }, files);
  const file = await desktop.droppedFile(id, index);
  if (!file) return false;
  app.openOpenedFile(fromDesktop(file));
  return true;
}

/** 放開的地方可以輸入文字（輸入框、編輯區）：拖過來的文字交給它自己放進去。 */
function editable(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("input, textarea, [contenteditable=''], [contenteditable='true'], .cm-content");
}
