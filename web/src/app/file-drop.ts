/**
 * 拖曳開檔：把檔案拖進視窗就開啟（Markdown、文字檔、圖片；PDF、Office 文件、郵件開成檢視分頁）。
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
import { isViewerDoc } from "../kinds.ts";
import { importDocxData } from "./activity-bar.ts";
import { openPath } from "./workspace-ui.ts";
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
    // 圖片以外的每一個檔案都開起來（一次太多時只開前面幾個）。
    const docs = files.filter((f) => !images.includes(f));
    if (!docs.length) return;
    if (docs.length > MAX_DROPPED) toast(t("一次最多開啟 {max} 個檔案，其餘的沒有開啟。", { max: MAX_DROPPED }));
    // 桌面版（Windows）：把檔案交給原生端問出原本的路徑，和「開啟檔案」一樣開起來——存檔直接存回原處，
    // 另存新檔也從它所在的資料夾開始。拿不到路徑（其他平台、網頁版）才用檔案內容開成新文件。
    let id: string | null = null;
    let why: string | null = null;
    try {
      id = handOver(files);
    } catch (e) {
      why = message(e);
    }
    const opened: string[] = [];
    for (const file of docs.slice(0, MAX_DROPPED)) {
      // PDF、Office 文件、郵件：和檔案面板一樣在分頁裡檢視（要拿得到路徑）。
      if (isViewerDoc(file.name)) {
        const path = id ? await desktop!.droppedViewPath(id, files.indexOf(file)).catch(() => null) : null;
        if (path) {
          await openPath(path).catch(reportError);
          continue;
        }
        // 拿不到路徑（網頁版、其他平台）：Word 轉成 Markdown 開啟，其他的沒辦法顯示。
        if (/\.docx$/i.test(file.name)) await importDocxData(file.name, await file.arrayBuffer(), null).catch(reportError);
        else toast(t("「{name}」要從檔案面板開啟（拿不到檔案的位置）。", { name: file.name }));
        continue;
      }
      if (id) {
        try {
          const found = await desktop!.droppedFile(id, files.indexOf(file));
          if (found) {
            app.openOpenedFile(fromDesktop(found));
            opened.push(file.name);
            continue;
          }
        } catch (e) {
          why = message(e);
        }
      }
      if (file.size > 20 * 1024 * 1024) {
        toast(t("檔案超過 20 MB，可能不是文字檔。"), { tone: "error" });
        continue;
      }
      const text = await readTextFile(file).catch(reportError);
      if (text === undefined) continue;
      app.openDocument(file.name, text, null);
      opened.push(file.name);
    }
    if (!opened.length) return;
    const what = opened.length === 1 ? t("已開啟「{name}」", { name: opened[0] }) : t("已開啟 {n} 個檔案", { n: opened.length });
    // 應該拿得到原本的位置卻拿不到：說清楚（存檔會問要存到哪裡）和原因，不要默默變成新文件。
    if (why) toast(t("{what}，但拿不到原本的位置（{why}）：存檔時要選位置", { what, why }), { tone: "error", duration: 15000 });
    else toast(what);
  });
}

/** 一次拖進來最多開幾個檔案。 */
const MAX_DROPPED = 20;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** WebView2 把檔案物件交給原生端的管道（其他瀏覽器核心沒有）。 */
interface WebViewHost {
  postMessageWithAdditionalObjects?(message: unknown, objects: ArrayLike<File>): void;
}

/**
 * 把拖進來的檔案物件交給原生端（它才問得到路徑），回傳這次拖放的代號；之後用 `desktop.droppedFile(代號, 順序)`
 * 依原本的路徑開啟。這個平台本來就沒有這個機制時回傳 null，應該有卻沒有時丟出原因。
 */
function handOver(files: File[]): string | null {
  const host = (window as { chrome?: { webview?: WebViewHost } }).chrome?.webview;
  if (!desktop) return null;
  if (!host?.postMessageWithAdditionalObjects) {
    // Windows 的桌面版應該要有；沒有就是 WebView2 太舊或管道被關掉。
    if (/Windows/.test(navigator.userAgent)) throw new Error(host ? t("這個版本的 WebView2 不能交出檔案") : t("沒有 WebView2 的管道"));
    return null;
  }
  const id = `drop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // 訊息要是字串：Tauri 自己也在聽這個事件，而且排在前面；它只讀得懂字串，遇到物件會回報錯誤，
  // WebView2 就不再往下叫我們的處理常式（送物件時登記成功卻一則訊息都收不到；改成字串就收到了）。
  // 字串它讀得懂、當成看不懂的指令略過（只在主控台記一行）。
  host.postMessageWithAdditionalObjects(`omarkerDrop:${id}`, files);
  return id;
}

/** 放開的地方可以輸入文字（輸入框、編輯區）：拖過來的文字交給它自己放進去。 */
function editable(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("input, textarea, [contenteditable=''], [contenteditable='true'], .cm-content");
}
