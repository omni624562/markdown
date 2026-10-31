/**
 * 指令：指令面板（Ctrl+Shift+P）裡的所有指令與快捷鍵。
 */
import { render as renderMarkdown, formatJson, formatAllTables, spacingPositions } from "../../pkg/md_wasm.js";
import { Commands, type Command } from "../commands.ts";
import { desktop, displayPath, isRemote } from "../desktop.ts";
import { openFile, stem, replaceExtension, download } from "../files.ts";
import { insertBlock, toggleWrap, insertLink, clearInlineFormat, toggleLineStyle, TABLE_TEMPLATE } from "../format.ts";
import { t } from "../i18n.ts";
import { KINDS, type DocKind } from "../kinds.ts";
import { saveDraft } from "../session.ts";
import { DEFAULTS as DEFAULT_SETTINGS } from "../settings.ts";
import { Palette } from "../ui/palette.ts";
import { REPO_URL } from "../ui/settings-dialog.ts";
import { toast } from "../ui/toast.ts";
import { templatePicker, saveAsTemplate, deleteTemplatePicker, showShortcuts, openWelcome, openChangelog, openUrl, exportDocx, startSlideshow, importDocx, copyRich, insertToc, openInsertMenu } from "./activity-bar.ts";
import { searchPanel } from "./git-history.ts";
import { closeItem, itemTabs, setItemPinned, tabOrder } from "./item-tabs.ts";
import { imageInput } from "./new-work-item.ts";
import { runTableEdit } from "./offline-drive.ts";
import { exportPdf } from "./pdf-export.ts";
import { settingsDialog, fixTerms, convertToTraditional, toggleSetting, changeFontSize } from "./settings-ui.ts";
import { issueView, issueSide } from "./wiki-edit.ts";
import { gitPanel } from "./work-item-updates.ts";
import { foldAll, unfoldAll } from "@codemirror/language";
import { openSearchPanel } from "@codemirror/search";
import { app } from "./context.ts";


export const commands = new Commands();
const isMarkdown = () => app.kind === "markdown" && app.view !== "preview";

/** 插入一段範例區塊，並選取第 `line` 行（從 0 算起）的範例文字，直接打字就能取代。 */
function insertPlaceholder(text: string, line: number): void {
  app.editor.exec(insertBlock(text, text.split("\n")[line]?.trim()));
}

function fmt(id: string, title: string, iconName: string, run: () => void, keys?: string, group = t("格式")): Command {
  return { id, title, group, icon: iconName, keys, when: isMarkdown, run };
}

const palette = new Palette(commands);
export const TERMINAL_KEYS = new Set(["palette", "toggle-terminal"]);

/** 按右鍵的分頁（從指令面板執行時是目前的分頁）的 id：工作項目等或文件。 */
const menuTabId = (): string => app.menuItemTab()?.id ?? app.menuTab().id;

/** `id` 右邊沒有固定的分頁。 */
function rightOf(id: string): string[] {
  const order = tabOrder();
  return order.slice(order.indexOf(id) + 1).filter((x) => !app.tabPinned(x));
}

/** 沒有未存變更、沒有固定的分頁（工作項目等沒有要存的，也算）。 */
function savedTabs(): string[] {
  return tabOrder().filter(
    (id) => !app.tabPinned(id) && (itemTabs.some((tab) => tab.id === id) || app.docs.some((d) => d.id === id && !d.dirty)),
  );
}

export function initCommands(): void {
  commands.register(
    {
      id: "new",
      title: t("新增文件"),
      group: t("檔案"),
      icon: "file-plus",
      // 桌面版用一般的 Ctrl+N；網頁版的 Ctrl+N 會被瀏覽器拿去開新視窗。
      keys: desktop ? "Mod-n" : "Mod-Alt-n",
      run() {
        const doc = app.makeDoc({ name: t("未命名{ext}", { ext: KINDS[app.kind].ext }), kind: app.kind });
        saveDraft(doc.id, "");
        app.addTab(doc);
        app.editor.view.focus();
      },
    },
    {
      id: "reopen-closed-tab",
      title: t("重新開啟關閉的分頁"),
      group: t("分頁"),
      icon: "history",
      // 網頁版的 Ctrl+W、Ctrl+Shift+T、Ctrl+Tab 會被瀏覽器拿去用（關掉整個瀏覽器分頁），改用其他按鍵。
      keys: desktop ? "Mod-Shift-t" : "Mod-Alt-Shift-t",
      run: () => app.reopenClosedTab(),
    },
    {
      id: "new-from-template",
      title: t("從範本新增…"),
      group: t("檔案"),
      icon: "layout-template",
      run: () => templatePicker.open(),
    },
    {
      id: "save-as-template",
      title: t("把目前文件存成範本…"),
      group: t("檔案"),
      icon: "layout-template",
      when: () => app.kind === "markdown",
      run: () => saveAsTemplate(),
    },
    {
      id: "delete-template",
      title: t("刪除自訂範本…"),
      group: t("檔案"),
      icon: "x",
      when: () => app.settings.value.templates.length > 0,
      run: () => deleteTemplatePicker.open(),
    },
    {
      id: "tab-next",
      title: t("下一個分頁"),
      group: t("分頁"),
      icon: "arrow-right",
      keys: desktop ? "Ctrl-Tab" : "Alt-PageDown",
      when: () => tabOrder().length > 1,
      run: () => app.cycleTab(1),
    },
    {
      id: "tab-prev",
      title: t("上一個分頁"),
      group: t("分頁"),
      icon: "arrow-left",
      keys: desktop ? "Ctrl-Shift-Tab" : "Alt-PageUp",
      when: () => tabOrder().length > 1,
      run: () => app.cycleTab(-1),
    },
    {
      id: "tab-close",
      title: t("關閉分頁"),
      group: t("分頁"),
      icon: "x",
      keys: desktop ? "Mod-w" : "Mod-Alt-w",
      run: () => {
        // 工作項目等的分頁（按右鍵的，或顯示中而且並排時焦點在那一邊）：關掉它。
        const item = app.menuItemTab();
        return item ? closeItem(item.id) : app.closeTab(app.menuTab().id);
      },
    },
    {
      id: "fold-all",
      title: t("摺疊所有章節"),
      group: t("檢視"),
      icon: "chevrons-down-up",
      shownKeys: "Ctrl-Alt-[",
      run: () => void foldAll(app.editor.view),
    },
    {
      id: "unfold-all",
      title: t("展開所有章節"),
      group: t("檢視"),
      icon: "chevrons-up-down",
      shownKeys: "Ctrl-Alt-]",
      run: () => void unfoldAll(app.editor.view),
    },
    {
      id: "tab-close-others",
      title: t("關閉其他分頁"),
      group: t("分頁"),
      icon: "x",
      when: () => tabOrder().some((id) => id !== menuTabId() && !app.tabPinned(id)),
      run() {
        const keep = menuTabId();
        return app.closeTabIds(tabOrder().filter((id) => id !== keep && !app.tabPinned(id)));
      },
    },
    {
      id: "tab-close-all",
      title: t("關閉所有分頁"),
      group: t("分頁"),
      icon: "x",
      // 固定的分頁保留（和「關閉其他分頁」一致）；沒存的分頁會逐一詢問。
      when: () => tabOrder().some((id) => !app.tabPinned(id)),
      run: () => app.closeTabIds(tabOrder().filter((id) => !app.tabPinned(id))),
    },
    {
      id: "tab-close-right",
      title: t("關閉右側的分頁"),
      group: t("分頁"),
      icon: "x",
      when: () => rightOf(menuTabId()).length > 0,
      run: () => app.closeTabIds(rightOf(menuTabId())),
    },
    {
      id: "tab-close-saved",
      title: t("關閉已儲存的分頁"),
      group: t("分頁"),
      icon: "x",
      // 工作項目等沒有要存的，也算已儲存。
      when: () => savedTabs().length > 0,
      run: () => app.closeTabIds(savedTabs()),
    },
    {
      id: "tab-pin",
      title: t("固定／取消固定分頁"),
      group: t("分頁"),
      icon: "pin",
      run() {
        const item = app.menuItemTab();
        if (item) return setItemPinned(item.id, !item.pinned);
        const doc = app.menuTab();
        app.setPinned(doc, !doc.pinned);
      },
    },
    {
      id: "tab-copy-path",
      title: t("複製檔案路徑"),
      group: t("檔案"),
      icon: "copy",
      when: () => !app.menuItemTab() && !!app.tabPath(app.menuTab()),
      async run() {
        await navigator.clipboard.writeText(displayPath(app.tabPath(app.menuTab())!));
        toast(t("已複製路徑"));
      },
    },
    {
      id: "tab-reveal",
      title: t("在檔案總管中顯示"),
      group: t("檔案"),
      icon: "folder-open",
      when: () => !!desktop && !app.menuItemTab() && !!app.tabPath(app.menuTab()),
      run: () => desktop!.revealEntry(app.tabPath(app.menuTab())!),
    },
    {
      id: "open",
      title: t("開啟檔案…"),
      group: t("檔案"),
      icon: "folder-open",
      keys: "Mod-o",
      async run() {
        const file = await openFile(app.fileInput);
        if (file) app.openOpenedFile(file);
      },
    },
    {
      id: "open-folder",
      title: t("開啟資料夾…"),
      group: t("資料夾與專案"),
      icon: "folder-open",
      when: () => !!desktop,
      async run() {
        const folder = await desktop?.openFolder();
        if (!folder) return;
        await app.setWorkspace(folder);
        app.showPanel("files");
      },
    },
    {
      id: "close-folder",
      title: t("關閉專案"),
      group: t("資料夾與專案"),
      icon: "folder-x",
      when: () => !!desktop && !!app.workspaceRoot,
      run: () => app.closeProject(),
    },
    {
      id: "switch-project",
      title: t("切換專案…"),
      group: t("資料夾與專案"),
      icon: "folder-kanban",
      keys: "Mod-Alt-p",
      when: () => !!app.projectUi,
      run: () => app.projectUi!.openSwitcher(),
    },
    {
      id: "project-overview",
      title: t("專案總覽"),
      group: t("資料夾與專案"),
      icon: "layout-grid",
      when: () => !!app.projectUi,
      run: () => app.projectUi!.openOverview(),
    },
    {
      id: "project-settings",
      title: t("目前專案的設定（名稱、顏色、群組）…"),
      group: t("資料夾與專案"),
      icon: "pencil",
      when: () => !!app.projectUi?.current,
      run: () => app.projectUi!.edit(app.projectUi!.current!),
    },
    {
      id: "connect-webdav",
      title: t("連線到遠端資料夾（WebDAV）…"),
      group: t("資料夾與專案"),
      icon: "cloud",
      when: () => app.features.remote,
      async run() {
        const folder = await app.davDialog?.open();
        if (!folder) return;
        await app.setWorkspace(folder);
        app.showPanel("files");
      },
    },
    {
      id: "show-shortcuts",
      title: t("說明：快速鍵一覽"),
      group: t("說明"),
      icon: "command",
      keys: "F1",
      run: () => showShortcuts(),
    },
    {
      id: "show-welcome",
      title: t("說明：開啟歡迎文件"),
      group: t("說明"),
      icon: "book-open-text",
      run: () => openWelcome(),
    },
    {
      id: "show-changelog",
      title: t("說明：更新紀錄"),
      group: t("說明"),
      icon: "scroll-text",
      run: () => openChangelog(),
    },
    {
      id: "report-issue",
      title: t("說明：回報問題或建議…"),
      group: t("說明"),
      icon: "bug",
      run: () => openUrl(`${REPO_URL}/issues/new`),
    },
    {
      id: "about",
      title: t("關於 oMarker"),
      group: t("說明"),
      icon: "info",
      run: () => settingsDialog.open(t("關於")),
    },
    {
      id: "allow-remote-images",
      title: t("載入這份文件的遠端圖片"),
      group: t("檢視"),
      icon: "image",
      when: () => app.blockRemote(),
      run: () => app.allowRemoteImages(),
    },
    {
      id: "connect-ssh",
      title: t("連線到遠端資料夾（SSH）…"),
      group: t("資料夾與專案"),
      icon: "server",
      when: () => app.features.remote,
      async run() {
        const folder = await app.sshDialog?.open();
        if (!folder) return;
        await app.setWorkspace(folder);
        app.showPanel("files");
      },
    },
    {
      id: "quick-open",
      title: t("快速開啟檔案…"),
      group: t("檔案"),
      icon: "search",
      keys: "Mod-p",
      run: () => app.quickOpen.open(),
    },
    {
      id: "open-work-item",
      title: t("開啟工作項目…"),
      group: "Azure DevOps",
      icon: "square-kanban",
      when: () => !!app.ado?.account,
      // 快速開啟裡輸入 #編號 直接開啟，#文字 搜尋標題。
      run: () => app.quickOpen.open("#"),
    },
    {
      id: "search-in-folder",
      title: t("在資料夾中搜尋"),
      group: t("資料夾與專案"),
      icon: "search",
      keys: "Mod-Shift-f",
      when: () => !!desktop,
      run() {
        app.showPanel("search");
        // 選取範圍只有一行時，直接拿來當搜尋關鍵字。
        const { from, to } = app.editor.view.state.selection.main;
        const selected = app.editor.view.state.sliceDoc(from, to);
        searchPanel?.focus(selected && !selected.includes("\n") ? selected : undefined);
      },
    },
    {
      id: "replace-in-folder",
      title: t("在資料夾中取代…"),
      group: t("資料夾與專案"),
      icon: "replace",
      when: () => !!searchPanel && !!app.workspaceRoot && !isRemote(app.workspaceRoot.path),
      run() {
        app.showPanel("search");
        searchPanel?.showReplace();
      },
    },
    { id: "show-files", title: t("顯示檔案"), group: t("檢視"), icon: "folder", keys: "Mod-Shift-e", run: () => app.showPanel("files") },
    { id: "show-outline", title: t("顯示大綱"), group: t("檢視"), icon: "list-tree", run: () => app.showPanel("outline") },
    { id: "show-search", title: t("顯示搜尋"), group: t("檢視"), icon: "search", when: () => !!desktop, run: () => app.showPanel("search") },
    { id: "show-tasks", title: t("顯示待辦總覽"), group: t("檢視"), icon: "list-checks", run: () => app.showPanel("tasks") },
    { id: "show-tags", title: t("顯示標籤"), group: t("檢視"), icon: "tags", run: () => app.showPanel("tags") },
    {
      id: "show-git",
      title: t("顯示原始碼控制（Git）"),
      group: t("Git"),
      icon: "git-branch",
      keys: "Mod-Shift-g",
      when: () => !!gitPanel,
      run: () => app.showPanel("git"),
    },
    { id: "save", title: t("存檔"), group: t("檔案"), icon: "save", keys: "Mod-s", run: () => app.save(false) },
    { id: "save-as", title: t("另存新檔…"), group: t("檔案"), icon: "file", keys: "Mod-Shift-s", run: () => app.save(true) },
    {
      id: "export-html",
      title: t("匯出成 HTML…"),
      group: t("匯入與匯出"),
      icon: "download",
      async run() {
        const html = await app.preview.exportDocument(app.editor.text, app.kind, stem(app.fileName));
        const name = replaceExtension(app.fileName, ".html");
        if ((await download(name, html, "text/html")) && desktop) toast(t("已匯出「{name}」", { name }), { tone: "success" });
      },
    },
    {
      id: "export-pdf",
      title: desktop ? t("匯出成 PDF…") : t("列印／匯出成 PDF…"),
      group: t("匯入與匯出"),
      icon: desktop ? "file-down" : "printer",
      run: () => exportPdf(),
    },
    {
      id: "print",
      title: t("列印…"),
      group: t("匯入與匯出"),
      icon: "printer",
      when: () => !!desktop,
      run: () => exportPdf(true),
    },
    {
      id: "copy-html",
      title: t("複製 HTML"),
      group: t("匯入與匯出"),
      icon: "copy",
      async run() {
        // 複製出去的 HTML 不需要捲動同步用的 data-sourcepos，直接重新渲染一份。
        const result = renderMarkdown(app.editor.text, { kind: app.kind });
        if (result.error) {
          toast(t("文件有格式錯誤，修正後才能複製。"), { tone: "error" });
          return;
        }
        await navigator.clipboard.writeText(result.html);
        toast(t("已複製 HTML 到剪貼簿"), { tone: "success" });
      },
    },
    {
      id: "export-docx",
      title: t("匯出成 Word（.docx）…"),
      group: t("匯入與匯出"),
      icon: "file-type",
      when: () => app.kind === "markdown",
      run: () => exportDocx(),
    },
    {
      id: "slideshow",
      title: t("簡報模式：從頭播放"),
      group: t("檢視"),
      icon: "presentation",
      keys: "F5",
      when: () => app.kind === "markdown",
      run: () => startSlideshow(false),
    },
    {
      id: "slideshow-here",
      title: t("簡報模式：從目前這一頁播放"),
      group: t("檢視"),
      icon: "presentation",
      keys: "Shift-F5",
      when: () => app.kind === "markdown",
      run: () => startSlideshow(true),
    },
    {
      id: "import-docx",
      title: t("匯入 Word 文件（.docx）…"),
      group: t("匯入與匯出"),
      icon: "file-input",
      run: () => importDocx(),
    },
    {
      id: "copy-rich",
      title: t("複製為格式文字（貼到 Word、Outlook、Teams）"),
      group: t("匯入與匯出"),
      icon: "clipboard-copy",
      keys: "Mod-Alt-c",
      when: () => app.kind === "markdown",
      run: () => copyRich(),
    },
    {
      id: "fix-terms",
      title: t("修正兩國用語、錯字與標點（整份文件）"),
      group: t("編輯"),
      icon: "spell-check",
      when: () => app.kind !== "json" && app.view !== "preview",
      run: () => fixTerms(),
    },
    {
      id: "s2t",
      title: t("簡體轉繁體（台灣用語）"),
      group: t("編輯"),
      icon: "languages",
      when: () => app.kind !== "json" && app.view !== "preview",
      run: () => convertToTraditional(),
    },
    {
      id: "clear-term-ignore",
      title: t("兩國用語檢查：清除「不再提示」的詞"),
      group: t("編輯"),
      icon: "spell-check",
      when: () => app.settings.value.termIgnore.length > 0,
      run: () => {
        const n = app.settings.value.termIgnore.length;
        app.settings.update({ termIgnore: [] });
        toast(t("已清除 {n} 個不再提示的詞。", { n }), { tone: "success" });
      },
    },
    { id: "palette", title: t("開啟指令面板"), group: t("說明"), icon: "command", keys: "Mod-Shift-p", run: () => palette.open() },
    {
      id: "rename-doc",
      title: t("重新命名文件…"),
      group: t("檔案"),
      icon: "pencil",
      run: () => app.tabBar.startRename(app.active.id),
    },
    {
      id: "toggle-format-bar",
      title: t("固定顯示／隱藏格式工具列"),
      group: t("檢視"),
      icon: "bold",
      run: () => app.settings.update({ fixedToolbar: !app.settings.value.fixedToolbar }),
    },
    {
      id: "find",
      title: t("搜尋與取代"),
      group: t("編輯"),
      icon: "search",
      keys: "Mod-f",
      when: () => app.view !== "preview",
      // 工作項目開在主要區域時，在它的內容裡找字。
      run: () =>
        issueView.isOpen && (!issueSide || issueView.hasFocus) ? issueView.openFind() : void openSearchPanel(app.editor.view),
    },
    {
      id: "format-json",
      title: t("格式化 JSON"),
      group: t("編輯"),
      icon: "wand-sparkles",
      keys: "Shift-Alt-f",
      when: () => app.kind === "json",
      run() {
        try {
          const formatted = formatJson(app.editor.text);
          if (formatted !== app.editor.text) app.editor.replaceAll(formatted);
          toast(t("已重新排版（可用 Ctrl+Z 復原）"), { tone: "success" });
        } catch (e) {
          const err = app.preview.result?.error;
          toast(t("無法格式化：{error}", { error: e instanceof Error ? e.message : String(e) }), {
            tone: "error",
            action: err ? { label: t("跳到錯誤"), run: () => app.editor.reveal(err.line, err.column) } : undefined,
          });
        }
      },
    },
    fmt("bold", t("粗體"), "bold", () => app.editor.exec(toggleWrap("**")), "Mod-b"),
    fmt("italic", t("斜體"), "italic", () => app.editor.exec(toggleWrap("*")), "Mod-i"),
    fmt("strike", t("刪除線"), "strikethrough", () => app.editor.exec(toggleWrap("~~")), "Mod-Shift-x"),
    fmt("code", t("行內程式碼"), "code", () => app.editor.exec(toggleWrap("`")), "Mod-e"),
    fmt("link", t("插入連結"), "link", () => app.editor.exec(insertLink), "Mod-k", t("插入")),
    fmt("underline", t("底線"), "underline", () => app.editor.exec(toggleWrap("<u>", "</u>")), "Mod-u"),
    fmt("highlight", t("螢光標記"), "highlighter", () => app.editor.exec(toggleWrap("<mark>", "</mark>")), "Mod-Shift-h"),
    fmt("superscript", t("上標（例如 m²）"), "superscript", () => app.editor.exec(toggleWrap("<sup>", "</sup>"))),
    fmt("subscript", t("下標（例如 H₂O）"), "subscript", () => app.editor.exec(toggleWrap("<sub>", "</sub>"))),
    fmt(
      "clear-format",
      t("清除格式"),
      "remove-formatting",
      () => {
        const ok = clearInlineFormat({ state: app.editor.view.state, dispatch: (tr) => app.editor.view.dispatch(tr) });
        if (!ok) toast(t("請先選取要清除格式的文字。"));
        app.editor.view.focus();
      },
      "Mod-\\",
    ),
    fmt("h1", t("標題 1"), "heading-1", () => app.editor.exec(toggleLineStyle("h1")), "Mod-Alt-1"),
    fmt("h2", t("標題 2"), "heading-2", () => app.editor.exec(toggleLineStyle("h2")), "Mod-Alt-2"),
    fmt("h3", t("標題 3"), "heading-3", () => app.editor.exec(toggleLineStyle("h3")), "Mod-Alt-3"),
    fmt("quote", t("引言"), "quote", () => app.editor.exec(toggleLineStyle("quote"))),
    fmt("bullet", t("項目清單"), "list", () => app.editor.exec(toggleLineStyle("bullet")), "Mod-Shift-8"),
    fmt("ordered", t("編號清單"), "list-ordered", () => app.editor.exec(toggleLineStyle("ordered")), "Mod-Shift-7"),
    fmt("task", t("待辦清單"), "list-checks", () => app.editor.exec(toggleLineStyle("task")), "Mod-Shift-9"),
    fmt("code-block", t("程式碼區塊"), "square-code", () => insertPlaceholder(t("```\n程式碼\n```"), 1)),
    // 插入後選取第一個欄位名稱，直接打字就能取代。
    fmt("table", t("插入表格"), "table", () => app.editor.exec(insertBlock(TABLE_TEMPLATE, TABLE_TEMPLATE.split("|")[1].trim())), undefined, t("插入")),
    fmt("hr", t("分隔線"), "minus", () => app.editor.exec(insertBlock("---")), undefined, t("插入")),
    fmt("insert-toc", t("插入或更新目錄"), "toc", () => insertToc(), undefined, t("插入")),
    fmt("math-block", t("數學公式區塊"), "sigma", () => insertPlaceholder(t("$$\n公式\n$$"), 1), undefined, t("插入")),
    fmt("mermaid-block", t("流程圖"), "workflow", () =>
      insertPlaceholder(t("```mermaid\nflowchart LR\n  A[開始] --> B[結束]\n```"), 2),
      undefined,
      t("插入"),
    ),
    fmt("insert-image", t("圖片…"), "image", () => imageInput.click(), undefined, t("插入")),
    fmt("insert-menu", t("插入…"), "plus", () => {
      const pos = app.editor.view.state.selection.main.head;
      const at = app.editor.view.coordsAtPos(pos);
      if (at) openInsertMenu(new DOMRect(at.left, at.top, 0, at.bottom - at.top));
    }, "Mod-Shift-Enter", t("插入")),
    fmt("table-format", t("表格：對齊目前的表格"), "table", () => runTableEdit("format")),
    fmt("table-insert-row", t("表格：在下方插入一列"), "table", () => runTableEdit("insert-row")),
    fmt("table-insert-column", t("表格：在右側插入一欄"), "table", () => runTableEdit("insert-column")),
    fmt("table-delete-row", t("表格：刪除目前這一列"), "table", () => runTableEdit("delete-row")),
    fmt("table-delete-column", t("表格：刪除目前這一欄"), "table", () => runTableEdit("delete-column")),
    {
      id: "format-tables",
      title: t("對齊文件中所有表格"),
      group: t("編輯"),
      icon: "wand-sparkles",
      keys: "Shift-Alt-f",
      when: () => app.kind === "markdown",
      run() {
        const formatted = formatAllTables(app.editor.text);
        if (formatted === app.editor.text) {
          toast(t("所有表格都已經對齊。"));
          return;
        }
        app.editor.replaceAll(formatted);
        toast(t("已對齊所有表格（可用 Ctrl+Z 復原）"), { tone: "success" });
      },
    },
    {
      id: "tidy-spacing",
      title: t("整理文件：在中文與英文、數字之間加空格"),
      group: t("編輯"),
      icon: "wand-sparkles",
      when: () => app.kind !== "json" && app.view !== "preview",
      run() {
        const text = app.editor.text;
        const positions = spacingPositions(text, app.kind);
        if (!positions.length) {
          toast(t("沒有需要加空格的地方。"));
          return;
        }
        // 原本對齊的表格補完空格後重新對齊；整個過程是一次可復原的編輯。
        const realign = app.kind === "markdown" && formatAllTables(text) === text;
        let spaced = "";
        let last = 0;
        for (const p of positions) {
          spaced += `${text.slice(last, p)} `;
          last = p;
        }
        spaced += text.slice(last);
        const result = realign ? formatAllTables(spaced) : spaced;
        if (result === spaced) {
          app.editor.view.dispatch({
            changes: [...positions].map((from) => ({ from, insert: " " })),
            userEvent: "input.format",
          });
        } else {
          app.editor.replaceAll(result);
        }
        toast(t("已補上 {n} 個空格（可用 Ctrl+Z 復原）", { n: positions.length }), { tone: "success" });
      },
    },
    {
      id: "settings",
      title: t("設定"),
      group: t("說明"),
      icon: "settings",
      keys: "Mod-,",
      run: () => settingsDialog.open(),
    },
    ...(["editor", "live", "split", "preview"] as const).map(
      (mode): Command => ({
        id: `view-${mode}`,
        title: {
          editor: t("只顯示原始碼"),
          live: t("即時預覽（在編輯區直接顯示排版）"),
          split: t("原始碼與預覽並排"),
          preview: t("只顯示預覽"),
        }[mode],
        group: t("檢視"),
        icon: { editor: "code", live: "book-open-text", split: "columns-2", preview: "eye" }[mode],
        when: () => mode !== "split" || !app.narrowQuery.matches,
        run: () => app.setView(mode),
      }),
    ),
    {
      id: "toggle-focus-mode",
      title: t("專注模式（淡化其他段落）"),
      group: t("檢視"),
      icon: "focus",
      when: () => app.view !== "preview",
      run: () => toggleSetting("focusMode", t("專注模式")),
    },
    {
      id: "toggle-typewriter-mode",
      title: t("打字機模式（游標保持在畫面中央）"),
      group: t("檢視"),
      icon: "text-cursor",
      when: () => app.view !== "preview",
      run: () => toggleSetting("typewriterMode", t("打字機模式")),
    },
    {
      id: "font-bigger",
      title: t("放大編輯區文字"),
      group: t("檢視"),
      icon: "a-arrow-up",
      keys: "Mod-Equal",
      run: () => changeFontSize(1),
    },
    {
      id: "font-smaller",
      title: t("縮小編輯區文字"),
      group: t("檢視"),
      icon: "a-arrow-down",
      keys: "Mod-Minus",
      run: () => changeFontSize(-1),
    },
    {
      id: "font-reset",
      title: t("編輯區文字恢復預設大小"),
      group: t("檢視"),
      icon: "text-cursor",
      keys: "Mod-0",
      run: () => app.settings.update({ editorFontSize: DEFAULT_SETTINGS.editorFontSize }),
    },
    {
      id: "toggle-outline",
      title: t("顯示／隱藏側邊欄"),
      group: t("檢視"),
      icon: "panel-left",
      keys: "Mod-Shift-o",
      run: () => app.setOutline(!app.outlineShown),
    },
    {
      id: "toggle-outline-right",
      title: t("顯示／隱藏右邊的大綱"),
      group: t("檢視"),
      icon: "panel-right",
      keys: "Mod-Alt-b",
      when: () => app.outlinePlacedRight(),
      run: () => app.setRightOutline(!app.rightOutlineShown),
    },
    ...(["system", "light", "dark"] as const).map(
      (pref): Command => ({
        id: `theme-${pref}`,
        title: { system: t("主題：跟隨系統"), light: t("主題：淺色"), dark: t("主題：深色") }[pref],
        group: t("檢視"),
        icon: { system: "monitor", light: "sun", dark: "moon" }[pref],
        run: () => app.setTheme(pref),
      }),
    ),
    ...(Object.keys(KINDS) as DocKind[]).map(
      (k): Command => ({
        id: `kind-${k}`,
        title: t("文件類型改為 {kind}", { kind: KINDS[k].label }),
        group: t("檢視"),
        icon: "file-type",
        when: () => app.kind !== k,
        run: () => app.setKind(k),
      }),
    ),
  );
}
