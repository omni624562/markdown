/**
 * 在 oMarker 的分頁裡檢視 PDF：用 Windows 內建的 PDF 檢視器（WebView2，可以搜尋、縮放、列印、翻頁），
 * 檔案由原生端的 `mdimg:` 協定提供（只提供工作區、已開啟檔案的資料夾與下載的附件，見 desktop/src/image_protocol.rs）。
 * 工具列可以插入連結到目前的文件；內容上方有「用預設的程式開啟」。
 */
import { desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { basename, dirname, relativePath } from "../paths.ts";
import { icon } from "../ui/icons.ts";
import { announce } from "../ui/toast.ts";
import { app } from "./context.ts";
import { reportError } from "./git-actions.ts";
import { fileLink } from "../file-link.ts";
import { insertAtCursor } from "./image-paste.ts";
import { openItem } from "./item-tabs.ts";

export interface PdfOptions {
  /** 標頭上的位置（預設是檔案在專案裡的資料夾）。 */
  label?: string;
  /** 「用預設的程式開啟」（預設交給原生端開啟這個路徑；附件改成重新下載後開啟）。 */
  openExternally?(): Promise<void>;
  /** 可以插入相對路徑的連結（本機檔案）；附件沒有可以連的路徑。 */
  linkable?: boolean;
}

function whereLabel(path: string): string {
  const root = app.workspaceRoot;
  const dir = dirname(path);
  if (!root) return dir;
  const rel = relativePath(root.path, dir);
  return !rel || rel === "." ? root.name : `${root.name}/${rel}`;
}

/** 在分頁裡顯示 PDF（已經開著就切過去）。 */
export function showPdf(path: string, opts: PdfOptions = {}): Promise<void> {
  const d = desktop;
  if (!d) return Promise.resolve();
  const name = basename(path);
  const openExternally = opts.openExternally ?? (() => d.openWithDefault(path));
  return openItem({
    key: `pdf:${path}`,
    origin: { kind: "pdf", icon: "file-text", text: "PDF" },
    label: opts.label ?? whereLabel(path),
    title: name,
    webUrl: "",
    fileName: `${name}.md`,
    load: () => Promise.resolve(""),
    insertLink: () => {
      if (opts.linkable === false) return;
      insertAtCursor(fileLink(path, app.cur.fileHandle?.path));
      announce(t("已插入「{name}」的連結", { name }));
    },
    decorate: (body) => {
      body.classList.add("pdf-view");
      const bar = document.createElement("div");
      bar.className = "pdf-view-bar";
      const external = document.createElement("button");
      external.type = "button";
      external.className = "pdf-view-external";
      external.append(icon("external-link"), document.createTextNode(t("用預設的程式開啟")));
      external.addEventListener("click", () => void openExternally().catch(reportError));
      bar.append(external);
      const frame = document.createElement("iframe");
      frame.className = "pdf-view-frame";
      frame.title = name;
      frame.src = d.fileUrl(path);
      body.replaceChildren(bar, frame);
    },
  });
}
