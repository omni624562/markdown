/**
 * 並排編輯：在右邊再開一個編輯器顯示另一份文件、關閉並排、兩邊上方的文件名稱。
 * 游標在哪一邊、換邊（`focusPane`）與兩個編輯器還在 main.ts（它們就是「目前的文件」）；
 * 這裡透過 `app` 取用。
 */
import { desktop, isRemote } from "../desktop.ts";
import { t } from "../i18n.ts";
import type { Doc, Pane } from "../main.ts";
import { loadDraft } from "../session.ts";
import { icon } from "../ui/icons.ts";
import { toast } from "../ui/toast.ts";
import { app } from "./context.ts";
import { reloadDoc } from "./desktop-startup.ts";
import { docName, docTooltip } from "./doc-names.ts";
import { hideItem } from "./item-tabs.ts";

/** 在右邊並排開啟（已經在右邊就換過去；目前的文件要移到右邊時，左邊換成旁邊的分頁）。 */
export function openBeside(doc: Doc): void {
  if (app.narrowQuery.matches) {
    toast(t("視窗太窄，放不下並排的兩份文件。"));
    return;
  }
  if (app.paneDocs.side === doc) {
    app.focusPane("side", true);
    return;
  }
  if (doc === app.paneDocs.main) {
    if (app.paneDocs.side) {
      toast(t("「{name}」已經在左邊了。", { name: docName(doc) }));
      return;
    }
    const i = app.docs.indexOf(doc);
    const neighbour = app.docs[i - 1] ?? app.docs[i + 1];
    if (!neighbour) {
      toast(t("要並排編輯，請先再開一份文件。"));
      return;
    }
    app.activate(neighbour);
  }
  // 預覽要讓出位置：分割、只看預覽時改成即時預覽。工作項目等並排在右邊時收起來。
  if (app.view === "split" || app.view === "preview") app.setView("live");
  hideItem();
  if (app.focusedPane === "side") app.focusPane("main");
  const ed = app.ensureSideEditor();
  app.setSideDoc(doc);
  if (doc.state) ed.restore(doc.state, doc.kind, doc.scrollTop);
  else ed.load(loadDraft(doc.id) ?? "", doc.kind);
  ed.setFileName(doc.name);
  doc.state = ed.state;
  // 草稿被清掉的分頁：從檔案讀回內容（讀到後在 refreshOtherPane 換上）。
  const path = app.docPath(doc);
  if (doc.unloaded && path && desktop && !loadDraft(doc.id)) {
    void reloadDoc(doc, path)
      .then(() => app.renderTabs())
      .catch(() => {
        if (!isRemote(path)) doc.missing = true;
        app.renderTabs();
      });
  }
  app.applyLayout();
  app.focusPane("side", true);
  app.renderTabs();
}

/** 關閉並排：右邊的文件留在分頁裡，游標回到左邊。 */
export function closeSide(): void {
  if (!app.paneDocs.side) return;
  if (app.focusedPane === "side") app.focusPane("main");
  app.setSideDoc(null);
  app.applyLayout();
  app.renderTabs();
  renderPaneHeads();
  // 焦點在藏起來的右邊編輯器或按掉的按鈕上：放回左邊的編輯器，不要掉到 body。
  const at = document.activeElement as HTMLElement | null;
  if (!at || at === document.body || !at.checkVisibility()) app.editor.view.focus();
}

/**
 * 另一邊（游標不在的那一邊）的文件被別的地方換掉內容時（例如外部修改後重新讀取），重新顯示；
 * 那份文件已經關掉（例如切換專案）時關閉並排。
 */
export function refreshOtherPane(): void {
  const pane = app.otherPane();
  if (!pane) return;
  const doc = app.paneDocs[pane]!;
  if (!app.docs.includes(doc) || !app.docs.includes(app.active)) {
    closeSide();
    return;
  }
  const ed = app.paneEditor(pane)!;
  if (doc.state?.doc === ed.state.doc) return;
  if (doc.state) ed.restore(doc.state, doc.kind, ed.view.scrollDOM.scrollTop);
  else ed.load(loadDraft(doc.id) ?? "", doc.kind);
  doc.state = ed.state;
}

/** 兩邊上方的文件名稱：游標所在的那一邊標出來；右邊有「關閉並排」。 */
export function renderPaneHeads(): void {
  const on = !!app.paneDocs.side;
  const mainPaneHead = app.$("#main-pane-head");
  const sidePaneHead = app.$("#side-pane-head");
  mainPaneHead.hidden = !on;
  if (!on) return;
  const head = (el: HTMLElement, pane: Pane) => {
    const doc = app.paneDocs[pane]!;
    const focused = pane === app.focusedPane;
    const label = Object.assign(document.createElement("span"), { className: "pane-head-name", textContent: docName(doc) });
    label.title = (focused ? app.cur.fileHandle?.path : doc.path) ?? docTooltip(doc);
    const parts: Node[] = [icon(doc.wiki ? "book-open-text" : "file-text"), label];
    if (doc.dirty) {
      const dot = document.createElement("span");
      dot.className = "pane-head-dirty";
      dot.title = t("尚未存檔");
      parts.push(dot);
    }
    parts.push(Object.assign(document.createElement("span"), { className: "pane-head-spacer" }));
    if (pane === "side") {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "btn icon-only";
      close.title = t("關閉並排（文件留在分頁裡）");
      close.setAttribute("aria-label", close.title);
      close.append(icon("x"));
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        closeSide();
      });
      parts.push(close);
    }
    el.replaceChildren(...parts);
    el.classList.toggle("focused", focused);
  };
  head(mainPaneHead, "main");
  head(sidePaneHead, "side");
}

/** 點兩邊上方的文件名稱就換到那一邊。 */
export function initSideBySide(): void {
  for (const [el, pane] of [
    [app.$("#main-pane-head"), "main"],
    [app.$("#side-pane-head"), "side"],
  ] as const) {
    el.addEventListener("mousedown", (e) => {
      if ((e.target as Element).closest("button")) return;
      e.preventDefault();
      app.focusPane(pane, true);
    });
  }
}
