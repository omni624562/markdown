/**
 * 大綱：拖曳重排章節（E10）、目前的標題、字數與存檔狀態。
 */
import type { RenderResult } from "../../pkg/md_wasm.js";
import { desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { subtreeEnd, moveSection, sectionRange, swapSection } from "../sections.ts";
import { app } from "./context.ts";


let draggingSection: number | null = null;

/** 搬移章節（一次可復原的編輯），再把大綱焦點放回被搬移的標題。 */
function applySectionMove(text: string | null, movedIndex: number, focusLink: boolean): void {
  if (text === null) return;
  if (app.review.active) app.review.finish();
  app.editor.replaceAll(text, { userEvent: "move.section", isolate: true });
  app.renderNow();
  const link = app.outlineList.querySelectorAll<HTMLAnchorElement>("a")[movedIndex];
  if (!link) return;
  if (app.view !== "preview") app.editor.reveal(Number(link.dataset.line));
  if (focusLink) link.focus();
}

function clearDropMarks(): void {
  for (const el of app.outlineList.querySelectorAll(".drop-before, .drop-after, .dragging")) {
    el.classList.remove("drop-before", "drop-after", "dragging");
  }
}

/** 放開的位置：滑鼠在標題上半部是「搬到這個標題前面」，下半部是「搬到下一個標題前面」。 */
function dropTarget(e: DragEvent): { li: HTMLElement; before: number; after: boolean } | null {
  const link = (e.target as HTMLElement).closest?.<HTMLAnchorElement>("a[data-index]");
  if (!link) return null;
  const li = link.parentElement!;
  const rect = link.getBoundingClientRect();
  const after = e.clientY > rect.top + rect.height / 2;
  const index = Number(link.dataset.index);
  // 收合的標題底下的子標題看不到，放在它下面就是放在整個章節後面。
  const collapsed = li.querySelector(".outline-toggle[aria-expanded='false']");
  const next = collapsed ? subtreeEnd(app.outlineHeadings.map((h) => h.level), index) : index + 1;
  return { li, before: after ? next : index, after };
}

/** Wiki、工作項目內容裡的標題（和本機預覽的標題 id 可能一樣，所以只在內容裡找）。 */
function viewHeading(id: string): HTMLElement | null {
  return app.outlineView?.body?.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ?? null;
}

/** 大綱標示目前閱讀到的段落。 */
export function updateActiveHeading(): void {
  const links = [...app.outlineList.querySelectorAll<HTMLAnchorElement>("a")];
  if (!links.length) return;
  let active: HTMLAnchorElement | undefined;
  if (app.outlineView) {
    const top = (app.outlineView.body?.parentElement?.getBoundingClientRect().top ?? 0) + 48;
    for (const a of links) {
      const el = viewHeading(a.dataset.id!);
      if (el && el.getBoundingClientRect().top <= top) active = a;
    }
  } else if (app.view === "preview") {
    const top = app.previewScroller.getBoundingClientRect().top + 48;
    for (const a of links) {
      const el = document.getElementById(a.dataset.id!);
      if (el && el.getBoundingClientRect().top <= top) active = a;
    }
  } else {
    for (const a of links) if (Number(a.dataset.line) <= app.editorTopLine + 1) active = a;
  }
  active ??= links[0];
  // 目前的段落在收合的標題底下時，標示那個收合的標題。
  for (let i = links.indexOf(active); i > 0 && active.parentElement!.hidden; i--) active = links[i - 1];
  for (const a of links) {
    if (a === active) {
      if (a.getAttribute("aria-current") !== "location") {
        a.setAttribute("aria-current", "location");
        a.scrollIntoView({ block: "nearest" });
      }
    } else {
      a.removeAttribute("aria-current");
    }
  }
}

export function renderStats({ stats }: RenderResult): void {
  if (app.kind === "json") {
    app.status.stats.textContent = t("{lines} 行 · {chars} 字元", {
      lines: app.editor.view.state.doc.lines.toLocaleString(),
      chars: app.editor.text.length.toLocaleString(),
    });
    app.status.stats.title = "";
    return;
  }
  app.status.stats.textContent = t("{n} 字", { n: stats.words.toLocaleString() });
  app.status.stats.title =
    t("{words} 字 · {chars} 字元", { words: stats.words.toLocaleString(), chars: stats.chars.toLocaleString() }) +
    (stats.readingMinutes ? t(" · 約 {n} 分鐘讀完", { n: stats.readingMinutes }) : "");
}

/** 雜湊（`hash()`）開頭記著內容的長度：長度不同就一定改過，不必算整份文件的雜湊。 */
function sameLength(h: string | null, length: number): boolean {
  if (h === null) return true;
  const i = h.indexOf(":");
  return i < 0 || h.slice(0, i) === String(length);
}

export function renderSaveState(): void {
  const dirty = !sameLength(app.baseline, app.editor.view.state.doc.length) || app.baseline !== app.editorHash();
  if (app.active.dirty !== dirty) {
    app.active.dirty = dirty;
    app.renderTabs();
  }
  // 只有一份還沒存過的空白文件時，不需要「未命名.md」分頁與標題；開始打字才出現。
  const blank = app.docs.length === 1 && !app.fileBacked && !app.fileHandle && app.editor.view.state.doc.length === 0;
  app.$("#tab-bar").classList.toggle("blank", blank);
  app.editor.setFileName(app.fileName);
  const title = blank ? "oMarker" : `${dirty ? "● " : ""}${app.fileName} - oMarker`;
  if (document.title !== title) {
    document.title = title;
    desktop?.setTitle(title).catch(console.error);
  }
  app.status.save.dataset.state = dirty ? "dirty" : "saved";
  if (!dirty) app.status.save.textContent = app.fileBacked ? t("已儲存") : "";
  else
    app.status.save.textContent =
      (app.active.wiki ? t("尚未存回 Wiki") : app.fileBacked ? t("尚未存檔") : t("尚未存成檔案")) + (app.draftSaved ? t(" · 草稿已自動保存") : "");
  // 已儲存時不佔位置；只有需要注意時才顯示。
  app.status.save.hidden = !dirty;
  app.status.save.title = dirty ? t("按一下存檔（Ctrl+S）") : "";
  (app.status.save as HTMLButtonElement).disabled = !dirty;
}

export function initOutline(): void {
  // 點大綱的標題：跳到那一段。整個清單共用一個處理（大文件可能有上千個標題）。
  app.outlineList.addEventListener("click", (e) => {
    const toggle = (e.target as Element).closest<HTMLButtonElement>(".outline-toggle");
    if (toggle) {
      app.toggleOutline(Number(toggle.dataset.index));
      return;
    }
    const a = (e.target as Element).closest<HTMLAnchorElement>("a[data-index]");
    const h = a && app.outlineHeadings[Number(a.dataset.index)];
    if (!h) return;
    e.preventDefault();
    if (app.outlineView) {
      const el = viewHeading(h.id);
      // 標題在收合的卡片裡（例如工作項目的留言）：先展開。
      for (let p = el?.parentElement; p && p !== app.outlineView.body; p = p.parentElement) {
        if (p instanceof HTMLDetailsElement && !p.open) p.open = true;
      }
      el?.scrollIntoView({ block: "start" });
      if (app.narrowQuery.matches) app.setOutline(false);
      return;
    }
    if (app.view !== "preview") app.editor.reveal(h.line);
    if (app.previewVisible()) document.getElementById(h.id)?.scrollIntoView({ block: "start" });
    if (app.narrowQuery.matches) app.setOutline(false);
  });
  app.outlineList.addEventListener("dragstart", (e) => {
    const link = (e.target as HTMLElement).closest?.<HTMLAnchorElement>("a[data-index]");
    if (!link || app.kind !== "markdown" || app.outlineView) return;
    draggingSection = Number(link.dataset.index);
    link.parentElement!.classList.add("dragging");
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", link.textContent ?? "");
  });
  app.outlineList.addEventListener("dragover", (e) => {
    if (draggingSection === null) return;
    const t = dropTarget(e);
    if (!t) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    for (const el of app.outlineList.querySelectorAll(".drop-before, .drop-after")) el.classList.remove("drop-before", "drop-after");
    t.li.classList.add(t.after ? "drop-after" : "drop-before");
  });
  app.outlineList.addEventListener("dragleave", (e) => {
    if (!app.outlineList.contains(e.relatedTarget as Node)) {
      for (const el of app.outlineList.querySelectorAll(".drop-before, .drop-after")) el.classList.remove("drop-before", "drop-after");
    }
  });
  app.outlineList.addEventListener("drop", (e) => {
    const from = draggingSection;
    const t = dropTarget(e);
    clearDropMarks();
    draggingSection = null;
    if (from === null || !t) return;
    e.preventDefault();
    const out = moveSection(app.editor.text, app.outlineHeadings, from, t.before);
    if (out === null) return;
    // 搬移後，被搬移的標題在大綱中的新位置。
    const count = sectionRange(app.outlineHeadings, from, app.editor.view.state.doc.lines);
    const size = app.outlineHeadings.filter((h) => h.line >= count.first && h.line < count.end).length;
    applySectionMove(out, t.before > from ? t.before - size : t.before, false);
  });
  app.outlineList.addEventListener("dragend", () => {
    clearDropMarks();
    draggingSection = null;
  });
  app.outlineList.addEventListener("keydown", (e) => {
    // ←／→：收合、展開（已收合或沒有子標題時，← 跳到上一層標題）。
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const link = (e.target as HTMLElement).closest?.<HTMLAnchorElement>("a[data-index]");
      if (!link) return;
      e.preventDefault();
      const index = Number(link.dataset.index);
      if (app.toggleOutline(index, e.key === "ArrowLeft") || e.key === "ArrowRight") return;
      const level = app.outlineHeadings[index].level;
      for (let i = index - 1; i >= 0; i--) {
        if (app.outlineHeadings[i].level < level) {
          app.outlineList.querySelectorAll<HTMLElement>("a")[i]?.focus();
          break;
        }
      }
      return;
    }
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const link = (e.target as HTMLElement).closest?.<HTMLAnchorElement>("a[data-index]");
    if (!link || app.kind !== "markdown" || app.outlineView) return;
    e.preventDefault();
    const moved = swapSection(app.editor.text, app.outlineHeadings, Number(link.dataset.index), e.key === "ArrowUp" ? -1 : 1);
    if (moved) applySectionMove(moved.text, moved.index, true);
  });
}
