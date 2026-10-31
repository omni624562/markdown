/**
 * 左側圖示列：面板圖示的順序與顯示、釘上去的指令按鈕；也包含右鍵選單、插入選單、Word 匯入匯出、範本、圖表複製。
 */
import type { CompletionContext, CompletionResult } from "../../node_modules/@codemirror/autocomplete/dist/index.ts";
import { imageUrls, render as renderMarkdown } from "../../pkg/md_wasm.js";
import { type Command, formatKeys } from "../commands.ts";
import { dateFormats } from "../date-complete.ts";
import { desktop, isRemote } from "../desktop.ts";
import { bytesToBase64, saveFile, desktopHandle, replaceExtension, stem, downloadBytes } from "../files.ts";
import { insertBlock } from "../format.ts";
import { t } from "../i18n.ts";
import { compressImage } from "../image-compress.ts";
import { encodeLinkPath } from "../link-complete.ts";
import { basename, dirname, localImagePath } from "../paths.ts";
import { richHtml, fileUrl as localFileUrl } from "../rich-copy.ts";
import { saveDraft } from "../session.ts";
import { type Settings, ACTIVITY_LIMIT } from "../settings.ts";
import { type SlashItem, slashCompletion } from "../slash-complete.ts";
import { type SvgImageOptions, standaloneSvg, svgDataUrl, svgToPng } from "../svg-image.ts";
import { type Template, BUILTIN_TEMPLATES, fillTemplate, templateFileName, TEMPLATE_LIMITS } from "../templates.ts";
import { TOC_START, updateToc, tocBlock } from "../toc.ts";
import { choose, askText } from "../ui/choice.ts";
import { icon } from "../ui/icons.ts";
import { textField, fieldMenu, selectionMenu } from "../ui/input-menu.ts";
import { openLightbox } from "../ui/lightbox.ts";
import { type MenuEntry, setupMenu } from "../ui/menu.ts";
import { sortByGroup } from "../ui/palette.ts";
import { Picker } from "../ui/picker.ts";
import { Slideshow, splitSlides, slideAtLine } from "../ui/slideshow.ts";
import { SymbolPicker } from "../ui/symbol-picker.ts";
import { toast } from "../ui/toast.ts";
import { setupWindowControls } from "../ui/window-controls.ts";
import { isWorkItemShortcut } from "../wiki-shortcuts.ts";
import { aiFound } from "./ai-terminal.ts";
import { reportError } from "./git-actions.ts";
import { HISTORY_COMMANDS, historyView, markHistoryButtons } from "./git-history.ts";
import { keepItem, selectItem } from "./item-tabs.ts";
import { selectedText } from "./new-work-item.ts";
import { issueSide, toggleIssueSide } from "./wiki-edit.ts";
import { barShortcuts, openBarShortcut, removeBarShortcut, shortcutBar, shortcutName, setBarShortcuts } from "./work-items-panel.ts";
import type { SidePanel } from "../main.ts";
import { setWikiRight, wikiRightWanted } from "./workspace-ui.ts";
import { app } from "./context.ts";


/** 面板圖示的名稱（aria-label 會加上變更數，這裡用固定的名稱）。 */
export const PANEL_LABELS: Record<SidePanel, () => string> = {
  files: () => t("檔案"),
  outline: () => t("大綱"),
  search: () => t("搜尋"),
  tasks: () => t("待辦總覽"),
  tags: () => t("標籤"),
  issues: () => t("Issues（GitHub）"),
  workitems: () => t("工作項目（Azure DevOps）"),
  wiki: () => t("Wiki（Azure DevOps）"),
  git: () => t("原始碼控制（Git）"),
};
export const PANEL_ICONS: Record<SidePanel, string> = {
  files: "files",
  outline: "list-tree",
  search: "search",
  tasks: "list-checks",
  tags: "tags",
  issues: "circle-dot",
  workitems: "square-kanban",
  wiki: "book-open-text",
  git: "git-branch",
};

/** 依設定排列面板圖示（沒列到的照預設順序排在後面）、隱藏使用者不要的圖示。 */
export function panelOrder(): SidePanel[] {
  // 前幾版的「Azure DevOps」一個圖示，換成拆開後的「工作項目」「Wiki」兩個（位置不變）。
  const ids = app.settings.value.activityOrder.flatMap((p) => (p === app.LEGACY_ADO_PANEL ? ["workitems", "wiki"] : [p]));
  const saved = [...new Set(ids)].filter((p): p is SidePanel => (app.SIDE_PANELS as string[]).includes(p));
  return [...saved, ...app.SIDE_PANELS.filter((p) => !saved.includes(p))];
}

export function applyActivityLayout(): void {
  const bar = app.$(".activity-tabs");
  for (const p of panelOrder()) bar.append(app.$(`#side-tab-${p}`));
  const hidden = app.settings.value.activityHidden;
  // 前幾版隱藏了「Azure DevOps」：拆開後的兩個也隱藏。
  const isHidden = (p: string) => hidden.includes(p) || ((p === "workitems" || p === "wiki") && hidden.includes(app.LEGACY_ADO_PANEL));
  for (const tab of app.sideTabs) tab.classList.toggle("user-hidden", isHidden(tab.dataset.panel!));
  renderActivityCommands();
}

/** 釘上去的指令按鈕。 */
function renderActivityCommands(): void {
  const box = app.$(".activity-cmds");
  box.replaceChildren(
    ...app.settings.value.activityCommands.flatMap((id) => {
      const cmd = app.commands.get(id);
      if (!cmd) return [];
      const b = document.createElement("button");
      b.type = "button";
      b.className = "activity-btn activity-cmd";
      b.dataset.command = id;
      b.title = app.withKeys(cmd.title, cmd.keys);
      b.setAttribute("aria-label", cmd.title);
      b.draggable = true;
      b.append(icon(cmd.icon ?? "command"));
      b.addEventListener("click", () => {
        if (HISTORY_COMMANDS.includes(id) && historyView?.isOpen) historyView.close();
        else void app.commands.run(id).catch(reportError);
      });
      return [b];
    }),
  );
  markHistoryButtons();
  refreshActivityCommands();
}

/** 指令能不能用會隨著開啟的資料夾、Git 狀態改變（例如沒有 Git 儲存庫時不顯示 Git 歷史）。 */
export function refreshActivityCommands(): void {
  const box = app.$(".activity-cmds");
  for (const b of box.querySelectorAll<HTMLButtonElement>("button")) {
    const cmd = app.commands.get(b.dataset.command!);
    b.hidden = !cmd || !(cmd.when?.() ?? true);
  }
  box.hidden = ![...box.querySelectorAll("button")].some((b) => !(b as HTMLElement).hidden);
}

function setActivity(patch: Partial<Pick<Settings, "activityOrder" | "activityHidden" | "activityCommands">>): void {
  app.settings.update(patch);
}

/** 選一個指令釘到圖示列上。 */
function pickActivityCommand(): Promise<string | null> {
  return new Promise((resolve) => {
    let picked: string | null = null;
    const picker = new Picker<Command>({
      label: t("新增按鈕到圖示列"),
      placeholder: t("選一個指令，放到左邊的圖示列"),
      empty: t("找不到符合的指令"),
      columns: true,
      query: (q) => {
        const pinned = new Set(app.settings.value.activityCommands);
        const needle = q.trim().toLowerCase();
        return sortByGroup(app.commands.available()).filter(
          (c) => c.icon && !pinned.has(c.id) && c.id !== "palette" && (!needle || `${c.group} ${c.title}`.toLowerCase().includes(needle)),
        );
      },
      render: (c) => ({ title: c.title, detail: c.group, icon: c.icon, keys: c.keys && formatKeys(c.keys) }),
      pick: (c) => (picked = c.id),
      closed: () => resolve(picked),
    });
    picker.open();
  });
}

export async function addActivityCommand(): Promise<void> {
  const id = await pickActivityCommand();
  if (!id) return;
  const list = app.settings.value.activityCommands.filter((x) => x !== id);
  if (list.length >= ACTIVITY_LIMIT) {
    toast(t("圖示列最多放 {n} 個按鈕。", { n: ACTIVITY_LIMIT }), { tone: "error" });
    return;
  }
  setActivity({ activityCommands: [...list, id] });
  toast(t("已把「{name}」放到圖示列，拖曳可以調整位置。", { name: app.commands.get(id)?.title ?? id }), { tone: "success" });
}

/** 圖示列的右鍵選單：勾選要顯示的面板與按鈕、新增按鈕、到設定調整。 */
function openActivityMenu(at: DOMRect): void {
  for (const id of ["activity-menu-anchor", "activity-menu-anchor-popover"]) document.getElementById(id)?.remove();
  const toggleHidden = (p: SidePanel) => {
    const hidden = app.settings.value.activityHidden;
    setActivity({ activityHidden: hidden.includes(p) ? hidden.filter((x) => x !== p) : [...hidden, p] });
  };
  const entries: MenuEntry[] = [
    ...panelOrder()
      .filter((p) => !app.$(`#side-tab-${p}`).hidden)
      .map((p) => ({
        label: PANEL_LABELS[p](),
        icon: PANEL_ICONS[p],
        checked: () => !app.settings.value.activityHidden.includes(p),
        run: () => toggleHidden(p),
      })),
    {
      label: t("Wiki 放在右側"),
      icon: "panel-right",
      when: () => !!app.ado?.account,
      checked: () => wikiRightWanted,
      run: () => setWikiRight(!wikiRightWanted),
    },
    "-",
    ...app.settings.value.activityCommands.flatMap((id) => {
      const cmd = app.commands.get(id);
      return cmd
        ? [
            {
              label: cmd.title,
              icon: cmd.icon,
              checked: () => app.settings.value.activityCommands.includes(id),
              run: () => setActivity({ activityCommands: app.settings.value.activityCommands.filter((x) => x !== id) }),
            },
          ]
        : [];
    }),
    "activity-add",
    "activity-customize",
  ];
  floatingMenu("activity-menu-anchor", entries).open(at);
}

/** 安裝說明的網址。 */
const AI_INSTALL_URL = { claude: "https://docs.claude.com/en/docs/claude-code/setup", codex: "https://github.com/openai/codex" } as const;

/** 在終端機啟動 AI 工具；還沒開啟 AI 協作或沒安裝時，說明下一步。 */
export async function startAiTool(tool: "claude" | "codex"): Promise<void> {
  const name = tool === "claude" ? "Claude Code" : "Codex";
  if (!app.ai?.enabled) {
    toast(t("要先在設定開啟「啟用 AI 協作」，才能在終端機使用 {name}。", { name }), {
      duration: 12000,
      action: { label: t("開啟設定"), run: () => app.settingsDialog.open(t("AI 協作")) },
    });
    return;
  }
  if (!aiFound[tool]) {
    toast(t("這台電腦還沒有安裝 {name}。安裝好之後重新開啟 oMarker 就能使用。", { name }), {
      duration: 15000,
      action: { label: t("安裝說明"), run: () => void desktop?.openExternal(AI_INSTALL_URL[tool]).catch(reportError) },
    });
    return;
  }
  await app.terminal?.start(tool);
}

/** 說明：在新分頁開啟歡迎文件（第一次開啟時看到的那份），之後也找得回來。 */
export function openWelcome(): void {
  const existing = app.docs.find((d) => !d.path && d.name === t("歡迎使用 oMarker.md"));
  if (existing) {
    app.activate(existing);
    return;
  }
  const doc = app.makeDoc({ name: t("歡迎使用 oMarker.md"), kind: "markdown", baseline: app.hash(app.sample) });
  saveDraft(doc.id, app.sample);
  app.addTab(doc);
}

/** 說明：在新分頁開啟更新紀錄（打包進程式的 CHANGELOG.md，用到時才載入）。 */
export async function openChangelog(): Promise<void> {
  const name = t("oMarker 更新紀錄.md");
  const existing = app.docs.find((d) => !d.path && d.name === name);
  if (existing) {
    app.activate(existing);
    return;
  }
  const { default: changelog } = await import("../../../CHANGELOG.md?raw");
  // 開頭的說明連到儲存庫裡的其他檔案，在這裡點不開：從第一個版本開始。
  const start = changelog.indexOf("\n## ");
  const text = "# " + t("oMarker 更新紀錄") + "\n" + (start >= 0 ? changelog.slice(start) : changelog);
  const doc = app.makeDoc({ name, kind: "markdown", baseline: app.hash(text) });
  saveDraft(doc.id, text);
  app.addTab(doc);
}

/** 用瀏覽器開啟網址（桌面版交給系統的預設瀏覽器）。 */
export function openUrl(url: string): void {
  if (desktop) void desktop.openExternal(url).catch(reportError);
  else window.open(url, "_blank", "noopener");
}

/** 說明：所有快速鍵（依功能分組，只列目前能用的）。 */
export function showShortcuts(): void {
  const dialog = document.createElement("dialog");
  dialog.className = "choice shortcuts-dialog";
  dialog.setAttribute("aria-label", t("快速鍵一覽"));
  const h = document.createElement("h2");
  h.textContent = t("快速鍵一覽");
  const hint = document.createElement("p");
  hint.textContent = t("編輯區裡按 Tab 是縮排；要用鍵盤離開編輯區，先按 Esc 再按 Tab。所有功能都可以用 {keys} 搜尋。", { keys: formatKeys("Mod-Shift-p") });
  const body = document.createElement("div");
  body.className = "shortcuts-body";
  const groups = new Map<string, [string, string][]>();
  for (const c of sortByGroup(app.commands.available())) {
    const keys = c.keys ?? c.shownKeys;
    if (!keys) continue;
    const list = groups.get(c.group ?? "") ?? [];
    list.push([c.title, formatKeys(keys)]);
    groups.set(c.group ?? "", list);
  }
  for (const [group, items] of groups) {
    const g = document.createElement("h3");
    g.textContent = group;
    const table = document.createElement("table");
    for (const [title, keys] of items) {
      const row = table.insertRow();
      row.insertCell().textContent = title;
      const k = document.createElement("kbd");
      k.textContent = keys;
      row.insertCell().append(k);
    }
    body.append(g, table);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn-primary";
  close.textContent = t("關閉");
  close.autofocus = true;
  close.addEventListener("click", () => dialog.close());
  const actions = document.createElement("div");
  actions.className = "choice-actions";
  actions.append(close);
  dialog.append(h, hint, body, actions);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/** 格式工具列的下拉按鈕（標題、插入），建立一次之後重複使用。 */
function formatMenuButton(id: string, label: string, iconName: string, entries: string[]): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.id = id;
  b.className = "btn format-menu";
  b.title = label;
  b.append(icon(iconName), Object.assign(document.createElement("span"), { textContent: label }), icon("chevron-down"));
  b.addEventListener("mousedown", (e) => e.preventDefault());
  setupMenu(b, app.commands, entries);
  return b;
}
export let headingMenu: HTMLButtonElement;
export let insertMenu: HTMLButtonElement;

/** 執行指令的按鈕（格式工具列、選取時浮出的按鈕共用）。 */
export function commandButton(id: string, withLabel = false): HTMLButtonElement {
  const cmd = app.commands.get(id)!;
  const b = document.createElement("button");
  b.type = "button";
  b.className = withLabel ? "btn" : "btn icon-only";
  b.title = app.withKeys(cmd.title, cmd.keys);
  b.setAttribute("aria-label", cmd.title);
  b.append(icon(cmd.icon!));
  if (withLabel) b.append(Object.assign(document.createElement("span"), { textContent: cmd.title }));
  // 用 mousedown 阻止預設行為，按下按鈕時編輯器才不會失去選取範圍。
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => app.commands.run(id).catch(reportError));
  return b;
}

export function separator(className: string): HTMLElement {
  const sep = document.createElement("span");
  sep.className = className;
  sep.setAttribute("aria-hidden", "true");
  return sep;
}

/** 選取文字時浮出的格式按鈕。 */
export function formatBubble(): HTMLElement {
  const bar = document.createElement("div");
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", t("格式"));
  bar.append(...["bold", "italic", "underline", "strike", "highlight", "code", "link"].map((id) => commandButton(id)));
  const more = document.createElement("button");
  more.type = "button";
  more.className = "btn icon-only";
  more.title = t("更多格式（上標、下標、清除格式、符號）");
  more.setAttribute("aria-label", t("更多格式"));
  more.append(icon("ellipsis"));
  more.addEventListener("mousedown", (e) => e.preventDefault());
  more.addEventListener("click", () => moreFormatMenu.open(more.getBoundingClientRect()));
  bar.append(more);
  const aiButtons = ["ai-actions", "send-to-terminal-ai"].filter((id) => app.commands.get(id)?.when?.() ?? false);
  if (aiButtons.length) bar.append(separator("format-sep"), ...aiButtons.map((id) => commandButton(id)));
  return bar;
}

/**
 * 浮動選單（插入選單、更多格式、右鍵選單）：用一個看不見的定位按鈕決定選單出現的位置。
 * 按 Esc 或點外面關閉時，焦點回到編輯器。
 */
export function floatingMenu(id: string, entries: MenuEntry[], onClose?: () => void): { open(at: DOMRect): void } {
  const anchor = document.createElement("button");
  anchor.type = "button";
  anchor.id = id;
  anchor.className = "insert-anchor";
  anchor.tabIndex = -1;
  document.body.append(anchor);
  const menu = setupMenu(anchor, app.commands, entries);
  menu.addEventListener("toggle", (e) => {
    const closed = (e as ToggleEvent).newState === "closed";
    if (closed && (document.activeElement === anchor || document.activeElement === document.body)) app.editor.view.focus();
    if (closed) onClose?.();
  });
  return {
    open(at) {
      Object.assign(anchor.style, {
        left: `${at.left}px`,
        top: `${at.top}px`,
        width: `${at.width}px`,
        height: `${at.height}px`,
      });
      if (!menu.matches(":popover-open")) anchor.click();
    },
  };
}

/** 插入選單：空白行左邊的「＋」或 Ctrl+Shift+Enter 開啟，位置跟著按鈕或游標。 */
let insertMenuUi: ReturnType<typeof floatingMenu>;
export const openInsertMenu = (at: DOMRect) => insertMenuUi.open(at);

/** 斜線指令的項目：插入選單的內容，加上篩選用的英文與別名（中文別名不是介面文字，兩種語言都能用來篩選）。 */
const SLASH_KEYWORDS: Record<string, string> = {
  h1: "h1 heading 大標題", // i18n-ignore
  h2: "h2 heading",
  h3: "h3 heading",
  bullet: "ul list bullet 清單", // i18n-ignore
  ordered: "ol list number 數字 編號", // i18n-ignore
  task: "todo task checkbox 待辦 勾選", // i18n-ignore
  quote: "quote blockquote 引言", // i18n-ignore
  table: "table 表", // i18n-ignore
  "code-block": "code 程式", // i18n-ignore
  "math-block": "math latex 數學 公式", // i18n-ignore
  "mermaid-block": "mermaid diagram flow 圖", // i18n-ignore
  "insert-image": "image img picture 照片", // i18n-ignore
  hr: "hr line divider 分隔", // i18n-ignore
  "insert-toc": "toc 目錄", // i18n-ignore
  "insert-symbol": "symbol 符號 特殊", // i18n-ignore
  "insert-today": "date today 日期 今天", // i18n-ignore
  "insert-work-item-link": "workitem work item issue bug task 工作項目 工單 連結", // i18n-ignore
  "insert-wiki-link": "wiki page link 頁面 連結", // i18n-ignore
};
function slashItems(): SlashItem[] {
  return Object.entries(SLASH_KEYWORDS).flatMap(([id, keywords]) => {
    if (id === "insert-today") return [{ id, title: t("今天的日期"), keywords }];
    const cmd = app.commands.get(id);
    if (!cmd || !(cmd.when?.() ?? true)) return [];
    const keys = cmd.keys ?? cmd.shownKeys;
    return [{ id, title: cmd.title, keywords, keys: keys ? formatKeys(keys) : undefined }];
  });
}
export // 在 init 時建立。
let slashSource: (ctx: CompletionContext) => CompletionResult | null;

/** 浮出格式按鈕的「更多」：上標、下標、清除格式、符號。 */
let moreFormatMenu: ReturnType<typeof floatingMenu>;

/** 分頁的右鍵選單。 */
export // 在 init 時建立。
let tabMenu: { open(at: DOMRect): void; };

export let contextMenu: ReturnType<typeof floatingMenu>;

export // 在 init 時建立。
let symbolPicker: SymbolPicker;

let slideshow: Slideshow | null = null;

/** 簡報模式：用預覽的內容（公式、流程圖都畫好了）切成一頁一頁播放。 */
export async function startSlideshow(fromCursor: boolean): Promise<void> {
  app.renderNow(true);
  // 等流程圖等非同步的外掛畫完。
  await new Promise((r) => setTimeout(r, 120));
  const slides = splitSlides(app.previewEl);
  if (!slides.length) {
    toast(t("文件是空的，沒有可以播放的內容。"));
    return;
  }
  slideshow ??= new Slideshow((href) => void app.followLink(href).catch(reportError));
  const line = app.editor.view.state.doc.lineAt(app.editor.view.state.selection.main.head).number;
  slideshow.open(slides, fromCursor ? slideAtLine(slides, line) : 0, () => app.editor.view.focus());
  if (slides.length === 1 && !app.editor.text.includes("\n---")) {
    toast(t("用一行 --- 把內容分成多頁；沒有分隔線時，每個一級、二級標題各一頁。"), { duration: 6000 });
  }
}

/** 讓使用者選一個檔案（網頁版）。 */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.hidden = true;
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => done(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

/**
 * 匯入 Word：桌面版在 Word 檔旁邊存成同名的 .md（圖片存到旁邊的 assets 資料夾）並開啟；
 * 網頁版開成新分頁，圖片內嵌在文件裡。
 */
export async function importDocx(): Promise<void> {
  if (desktop) {
    const picked = await desktop.importDocx();
    if (picked) await importDocxData(picked.name, picked.data, picked.mdPath);
    return;
  }
  let file: File | null = null;
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: [{ description: t("Word 文件"), accept: { [DOCX_TYPE]: [".docx"] } }] });
      file = await handle.getFile();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      throw e;
    }
  } else file = await pickFile(`.docx,${DOCX_TYPE}`);
  if (file) await importDocxData(file.name, await file.arrayBuffer(), null);
}

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** 轉換 Word 檔：`mdPath` 是要存成的 Markdown 檔（桌面版選檔匯入），null 時開成未存檔的新分頁、圖片內嵌。 */
export async function importDocxData(name: string, data: ArrayBuffer, mdPath: string | null): Promise<void> {
  toast(t("正在轉換「{name}」…", { name }));
  const { docxToMarkdown, imageExtension } = await import("../docx-import.ts");
  let skipped = 0;
  const result = await docxToMarkdown(data, async (bytes, type) => {
    let ext = imageExtension(type);
    if (!ext) {
      skipped++;
      return "";
    }
    if (app.settings.value.imageCompress) {
      const c = await compressImage(new File([bytes as BlobPart], `image.${ext}`, { type }));
      if (c.changed) {
        bytes = new Uint8Array(await c.file.arrayBuffer());
        type = c.file.type;
        ext = imageExtension(type) ?? ext;
      }
    }
    // 檔名可能有空白或括號（「週報 (2)-….png」），連結中要編碼。
    if (mdPath) return encodeLinkPath(await desktop!.saveImage(mdPath, bytesToBase64(bytes), ext));
    return `data:${type};base64,${bytesToBase64(bytes)}`;
  });
  const notes = [
    skipped ? t("{n} 張圖片的格式不支援（例如 EMF 向量圖），沒有匯入", { n: skipped }) : "",
    result.warnings.length ? t("有 {n} 處格式沒辦法完整轉換", { n: result.warnings.length }) : "",
  ].filter(Boolean);
  if (mdPath) {
    const out = await saveFile(result.markdown, basename(mdPath), "markdown", desktopHandle(mdPath, basename(mdPath)));
    if (!out || out.status !== "saved") return;
    app.fileListCache = null;
    app.indexStale = true;
    await app.openPath(mdPath);
    void app.fileTree?.refresh([dirname(mdPath)]);
    toast(t("已匯入「{name}」，存成「{file}」。{notes}", { name, file: basename(mdPath), notes: notes.join(t("；")) }), { tone: "success", duration: notes.length ? 10000 : undefined });
  } else {
    app.openDocument(replaceExtension(name, ".md"), result.markdown, null, { kind: "markdown", fromFile: false });
    toast(t("已匯入「{name}」，存檔時再選擇位置。{notes}", { name, notes: notes.join(t("；")) }), { tone: "success", duration: notes.length ? 10000 : undefined });
  }
}

/**
 * 匯出 Word：圖片從本機、遠端資料夾或網址讀取，讀不到的改成文字說明。
 * 桌面版在後端產生 .docx（Rust）；網頁版用 docx 套件。
 */
export async function exportDocx(): Promise<void> {
  refreshToc();
  const docDir = app.fileHandle?.path ? dirname(app.fileHandle.path) : null;
  const { loadImage } = await import("../docx-image.ts");
  const image = async (src: string) => {
    let url: string | null = null;
    if (/^(https?:|data:image\/)/i.test(src)) url = src;
    else if (desktop && docDir) {
      const path = localImagePath(src, docDir);
      if (path) url = isRemote(path) ? await desktop.davImage(path) : desktop.fileUrl(path);
    }
    return url ? loadImage(url) : null;
  };
  const title = stem(app.fileName);
  let bytes: Uint8Array;
  if (desktop) {
    const images = await Promise.all(
      imageUrls(app.editor.text).map(async (url) => {
        const img = await image(url).catch(() => null);
        return img && { url, kind: img.type, width: img.width, height: img.height, data: bytesToBase64(img.data) };
      }),
    );
    bytes = new Uint8Array(await desktop.exportDocx(app.editor.text, title, images.filter((i) => i !== null)));
  } else {
    const { htmlToDocx } = await import("../docx-export.ts");
    const blob = await htmlToDocx(renderMarkdown(app.editor.text, { kind: "markdown" }).html, { title, image });
    bytes = new Uint8Array(await blob.arrayBuffer());
  }
  const name = replaceExtension(app.fileName, ".docx");
  const saved = await downloadBytes(
    name,
    bytes,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    t("Word 文件"),
  );
  if (saved && desktop) toast(t("已匯出「{name}」", { name: basename(saved) }), { tone: "success" });
}

/** 文件有目錄區塊（<!-- toc -->）時，依目前的標題更新（存檔前呼叫）。 */
export function refreshToc(): void {
  if (app.kind !== "markdown") return;
  const text = app.editor.text;
  if (!text.includes(TOC_START)) return;
  const next = updateToc(text, renderMarkdown(text, { kind: "markdown", skipHtml: true }).headings);
  if (next !== null) app.editor.replaceAll(next, { userEvent: "input.toc" });
}

/** 插入目錄；已經有目錄時改成更新。 */
export function insertToc(): void {
  const text = app.editor.text;
  const headings = renderMarkdown(text, { kind: "markdown", skipHtml: true }).headings;
  if (text.includes(TOC_START)) {
    const next = updateToc(text, headings);
    if (next !== null) app.editor.replaceAll(next, { userEvent: "input.toc", isolate: true });
    toast(next === null ? t("目錄已經是最新的。") : t("已更新目錄。"));
    return;
  }
  app.editor.exec(insertBlock(tocBlock(headings)));
  toast(t("已插入目錄，存檔時會自動更新。"));
}

type TemplateItem = Template & { custom: boolean };

export // 在 init 時建立。
let templatePicker: Picker<TemplateItem>;

export // 在 init 時建立。
let deleteTemplatePicker: Picker<Template>;

/** 把目前的文件存成自訂範本（同名時取代）。 */
export async function saveAsTemplate(): Promise<void> {
  const name = await askText(
    t("存成範本"),
    // 範本變數的名稱是固定的中文，不翻譯。
    t("範本名稱（可以在內容中使用 {date}、{week} 等變數）：", { date: "{{日期}}", week: "{{週次}}" }), // i18n-ignore
    stem(app.fileName),
  );
  if (!name) return;
  const body = app.editor.text;
  if (body.length > TEMPLATE_LIMITS.body) {
    toast(t("文件太長，無法存成範本。"), { tone: "error" });
    return;
  }
  const others = app.settings.value.templates.filter((tpl) => tpl.name !== name);
  if (others.length >= TEMPLATE_LIMITS.count) {
    toast(t("自訂範本最多 {n} 個，請先刪除一些。", { n: TEMPLATE_LIMITS.count }), { tone: "error" });
    return;
  }
  app.settings.update({ templates: [{ name, body }, ...others] });
  toast(t("已存成範本「{name}」，可以從「⋯」→「從範本新增…」使用", { name }), { tone: "success" });
}

/**
 * 複製為格式文字：選取範圍（沒有選取時是整份文件）渲染成 HTML 並加上行內樣式，
 * 同時放一份 Markdown 純文字，貼到純文字的地方時用。
 */
export async function copyRich(): Promise<void> {
  const selected = selectedText();
  const markdown = selected || app.editor.text;
  const docDir = app.fileHandle?.path && !isRemote(app.fileHandle.path) ? dirname(app.fileHandle.path) : null;
  const html = richHtml(renderMarkdown(markdown, { kind: "markdown" }).html, (src) => {
    if (/^(https?:|data:)/i.test(src) || !docDir) return null;
    const path = localImagePath(src, docDir);
    return path ? localFileUrl(path) : null;
  });
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([markdown], { type: "text/plain" }),
      }),
    ]);
  } catch {
    toast(t("無法寫入剪貼簿。"), { tone: "error" });
    return;
  }
  toast(
    selected
      ? t("已複製選取範圍的格式文字，可以貼到 Word、Outlook、Teams")
      : t("已複製整份文件的格式文字，可以貼到 Word、Outlook、Teams"),
    { tone: "success" },
  );
  app.editor.view.focus();
}

/** 流程圖單獨成為圖片時的字型與背景色（和畫面上一樣）。 */
function diagramImageOptions(): SvgImageOptions {
  const style = getComputedStyle(app.editor.view.contentDOM);
  const bg = getComputedStyle(document.body).backgroundColor;
  return { font: style.fontFamily, background: bg && bg !== "rgba(0, 0, 0, 0)" ? bg : "#ffffff" };
}

/** 放大檢視流程圖（即時預覽中的圖可以從這裡回到原始碼）。 */
export function openDiagram(svg: string, editSource?: () => void): void {
  const image = standaloneSvg(svg, diagramImageOptions());
  if (image) openLightbox(svgDataUrl(image.svg), t("流程圖"), editSource);
}

/** 預覽中程式碼區塊的「複製」。 */
export async function copyCode(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast(t("無法寫入剪貼簿。"), { tone: "error" });
    return false;
  }
}

/** 流程圖複製成 PNG，可以直接貼到 Word、簡報、聊天軟體。 */
export async function copyDiagram(svg: string): Promise<void> {
  try {
    const png = svgToPng(svg, diagramImageOptions());
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  } catch {
    toast(t("無法把流程圖複製成圖片。"), { tone: "error" });
    return;
  }
  toast(t("已把流程圖複製成圖片"), { tone: "success" });
}

export function initActivityBar(): void {
  headingMenu = formatMenuButton("fmt-heading", t("標題"), "heading", ["h1", "h2", "h3"]);
  insertMenu = formatMenuButton("fmt-insert", t("插入"), "plus", [
    "table",
    "code-block",
    "math-block",
    "mermaid-block",
    "insert-image",
    "hr",
  ]);
  insertMenuUi = floatingMenu("insert-anchor", [
    "h1",
    "h2",
    "h3",
    "-",
    "bullet",
    "ordered",
    "task",
    "quote",
    "-",
    "table",
    "code-block",
    "math-block",
    "mermaid-block",
    "insert-image",
    "hr",
    "insert-toc",
    "-",
    "insert-symbol",
    "insert-work-item-link",
    "insert-wiki-link",
  ]);
  moreFormatMenu = floatingMenu("format-more-anchor", ["superscript", "subscript", "-", "clear-format", "insert-symbol"]);
  contextMenu = floatingMenu("context-anchor", [
    "cut",
    "copy",
    "copy-rich",
    "paste",
    "paste-plain",
    "select-all",
    "-",
    "bold",
    "italic",
    "underline",
    "strike",
    "highlight",
    "code",
    "superscript",
    "subscript",
    "clear-format",
    "-",
    "link",
    "insert-symbol",
    "indent-more",
    "indent-less",
    "-",
    "ai-actions",
    "send-to-terminal-ai",
    "ado-create-from-selection",
    "-",
    "git-copy-link",
  ]);
  {
    const bar = app.$(".activity-bar");
    bar.addEventListener("contextmenu", (e) => {
      if ((e.target as HTMLElement).closest(".activity-project")) return;
      e.preventDefault();
      const at = new DOMRect(e.clientX, e.clientY, 0, 0);
      // 捷徑（Wiki 頁面、工作項目）：開啟或移除。
      const shortcut = (e.target as HTMLElement).closest<HTMLElement>(".activity-wiki-page");
      const item = shortcut ? barShortcuts[Number(shortcut.dataset.index)] : undefined;
      if (item) {
        for (const id of ["wiki-shortcut-anchor", "wiki-shortcut-anchor-popover"]) document.getElementById(id)?.remove();
        const menu = floatingMenu("wiki-shortcut-anchor", [
          { label: t("開啟"), icon: isWorkItemShortcut(item) ? "square-kanban" : "book-open-text", run: () => void openBarShortcut(item).catch(reportError) },
          { label: t("從左側圖示列移除"), icon: "pin-off", run: () => removeBarShortcut(item) },
        ]);
        if (e.buttons & 2) window.addEventListener("pointerup", () => setTimeout(() => menu.open(at)), { once: true });
        else menu.open(at);
        return;
      }
      // Linux 在按下右鍵時就觸發 contextmenu：等放開再開，免得放開時被當成點在選單外。
      if (e.buttons & 2) window.addEventListener("pointerup", () => setTimeout(() => openActivityMenu(at)), { once: true });
      else openActivityMenu(at);
    });
    // 拖曳圖示調整順序（面板圖示、釘選的按鈕各自排）。捷徑拖到圖示列外面放開就移除。
    let dragging: HTMLElement | null = null;
    /** 正在拖的捷徑被放在圖示列外面（放開後移除）。 */
    let dropOutside = false;
    const isShortcutDrag = () => !!dragging?.classList.contains("activity-wiki-page");
    const outsideBar = (e: DragEvent) => {
      const r = bar.getBoundingClientRect();
      return e.clientX > r.right + 4 || e.clientX < r.left - 4 || e.clientY < r.top - 4 || e.clientY > r.bottom + 4;
    };
    bar.addEventListener("dragstart", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>(".activity-tabs [role=tab], .activity-cmd, .activity-wiki-page");
      if (!el || !e.dataTransfer) return;
      dragging = el;
      dropOutside = false;
      e.dataTransfer.effectAllowed = "move";
      // 捷徑不帶文字，放到編輯區時才不會插入頁名。
      if (el.classList.contains("activity-wiki-page")) e.dataTransfer.setData("application/x-omarker-wiki-shortcut", "");
      else e.dataTransfer.setData("text/plain", el.getAttribute("aria-label") ?? "");
      el.classList.add("activity-dragging");
    });
    // 捷徑拖到圖示列外面：整個視窗都可以放（游標顯示可以放下），捷徑標成「放開就移除」。
    window.addEventListener(
      "dragover",
      (e) => {
        if (!isShortcutDrag()) return;
        const out = outsideBar(e);
        dragging!.classList.toggle("activity-removing", out);
        if (!out) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      },
      true,
    );
    window.addEventListener(
      "drop",
      (e) => {
        if (!isShortcutDrag() || !outsideBar(e)) return;
        // 不要讓編輯區或檔案樹處理這次放下。
        e.preventDefault();
        e.stopPropagation();
        dropOutside = true;
      },
      true,
    );
    bar.addEventListener("dragover", (e) => {
      if (!dragging) return;
      const over = (e.target as HTMLElement).closest<HTMLElement>(".activity-tabs [role=tab], .activity-cmd, .activity-wiki-page");
      if (!over || over === dragging || over.parentElement !== dragging.parentElement) return;
      e.preventDefault();
      const r = over.getBoundingClientRect();
      over.parentElement!.insertBefore(dragging, e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
    });
    bar.addEventListener("dragend", () => {
      if (!dragging) return;
      dragging.classList.remove("activity-dragging", "activity-removing");
      const fromTabs = dragging.parentElement === app.$(".activity-tabs");
      const fromWiki = dragging.parentElement === shortcutBar;
      const removed = fromWiki && dropOutside ? barShortcuts[Number(dragging.dataset.index)] : undefined;
      dragging = null;
      dropOutside = false;
      if (removed) {
        // 拖出去放開：移除，提示裡可以復原（放回原本的位置）。
        const before = barShortcuts;
        removeBarShortcut(removed);
        toast(t("已從左側圖示列移除「{name}」", { name: shortcutName(removed) }), {
          action: { label: t("復原"), run: () => setBarShortcuts(before) },
        });
      } else if (fromWiki) {
        setBarShortcuts([...shortcutBar.querySelectorAll<HTMLElement>(".activity-wiki-page")].map((b) => barShortcuts[Number(b.dataset.index)]));
      } else if (fromTabs) {
        setActivity({ activityOrder: [...app.$(".activity-tabs").querySelectorAll<HTMLElement>("[role=tab]")].map((b) => b.dataset.panel!) });
      } else {
        setActivity({ activityCommands: [...app.$(".activity-cmds").querySelectorAll<HTMLElement>(".activity-cmd")].map((b) => b.dataset.command!) });
      }
    });
    for (const tab of app.sideTabs) tab.draggable = true;
  }
  for (const el of document.querySelectorAll<HTMLButtonElement>(".project-switch, #activity-project")) {
    el.disabled = !desktop;
    el.addEventListener("click", () => void app.commands.run("switch-project").catch(reportError));
  }
  // Windows 桌面版：頂端列兼當標題列。
  void desktop
    ?.customTitleBar()
    .then((custom) => {
      if (custom) setupWindowControls(app.$(".topbar"), (action) => desktop!.windowControl(action));
    })
    .catch(console.error);
  app.status.save.addEventListener("click", () => void app.commands.run("save").catch(reportError));
  /**
   * 桌面版：其他元件沒有處理的右鍵（搜尋框、設定欄位、預覽裡選取的文字等）改用自己的小選單，
   * 不顯示 WebView2 內建的選單（裡面有重新整理、列印與 Windows 的語音輸入）。
   */
  if (desktop) {
    window.addEventListener("contextmenu", (e) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      const field = textField(e.target as Element);
      const entries = field ? fieldMenu(field) : selectionMenu();
      if (!entries.length) return;
      const at = new DOMRect(e.clientX, e.clientY, 0, 0);
      const open = () => {
        const ids = ["text-menu-anchor", "text-menu-anchor-popover"];
        for (const id of ids) document.getElementById(id)?.remove();
        const menu = floatingMenu("text-menu-anchor", entries, () => field?.focus());
        // 開著對話框（例如設定）時，對話框以外的東西都不能點：選單要放進對話框裡。
        const modal = [...document.querySelectorAll("dialog")].filter((d) => d.matches(":modal")).at(-1);
        if (modal) for (const id of ids) modal.append(document.getElementById(id)!);
        menu.open(at);
      };
      // Linux 按下右鍵就觸發 contextmenu：等放開再開，免得放開時被當成點在選單外。
      if (e.buttons & 2) window.addEventListener("pointerup", () => setTimeout(open), { once: true });
      else open();
    });
  }
  slashSource = slashCompletion(slashItems, (id) => {
    if (id === "insert-today") {
      app.editor.view.dispatch(app.editor.view.state.replaceSelection(dateFormats(new Date())[0].text), { userEvent: "input" });
      return;
    }
    void app.commands.run(id).catch(reportError);
  });
  tabMenu = floatingMenu(
    "tab-menu-anchor",
    [
      "tab-close",
      "tab-close-others",
      "tab-close-all",
      "tab-close-right",
      "tab-close-saved",
      "-",
      {
        label: t("固定分頁"),
        icon: "pin",
        checked: () => app.tabPinned(app.menuItemTab()?.id ?? app.menuTab().id),
        run: () => void app.commands.run("tab-pin"),
      },
      // 工作項目等的分頁：預覽分頁留下來、和文件並排。
      { label: t("保留分頁"), icon: "pin", when: () => !!app.menuItemTab()?.preview, run: () => keepItem(app.menuItemTab()!.id) },
      {
        label: t("在文件右邊並排顯示"),
        icon: "columns-2",
        when: () => !!app.menuItemTab(),
        checked: () => issueSide,
        run: () => {
          const tab = app.menuItemTab()!;
          toggleIssueSide();
          selectItem(tab.id);
        },
      },
      "-",
      "tab-copy-path",
      "tab-reveal",
    ],
    // 選單關閉後，指令面板裡的分頁指令回到「目前的分頁」。等點下的指令先讀到按右鍵的分頁。
    () => setTimeout(() => (app.menuTabId = null)),
  );
  symbolPicker = new SymbolPicker((text) => {
    app.editor.view.dispatch(app.editor.view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input.symbol" });
    app.editor.view.focus();
  });
  templatePicker = new Picker<TemplateItem>({
    label: t("從範本新增文件"),
    placeholder: t("選擇範本"),
    empty: t("沒有符合的範本。"),
    query(q) {
      const all: TemplateItem[] = [
        ...app.settings.value.templates.map((tpl) => ({ ...tpl, custom: true })),
        ...BUILTIN_TEMPLATES.map((tpl) => ({ ...tpl, custom: false })),
      ];
      const needle = q.trim().toLowerCase();
      return needle ? all.filter((tpl) => tpl.name.toLowerCase().includes(needle)) : all;
    },
    render: (tpl) => ({ title: tpl.name, detail: tpl.custom ? t("自訂範本") : t("內建範本"), icon: "layout-template" }),
    pick(tpl) {
      const body = fillTemplate(tpl.body);
      const doc = app.makeDoc({ name: templateFileName(tpl.name), kind: "markdown", baseline: app.hash(body) });
      saveDraft(doc.id, body);
      app.addTab(doc);
      app.editor.view.focus();
    },
  });
  deleteTemplatePicker = new Picker<Template>({
    label: t("刪除自訂範本"),
    placeholder: t("選擇要刪除的範本"),
    empty: t("還沒有自訂範本。"),
    query: (q) => app.settings.value.templates.filter((tpl) => tpl.name.includes(q.trim())),
    render: (tpl) => ({ title: tpl.name, icon: "x" }),
    async pick(tpl) {
      const ok = await choose(t("刪除範本？"), t("要刪除自訂範本「{name}」嗎？", { name: tpl.name }), [
        { id: "delete", label: t("刪除"), danger: true },
        { id: "cancel", label: t("取消"), primary: true },
      ]);
      if (ok !== "delete") return;
      app.settings.update({ templates: app.settings.value.templates.filter((x) => x.name !== tpl.name) });
      toast(t("已刪除範本「{name}」", { name: tpl.name }));
    },
  });
}
