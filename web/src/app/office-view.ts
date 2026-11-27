/**
 * 在 oMarker 的分頁裡唯讀檢視 Office 文件（Word .docx、Excel .xlsx、PowerPoint .pptx）與 Outlook 郵件（.msg）：原生端只讀出檔案內容（`read_office`，
 * 只限工作區、開過的檔案與下載的附件），在這裡轉成 HTML，經過白名單（office-html.ts）再顯示。
 * 分頁上方有「用預設的程式開啟」；Word 另外可以「轉成 Markdown 編輯」（開成新分頁，存檔時再選位置），
 * Excel 每個工作表一個頁籤，可以複製表格或轉成 Markdown 表格。
 */
import { desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { type OfficeKind, officeKind } from "../kinds.ts";
import { cleanOfficeHtml } from "../office-html.ts";
import type { Sheet } from "../office-read.ts";
import { basename, dirname, relativePath } from "../paths.ts";
import { fileLink } from "../file-link.ts";
import { fileSize } from "../attachments.ts";
import { bytesToBase64 } from "../files.ts";
import { icon } from "../ui/icons.ts";
import { announce, copied } from "../ui/toast.ts";
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

const NAMES: Record<OfficeKind, string> = { word: "Word", excel: "Excel", powerpoint: "PowerPoint", mail: "Outlook" };
const ICONS: Record<OfficeKind, string> = { word: "file-text", excel: "file-spreadsheet", powerpoint: "presentation", mail: "mail" };


/** 讀好的內容：Word 是 mammoth 轉出的 HTML，Excel 是工作表，PowerPoint 是投影片的 HTML（都還沒經過白名單）。 */
type Content =
  | { kind: "word"; html: string }
  | { kind: "excel"; sheets: Sheet[]; table(sheet: Sheet): HTMLTableElement; limit: { rows: number; cols: number } }
  | { kind: "powerpoint"; html: string }
  | { kind: "mail"; html: string; attachments: { name: string; size: number }[] };

/** 讀好的內容（同一個分頁切換回來時不必重讀、重轉）；從檔案面板重新開啟時重讀。 */
const rendered = new Map<string, Promise<Content>>();

function whereLabel(path: string): string {
  const root = app.workspaceRoot;
  const dir = dirname(path);
  if (!root) return dir;
  const rel = relativePath(root.path, dir);
  return !rel || rel === "." ? root.name : `${root.name}/${rel}`;
}

/** 讀檔並轉成要顯示的內容。 */
async function render(kind: OfficeKind, data: ArrayBuffer): Promise<Content> {
  if (kind === "word") {
    const { docxToHtml } = await import("../docx-import.ts");
    const out = await docxToHtml(data, async (bytes, type) => `data:${type};base64,${bytesToBase64(bytes)}`);
    if (out.html) return { kind, html: out.html };
    const empty = document.createElement("p");
    empty.textContent = t("這份文件沒有內容。");
    return { kind, html: empty.outerHTML };
  }
  if (kind === "mail") {
    // 郵件的讀取（msgreader）用到才載入。
    const { readMsg } = await import("../mail-read.ts");
    return { kind, ...readMsg(data) };
  }
  // Excel、PowerPoint 的讀取（含 JSZip）用到才載入。
  const { readXlsx, readPptx, sheetTable, MAX_ROWS, MAX_COLS } = await import("../office-read.ts");
  if (kind === "excel") return { kind, sheets: await readXlsx(data), table: sheetTable, limit: { rows: MAX_ROWS, cols: MAX_COLS } };
  const slides = await readPptx(data);
  return { kind, html: slides.map((s) => s.outerHTML).join("") };
}

/** 畫出讀好的內容。 */
function show(content: Content, box: HTMLElement, name: string): void {
  if (content.kind === "mail") {
    box.replaceChildren(cleanOfficeHtml(content.html));
    if (content.attachments.length) {
      const list = document.createElement("ul");
      list.className = "office-mail-attachments";
      for (const a of content.attachments) {
        const li = document.createElement("li");
        li.append(icon("paperclip"), document.createTextNode(a.size ? t("{name}（{size}）", { name: a.name, size: fileSize(a.size) }) : a.name));
        list.append(li);
      }
      const title = Object.assign(document.createElement("h3"), { textContent: t("附件（{n} 個，要用預設的程式開啟才能取出）", { n: content.attachments.length }) });
      box.append(title, list);
    }
    return;
  }
  if (content.kind !== "excel") {
    box.replaceChildren(cleanOfficeHtml(content.html));
    return;
  }
  const sheets = content.sheets;
  if (!sheets.length) {
    box.replaceChildren(Object.assign(document.createElement("p"), { textContent: t("這份活頁簿沒有可以顯示的工作表。") }));
    return;
  }
  const tabs = document.createElement("div");
  tabs.className = "office-sheet-tabs";
  tabs.setAttribute("role", "tablist");
  const view = document.createElement("div");
  view.className = "office-sheet";
  const select = (i: number) => {
    for (const [j, b] of [...tabs.children].entries()) b.setAttribute("aria-selected", String(i === j));
    const sheet = sheets[i];
    const note = sheet.truncated ? [Object.assign(document.createElement("p"), { className: "office-sheet-note", textContent: t("只顯示前 {rows} 列、{cols} 欄；完整內容請用預設的程式開啟。", content.limit) })] : [];
    view.replaceChildren(...note, sheet.rows.length ? content.table(sheet) : Object.assign(document.createElement("p"), { textContent: t("這個工作表是空的。") }));
  };
  sheets.forEach((sheet, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "tab");
    b.textContent = sheet.name;
    b.addEventListener("click", () => select(i));
    tabs.append(b);
  });
  const current = () => sheets[Math.max(0, [...tabs.children].findIndex((b) => b.getAttribute("aria-selected") === "true"))];
  const tools = document.createElement("div");
  tools.className = "office-sheet-tools";
  tools.append(
    barButton("copy", t("複製表格"), "office-sheet-copy", async () => {
      await navigator.clipboard.writeText(sheetTsv(current()));
      copied();
    }),
    barButton("table", t("轉成 Markdown 表格"), "office-sheet-markdown", async () => {
      const sheet = current();
      app.openDocument(`${name.replace(/\.xlsx$/i, "")}-${sheet.name}.md`, sheetMarkdown(sheet), null, { kind: "markdown", fromFile: false });
    }),
  );
  box.replaceChildren(tabs, tools, view);
  select(0);
}

/** 工作表的文字（Tab 分隔，貼到 Excel、Word 會分成欄）。 */
function sheetTsv(sheet: Sheet): string {
  return sheet.rows.map((r) => (r ?? []).map((c) => (c ?? "").replace(/[\t\r\n]+/g, " ")).join("\t")).join("\n");
}

/** 工作表轉成 Markdown 表格（第一列當標題）。 */
function sheetMarkdown(sheet: Sheet): string {
  const width = Math.max(1, ...sheet.rows.map((r) => (r ?? []).length));
  const cell = (v: string | undefined) => (v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
  const line = (r: string[] | undefined) => `| ${Array.from({ length: width }, (_, i) => cell(r?.[i])).join(" | ")} |`;
  const [head, ...rest] = sheet.rows.length ? sheet.rows : [[]];
  return [line(head), `|${" --- |".repeat(width)}`, ...rest.map(line)].join("\n") + "\n";
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
        (data) => show(data, content, name),
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
