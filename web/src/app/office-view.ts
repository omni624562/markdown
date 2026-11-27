/**
 * 在 oMarker 的分頁裡唯讀檢視 Office 文件（目前是 Word .docx）：原生端只讀出檔案內容（`read_office`，
 * 只限工作區、開過的檔案與下載的附件），在這裡轉成 HTML，經過白名單（office-html.ts）再顯示。
 * 分頁上方有「用預設的程式開啟」；Word 另外可以「轉成 Markdown 編輯」（開成新分頁，存檔時再選位置）。
 */
import { desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { type OfficeKind, officeKind } from "../kinds.ts";
import { cleanOfficeHtml } from "../office-html.ts";
import { basename, dirname, relativePath } from "../paths.ts";
import { fileLink } from "../file-link.ts";
import { bytesToBase64 } from "../files.ts";
import { icon } from "../ui/icons.ts";
import { announce } from "../ui/toast.ts";
import { app } from "./context.ts";
import { reportError } from "./git-actions.ts";
import { insertAtCursor } from "./image-paste.ts";
import { openItem } from "./item-tabs.ts";

export interface OfficeOptions {
  /** 標頭上的位置（預設是檔案在專案裡的資料夾）。 */
  label?: string;
  /** 「用預設的程式開啟」（預設交給原生端開啟這個路徑；附件改成重新下載後開啟）。 */
  openExternally?(): Promise<void>;
  /** 可以插入相對路徑的連結（本機檔案）；附件沒有可以連的路徑。 */
  linkable?: boolean;
}

const NAMES: Record<OfficeKind, string> = { word: "Word", excel: "Excel", powerpoint: "PowerPoint" };
const ICONS: Record<OfficeKind, string> = { word: "file-text", excel: "file-text", powerpoint: "file-text" };

/** 轉好的內容（同一個分頁切換回來時不必重讀、重轉）；從檔案面板重新開啟時重讀。 */
const rendered = new Map<string, Promise<string>>();

function whereLabel(path: string): string {
  const root = app.workspaceRoot;
  const dir = dirname(path);
  if (!root) return dir;
  const rel = relativePath(root.path, dir);
  return !rel || rel === "." ? root.name : `${root.name}/${rel}`;
}

/** 讀檔並轉成 HTML（還沒經過白名單）。 */
async function render(kind: OfficeKind, data: ArrayBuffer): Promise<string> {
  if (kind === "word") {
    const { docxToHtml } = await import("../docx-import.ts");
    const out = await docxToHtml(data, async (bytes, type) => `data:${type};base64,${bytesToBase64(bytes)}`);
    if (out.html) return out.html;
    const empty = document.createElement("p");
    empty.textContent = t("這份文件沒有內容。");
    return empty.outerHTML;
  }
  throw new Error(t("還不支援在 oMarker 裡檢視這種檔案"));
}

/** 在分頁裡顯示 Office 文件（已經開著就切過去）。 */
export function showOffice(path: string, opts: OfficeOptions = {}): Promise<void> {
  const d = desktop;
  const kind = officeKind(path);
  if (!d || !kind) return Promise.resolve();
  const name = basename(path);
  const key = `office:${path}`;
  rendered.delete(key);
  const openExternally = opts.openExternally ?? (() => d.openWithDefault(path));
  const load = () => {
    let hit = rendered.get(key);
    if (!hit) {
      hit = d.readOffice(path).then((data) => render(kind, data));
      rendered.set(key, hit);
      hit.catch(() => rendered.delete(key));
    }
    return hit;
  };
  return openItem({
    key,
    origin: { kind: "office", icon: ICONS[kind], text: NAMES[kind] },
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
      body.classList.add("office-view", `office-${kind}`);
      const bar = document.createElement("div");
      bar.className = "office-view-bar";
      bar.append(barButton("external-link", t("用預設的程式開啟"), "office-view-external", () => openExternally()));
      if (kind === "word") {
        bar.append(
          barButton("file-pen-line", t("轉成 Markdown 編輯"), "office-view-convert", async () => {
            const data = await d.readOffice(path);
            const { importDocxData } = await import("./activity-bar.ts");
            await importDocxData(name, data, null);
          }),
        );
      }
      const content = document.createElement("div");
      content.className = "office-view-content markdown-body";
      content.textContent = t("讀取中…");
      body.replaceChildren(bar, content);
      load().then(
        (html) => content.replaceChildren(cleanOfficeHtml(html)),
        (e) => {
          content.replaceChildren(
            Object.assign(document.createElement("p"), {
              className: "office-view-error",
              textContent: t("沒辦法在 oMarker 裡顯示「{name}」：{error}。可以用預設的程式開啟。", { name, error: e instanceof Error ? e.message : String(e) }),
            }),
          );
        },
      );
    },
  });
}

function barButton(iconName: string, label: string, className: string, run: () => Promise<void>): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.append(icon(iconName), document.createTextNode(label));
  b.addEventListener("click", () => void run().catch(reportError));
  return b;
}
