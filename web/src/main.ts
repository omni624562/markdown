import "../../crates/md-core/src/document.css";
import "./styles.css";

import init, { type Heading, type RenderResult, renderDocument } from "../pkg/md_wasm.js";
import { createEditor, loadDoc, revealLine } from "./editor.ts";
import { type OpenedFile, download, openFile, replaceExtension, saveFile } from "./files.ts";
import { highlightPlugin } from "./plugins/highlight.ts";
import { Preview } from "./preview.ts";
import sample from "./sample.md?raw";
import { type Block, collectBlocks, offsetForLine } from "./scroll-sync.ts";
import * as storage from "./storage.ts";

type ViewMode = "editor" | "split" | "preview";
const DEFAULT_NAME = "未命名.md";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const workspace = $<HTMLElement>(".workspace");
const previewEl = $<HTMLElement>("#preview");
const previewScroller = $<HTMLElement>("#preview-scroller");
const outlineList = $<HTMLOListElement>("#outline-list");
const statusFile = $<HTMLElement>("#status-file");
const statusStats = $<HTMLElement>("#status-stats");
const statusSaved = $<HTMLElement>("#status-saved");
const fileInput = $<HTMLInputElement>("#file-input");

await init();

const preview = new Preview(previewEl, [highlightPlugin()]);

let fileName = storage.load("name") ?? DEFAULT_NAME;
let fileHandle: OpenedFile["handle"] = null;
let blocks: Block[] | null = null;
let editorTopLine = 1;

// ---- 渲染 ---------------------------------------------------------------

let renderQueued = false;
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const result = preview.update(editor.state.doc.toString());
    blocks = null;
    renderOutline(result.headings);
    renderStats(result);
    syncPreview();
  });
}

function renderOutline(headings: Heading[]): void {
  outlineList.replaceChildren(
    ...headings.map((h) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `#${encodeURIComponent(h.id)}`;
      a.textContent = h.text || "（空白標題）";
      a.style.setProperty("--level", String(h.level));
      a.addEventListener("click", (e) => {
        e.preventDefault();
        revealLine(editor, h.line);
        document.getElementById(h.id)?.scrollIntoView({ block: "start" });
      });
      li.append(a);
      return li;
    }),
  );
}

function renderStats({ stats }: RenderResult): void {
  statusStats.textContent =
    `${stats.words.toLocaleString()} 字 · ${stats.chars.toLocaleString()} 字元` +
    (stats.readingMinutes ? ` · 約 ${stats.readingMinutes} 分鐘` : "");
}

// ---- 捲動同步：編輯器帶動預覽 ---------------------------------------------

function syncPreview(): void {
  if (workspace.dataset.view !== "split") return;
  const scroller = editor.scrollDOM;
  if (scroller.scrollTop <= 0) {
    previewScroller.scrollTop = 0;
  } else if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) {
    // 編輯器捲到底時，預覽也捲到底，避免最後幾行對不上。
    previewScroller.scrollTop = previewScroller.scrollHeight;
  } else {
    blocks ??= collectBlocks(previewEl, previewScroller);
    previewScroller.scrollTop = offsetForLine(blocks, editorTopLine);
  }
}

// 預覽中圖片載入或視窗大小改變都會讓區塊位置改變，需要重新量測。
new ResizeObserver(() => {
  blocks = null;
}).observe(previewEl);

// ---- 自動儲存 -----------------------------------------------------------

let saveTimer: number | undefined;
function scheduleAutosave(doc: string): void {
  clearTimeout(saveTimer);
  statusSaved.textContent = "";
  saveTimer = window.setTimeout(() => {
    statusSaved.textContent = storage.save("doc", doc) ? "已自動儲存草稿" : "無法儲存草稿（瀏覽器封鎖了儲存空間）";
  }, 500);
}

function setFileName(name: string): void {
  fileName = name;
  statusFile.textContent = name;
  document.title = `${name} - Markdown 編輯器`;
  storage.save("name", name);
}

// ---- 編輯器 -------------------------------------------------------------

const editor = createEditor($<HTMLElement>("#editor"), storage.load("doc") ?? sample, {
  onChange(doc) {
    scheduleRender();
    scheduleAutosave(doc);
  },
  onScroll(line) {
    editorTopLine = line;
    syncPreview();
  },
  extraKeys: [{ key: "Mod-s", run: () => (void actions.save(), true), preventDefault: true }],
});

function openDocument(name: string, text: string, handle: OpenedFile["handle"]): void {
  fileHandle = handle;
  setFileName(name);
  loadDoc(editor, text);
  editorTopLine = 1;
  storage.save("doc", text);
  scheduleRender();
}

// ---- 工具列 -------------------------------------------------------------

const actions: Record<string, () => void | Promise<void>> = {
  new() {
    if (editor.state.doc.length > 0 && !confirm("要開新文件嗎？目前的草稿會被清除。")) return;
    openDocument(DEFAULT_NAME, "", null);
  },
  async open() {
    const file = await openFile(fileInput);
    if (file) openDocument(file.name, file.text, file.handle);
  },
  async save() {
    const saved = await saveFile(editor.state.doc.toString(), fileName, fileHandle);
    if (!saved) return;
    fileHandle = saved.handle;
    setFileName(saved.name);
    statusSaved.textContent = saved.handle ? `已儲存到 ${saved.name}` : `已下載 ${saved.name}`;
  },
  export() {
    const html = renderDocument(editor.state.doc.toString());
    download(replaceExtension(fileName, ".html"), html, "text/html");
  },
  async "copy-html"() {
    const html = preview.result?.html ?? "";
    // 複製出去的 HTML 不需要捲動同步用的 data-sourcepos。
    await navigator.clipboard.writeText(html.replace(/ data-sourcepos="[^"]*"/g, ""));
    statusSaved.textContent = "已複製 HTML";
  },
  "toggle-outline"() {
    const btn = $<HTMLButtonElement>("[data-action='toggle-outline']");
    const hidden = workspace.classList.toggle("no-outline");
    btn.setAttribute("aria-pressed", String(!hidden));
    storage.save("outline", hidden ? "hidden" : "shown");
  },
  "toggle-theme"() {
    const root = document.documentElement;
    const current = root.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    storage.save("theme", next);
  },
};

document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    try {
      await actions[btn.dataset.action!]();
    } catch (e) {
      console.error(e);
      alert(`操作失敗：${e instanceof Error ? e.message : e}`);
    }
  });
});

function setView(mode: ViewMode): void {
  workspace.dataset.view = mode;
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.view === mode));
  });
  storage.save("view", mode);
  blocks = null;
  if (mode !== "preview") editor.requestMeasure();
  syncPreview();
}

document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((btn) => {
  btn.addEventListener("click", () => setView(btn.dataset.view as ViewMode));
});

// ---- 拖曳開檔 -----------------------------------------------------------

const overlay = $<HTMLElement>(".drop-overlay");
let dragDepth = 0;
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
  const file = e.dataTransfer?.files[0];
  if (file) openDocument(file.name, await file.text(), null);
});

// ---- 初始狀態 -----------------------------------------------------------

const savedTheme = storage.load("theme");
if (savedTheme === "light" || savedTheme === "dark") document.documentElement.dataset.theme = savedTheme;
if (storage.load("outline") === "hidden") actions["toggle-outline"]();
const savedView = storage.load("view");
setView(savedView === "editor" || savedView === "preview" ? savedView : "split");
setFileName(fileName);
scheduleRender();
