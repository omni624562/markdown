/**
 * 自動存檔（桌面版、已經存過的檔案）：停手 1.5 秒後安靜地存，遇到衝突或錯誤就暫停、交給使用者（Ctrl+S）。
 * 從 main.ts 拆出來，透過 `app` 取用目前的分頁、編輯器與設定。
 */
import { desktop } from "../desktop.ts";
import { saveFile } from "../files.ts";
import { t } from "../i18n.ts";
import { loadDraft } from "../session.ts";
import { toast } from "../ui/toast.ts";
import { refreshToc } from "./activity-bar.ts";
import { app } from "./context.ts";
import { encodingLabel } from "./file-format.ts";
import { isOffline, offline, otherWriter, showOffline } from "./offline-drive.ts";
import { renderSaveState } from "./outline.ts";
import { gitPanel } from "./work-item-updates.ts";

const DISK_SAVE_DELAY = 1500;
let diskSaveTimer = 0;
let saving = false;
/** 自動存檔遇到衝突或錯誤的檔案：使用者手動存檔（Ctrl+S）之前不再自動存。 */
let diskSaveBlocked: string | null = null;

export function scheduleDiskSave(): void {
  clearTimeout(diskSaveTimer);
  if (!app.settings.value.autoSave || !desktop || !app.cur.fileHandle?.path) return;
  diskSaveTimer = window.setTimeout(() => void autoSaveNow(), DISK_SAVE_DELAY);
}

/**
 * 自動存檔：安靜地存，遇到衝突或錯誤就停下來交給使用者，不打斷打字。
 * 開始時就記下是哪個分頁、哪些內容，存檔期間切換分頁也會存到正確的檔案。
 */
export async function autoSaveNow(): Promise<void> {
  clearTimeout(diskSaveTimer);
  diskSaveTimer = 0;
  const doc = app.active;
  const handle = app.cur.fileHandle;
  const path = handle?.path;
  if (path && !app.editor.view.composing) refreshToc();
  const text = app.editor.text;
  if (!path || !app.settings.value.autoSave || saving || diskSaveBlocked === path) return;
  if (app.hash(text) === app.cur.baseline || doc.missing || doc.unloaded || doc.lossy || app.review.active || offline?.path === path) return;
  // 注音、倉頡選字中先不存，等組字結束。
  if (app.editor.view.composing) {
    scheduleDiskSave();
    return;
  }
  saving = true;
  try {
    const out = await saveFile(text, app.cur.fileName, app.cur.kind, handle, { saveAs: false, force: false });
    if (!out) return;
    if (out.status !== "saved") {
      diskSaveBlocked = path;
      const message =
        out.status === "conflict"
          ? t("「{name}」被{who}改過，已暫停自動存檔。按 Ctrl+S 比較差異後再存。", { name: out.name, who: otherWriter(path) })
          : t("「{name}」是 {encoding} 編碼，存不了「{chars}」，已暫停自動存檔。按 Ctrl+S 存檔時可以改存成 UTF-8。", { name: out.name, encoding: encodingLabel(out.encoding), chars: out.chars });
      toast(message, { tone: "error", duration: 12000 });
      return;
    }
    // 自動存檔：只更新這個檔案的 Git 狀態，不重新掃描整個資料夾。
    if (out.handle?.path) void gitPanel?.fileSaved(out.handle.path);
    else gitPanel?.refreshSoon(300);
    if (doc === app.active) {
      app.cur.fileHandle = out.handle;
      app.setBaseline(text, true);
      renderSaveState();
      app.renderTabs(); // app.setBaseline 已經更新了 app.active.dirty，renderSaveState 不會重畫分頁
      // 存檔期間又打了字：再排一次。
      if (app.editor.text !== text) scheduleDiskSave();
    } else {
      doc.handle = out.handle;
      doc.baseline = app.hash(text);
      doc.fileBacked = true;
      doc.dirty = app.hash(doc.state?.doc.toString() ?? loadDraft(doc.id) ?? "") !== doc.baseline;
      app.persistSession();
      app.renderTabs();
    }
  } catch (e) {
    if (isOffline(e)) showOffline(path);
    else {
      diskSaveBlocked = path;
      toast(t("自動存檔失敗，已暫停：{error}", { error: e instanceof Error ? e.message : String(e) }), { tone: "error", duration: 12000 });
    }
  } finally {
    saving = false;
  }
}

/** 自動存檔排好了、還沒存（切換分頁、關閉專案前先存）。 */
export function autoSavePending(): boolean {
  return diskSaveTimer !== 0;
}

/** 手動存檔：取消排好的自動存檔，之後恢復自動存檔（之前遇到衝突或錯誤而暫停的也一樣）。 */
export function resumeAutoSave(): void {
  clearTimeout(diskSaveTimer);
  diskSaveTimer = 0;
  diskSaveBlocked = null;
}

/** 手動存檔：等自動存檔寫完再存，兩次存檔不會同時寫同一個檔案。 */
export async function exclusiveSave<T>(run: () => Promise<T>): Promise<T> {
  while (saving) await new Promise((r) => setTimeout(r, 50));
  saving = true;
  try {
    return await run();
  } finally {
    saving = false;
  }
}
