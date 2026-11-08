/**
 * 工作項目的附件：上傳檔案（「加入附件…」、把檔案拖到工作項目上）、在說明與留言的編輯框貼上圖片。
 * 檔案先上傳成附件（拿到網址），再掛到工作項目上；貼上的圖片只放進內容（和 Azure DevOps 網頁一樣）。
 */
import { desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { toast } from "../ui/toast.ts";
import { imageFiles } from "./image-paste.ts";
import { pastedName } from "../attachments.ts";
import { issueView } from "./wiki-edit.ts";
import { reportError } from "./git-actions.ts";

/** Azure DevOps 預設的附件上限。 */
export const MAX_ATTACHMENT = 60 * 1024 * 1024;

/** 上傳檔案，回傳每個附件的名稱與網址；太大的檔案提示後略過。 */
export async function uploadAttachments(project: string, files: File[]): Promise<{ name: string; url: string }[]> {
  const ok = files.filter((f) => {
    if (f.size <= MAX_ATTACHMENT) return true;
    toast(t("「{name}」超過 60 MB，Azure DevOps 不接受這麼大的附件", { name: f.name }), { tone: "error" });
    return false;
  });
  if (!ok.length) return [];
  const progress = toast(t("上傳中…（{n} 個檔案）", { n: ok.length }), { duration: 600_000 });
  try {
    const out: { name: string; url: string }[] = [];
    for (const f of ok) out.push({ name: f.name, url: await desktop!.adoAttachmentUpload(project, f.name, await f.arrayBuffer()) });
    return out;
  } finally {
    progress.dismiss();
  }
}

/** 說明、留言的編輯框（Markdown）：貼上圖片時上傳成附件，在游標位置插入圖片。 */
export function pasteImagesInto(textarea: HTMLTextAreaElement, project: string): void {
  textarea.addEventListener("paste", (e) => {
    const images = imageFiles(e.clipboardData?.files);
    if (!images.length || !desktop) return;
    e.preventDefault();
    const files = images.map((f) => new File([f], pastedName(f), { type: f.type }));
    void uploadAttachments(project, files)
      .then((done) => {
        if (!done.length) return;
        const md = done.map((d) => `![${d.name}](<${d.url}>)`).join("\n");
        textarea.focus();
        textarea.setRangeText(md, textarea.selectionStart, textarea.selectionEnd, "end");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      })
      .catch(reportError);
  });
}

/** 目前開著的工作項目（拖檔案到上面就加入附件）；沒有開工作項目時是 null。 */
let dropTarget: { key: string; attach(files: File[]): void } | null = null;

export function setAttachTarget(key: string, attach: (files: File[]) => void): void {
  dropTarget = { key, attach };
}

/** 拖曳到的位置是不是開著的工作項目（是的話放開就加入附件，不是開檔）。 */
export function overWorkItem(target: EventTarget | null): boolean {
  return !!dropTarget && issueView.isOpen && issueView.shownKey === dropTarget.key && !!(target as Element | null)?.closest?.(".issue-pane");
}

/** 檔案放到工作項目上：加入附件；不是放在工作項目上時回傳 false（照原本的方式開檔）。 */
export function dropOnWorkItem(e: DragEvent): boolean {
  if (!overWorkItem(e.target) || !dropTarget) return false;
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return false;
  dropTarget.attach(files);
  return true;
}
