/**
 * COMET 專案裡由 COMET 管理的檔案（哪些檔案見 comet-paths.ts），避免在 oMarker 裡不小心動到：
 *
 * - 檔案面板：COMET 的項目（`.comet.json`、`.comet`、`AGENTS.md`、`docs/spec`、`docs/spec/templates`）名稱後面標一個「C」。
 * - 編輯器：`.comet.json`、`.comet/` 裡的設定檔與 COMET 產生的 `AGENTS.md` 預設唯讀，上方說明為什麼，
 *   想改時說明閃一下；按「仍要編輯」才能改（只有這個分頁，關掉再開會再鎖上）。`docs/spec/templates/` 的規格範本也一樣；
 *   `docs/spec/` 的其他規格照常編輯。
 *   只顯示預覽時編輯器藏起來，預覽上方也放同一段說明。
 *   唯讀只擋在 oMarker 裡打字、貼上、刪除這些手動編輯，不改檔案的屬性：comet 指令、Git、AI 直接改檔案都照常，
 *   檔案被改了也照常重新載入；AI 透過 oMarker 提出的修改（逐段接受）也不擋。
 * - 刪除、改名：確認對話框說明會動到 COMET 的哪些檔案。
 *
 * 只在 COMET 專案（資料夾裡有 `.comet.json`）的本機資料夾裡生效。
 */
import { EditorState, StateEffect, StateField, type Transaction } from "@codemirror/state";
import { EditorView, type Panel, type ViewUpdate, ViewPlugin, showPanel } from "@codemirror/view";
import { type CometKind, cometAffected, cometItemKind, cometKind, relativePath } from "../comet-paths.ts";
import type { Entry } from "../desktop.ts";
import { t } from "../i18n.ts";
import { icon } from "../ui/icons.ts";
import { app } from "./context.ts";

/** 目前開著的專案是 COMET 專案時，`path` 相對於專案資料夾的路徑；不是時回傳 null。 */
function projectRel(path: string | null | undefined): string | null {
  const root = app?.workspaceRoot?.path;
  if (!path || !root || !app.projectUi?.current?.comet) return null;
  return relativePath(root, path);
}

/** 檔案或資料夾是 COMET 的哪一種（不在 COMET 專案裡、或不是 COMET 的檔案時回傳 null）。 */
export function cometKindOf(path: string | null | undefined): CometKind | null {
  const rel = projectRel(path);
  return rel ? cometKind(rel) : null;
}

// ---- 檔案面板的「C」 ------------------------------------------------------------

const MARK_TITLE: Record<CometKind, () => string> = {
  config: () => t("COMET 的設定檔：由 comet 指令維護，在 oMarker 開啟時預設唯讀"),
  generated: () => t("COMET 產生的檔案：不建議手動修改，在 oMarker 開啟時預設唯讀"),
  template: () => t("COMET 的規格範本：AI 照著它寫規格，在 oMarker 開啟時預設唯讀"),
  spec: () => t("COMET 的規格文件：你和 AI 都可以編輯"),
};

/** 檔案面板在 COMET 的項目名稱後面標的「C」（見 FileTreeHandlers.mark）。 */
export function cometTreeMark(entry: Entry): { text: string; title: string } | null {
  const rel = projectRel(entry.path);
  const kind = rel ? cometItemKind(rel) : null;
  return kind ? { text: "C", title: MARK_TITLE[kind]() } : null;
}

// ---- 刪除、改名前的說明 ----------------------------------------------------------

/** 刪除或改名 `path` 會動到 COMET 的檔案時，回傳確認對話框裡要加的說明；不會時回傳 null。 */
export function cometChangeWarning(path: string, action: "trash" | "rename"): string | null {
  const rel = projectRel(path);
  const items = rel ? cometAffected(rel) : [];
  if (!items.length) return null;
  const names = items.map((i) => t("「{name}」", { name: i })).join(t("、"));
  return action === "trash"
    ? t("{names}是 COMET 用到的檔案，刪除後 COMET 可能無法正常運作。", { names })
    : t("{names}是 COMET 用到的檔案，改名後 COMET 可能找不到它，無法正常運作。", { names });
}

// ---- 編輯器：唯讀與上方的說明 ----------------------------------------------------

interface Guard {
  /** 這個狀態對應的檔案路徑（還沒對過時是 undefined）。 */
  path: string | null | undefined;
  kind: CometKind | null;
  locked: boolean;
}

const retarget = StateEffect.define<string | null>();
const setLocked = StateEffect.define<boolean>();

/** 預設唯讀、上方有說明的種類：設定檔、COMET 產生的 AGENTS.md、規格範本都不建議手動修改。 */
const guarded = (kind: CometKind | null) => kind === "config" || kind === "generated" || kind === "template";

function guardFor(path: string | null): Guard {
  const kind = cometKindOf(path);
  return { path, kind, locked: guarded(kind) };
}

/** 擋下來的手動編輯：打字、貼上、刪除、排版、搬移、復原。外部修改重新載入（input.reload）與逐段接受（input.review）不擋。 */
function manualEdit(tr: Transaction): boolean {
  if (tr.isUserEvent("input.review") || tr.isUserEvent("input.reload")) return false;
  return ["input", "delete", "move", "undo", "redo"].some((e) => tr.isUserEvent(e));
}

const guardField: StateField<Guard> = StateField.define<Guard>({
  create: () => ({ path: undefined, kind: null, locked: false }),
  update(g, tr) {
    for (const e of tr.effects) {
      if (e.is(retarget)) g = guardFor(e.value);
      else if (e.is(setLocked)) g = { ...g, locked: e.value };
    }
    return g;
  },
  provide: (f) => [
    EditorState.readOnly.from(f, (g) => g.locked),
    showPanel.from(f, (g) => (guarded(g.kind) ? notePanel : null)),
  ],
});

/** 這個編輯器顯示的文件的路徑（並排時兩邊各自的文件）。 */
function viewPath(view: EditorView): string | null {
  if (!app) return null;
  if (view === app.editor.view) return app.docPath(app.active);
  const { main, side } = app.paneDocs;
  const other = main === app.active ? side : main;
  return other ? app.docPath(other) : null;
}

/** 對照編輯器目前的文件，路徑或種類變了就更新（換了文件、改了名、專案剛設定成 COMET 專案）。 */
function sync(view: EditorView): void {
  const g = view.state.field(guardField, false);
  // 等的期間編輯器已經拿掉了（例如關掉並排）。
  if (!g || !view.dom.isConnected) return;
  const path = viewPath(view);
  if (g.path === path && g.kind === cometKindOf(path)) return;
  view.dispatch({ effects: retarget.of(path) });
}

const syncPlugin = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      // 建立狀態時還不知道是哪一份文件：等這次更新結束後（使用者還來不及輸入）再對照。
      queueMicrotask(() => {
        sync(view);
        showPreviewNote(view);
      });
    }
    update(u: ViewUpdate) {
      if (u.state.field(guardField).path !== viewPath(u.view)) queueMicrotask(() => sync(u.view));
      if (u.state.field(guardField) !== u.startState.field(guardField)) showPreviewNote(u.view);
    }
  },
);

/** 專案剛設定成 COMET 專案、改了檔名之後：重新對照每個編輯器。 */
export function refreshCometGuards(): void {
  for (const ed of app?.editors ?? []) sync(ed.view);
}

/** 把說明的內容畫進 `dom`（編輯器上方與預覽上方共用）。 */
function fillNote(dom: HTMLElement, g: Guard, unlock: () => void, relock: () => void): void {
  const button = (label: string, run: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn";
    b.textContent = label;
    b.addEventListener("click", run);
    return b;
  };
  dom.dataset.kind = g.kind ?? "";
  dom.dataset.locked = g.locked ? "1" : "";
  const text = document.createElement("span");
  const action = g.locked ? button(t("仍要編輯"), unlock) : button(t("鎖上"), relock);
  if (g.kind === "generated") {
    text.textContent = g.locked
      ? t("這是 COMET 產生的檔案，AI 會照著裡面的規則工作，不建議手動修改；重新設定 COMET 時也可能被覆蓋。所以在 oMarker 裡預設唯讀。")
      : t("可以編輯這個 COMET 產生的檔案了。修改前請先提交到 Git 或留個備份；重新設定 COMET 時可能被覆蓋，關掉分頁後再開會再鎖上。");
  } else if (g.kind === "template") {
    text.textContent = g.locked
      ? t("這是 COMET 的規格範本，AI 會照著它寫規格文件，不建議手動修改；改壞或改名，之後的規格可能跟著走樣或找不到範本。所以在 oMarker 裡預設唯讀。")
      : t("可以編輯這個 COMET 規格範本了。修改前請先提交到 Git 或留個備份；關掉分頁後再開會再鎖上。");
  } else if (g.locked) {
    text.textContent = t("這是 COMET 的設定檔，由 comet 指令維護。手動修改可能讓 COMET 無法正常運作，所以在 oMarker 裡預設唯讀。");
  } else {
    text.textContent = t("可以編輯這個 COMET 設定檔了。改錯可能讓 COMET 無法正常運作；關掉分頁後再開會再鎖上。");
  }
  dom.replaceChildren(icon(g.locked ? "lock" : "info"), text, action);
}

function noteDom(): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "comet-note";
  dom.setAttribute("role", "note");
  return dom;
}

function notePanel(view: EditorView): Panel {
  const dom = noteDom();
  const render = (g: Guard) =>
    fillNote(
      dom,
      g,
      () => {
        view.dispatch({ effects: setLocked.of(false) });
        view.focus();
      },
      () => view.dispatch({ effects: setLocked.of(true) }),
    );
  render(view.state.field(guardField));
  return {
    dom,
    top: true,
    update(u) {
      const g = u.state.field(guardField);
      if (g !== u.startState.field(guardField)) render(g);
    },
  };
}

// ---- 只顯示預覽時：預覽上方也放同一段說明 ------------------------------------------

let previewNote: HTMLElement | null = null;

/**
 * 只顯示預覽時編輯器整個藏起來，上方的說明也看不到：在預覽上方放一份一樣的說明（CSS 只在只顯示預覽時顯示）。
 * 「仍要編輯」解除唯讀並切到可以編輯的檢視。
 */
function showPreviewNote(view: EditorView): void {
  if (!app?.editor || view !== app.editor.view || !view.dom.isConnected) return;
  const g = view.state.field(guardField, false);
  const shown = !!g && guarded(g.kind);
  if (!shown && !previewNote) return;
  if (!previewNote) {
    previewNote = noteDom();
    previewNote.classList.add("preview-comet-note");
    document.querySelector("#preview")?.before(previewNote);
  }
  previewNote.hidden = !shown;
  if (!g || !shown) return;
  fillNote(
    previewNote,
    g,
    () => {
      view.dispatch({ effects: setLocked.of(false) });
      app.setView(app.cur.kind === "markdown" ? "live" : "editor");
      view.focus();
    },
    () => view.dispatch({ effects: setLocked.of(true) }),
  );
}

/** 唯讀時想打字：上方的說明閃一下，告訴使用者為什麼不能改。 */
function nudge(view: EditorView): boolean {
  if (!view.state.field(guardField).locked) return false;
  const note = view.dom.querySelector<HTMLElement>(".comet-note");
  if (note) {
    note.classList.remove("comet-note-nudge");
    void note.offsetWidth;
    note.classList.add("comet-note-nudge");
  }
  return false;
}

/** 編輯器的擴充（main.ts 的 editorOptions）：COMET 設定檔唯讀、上方的說明。 */
export function cometFileGuard() {
  return [
    guardField,
    syncPlugin,
    // 自訂的編輯指令（表格、格式、智慧貼上等）不一定會先看唯讀：手動編輯一律擋下。
    EditorState.transactionFilter.of((tr) => (tr.docChanged && tr.startState.field(guardField).locked && manualEdit(tr) ? [] : tr)),
    EditorView.domEventHandlers({ beforeinput: (_e, view) => nudge(view) }),
  ];
}
