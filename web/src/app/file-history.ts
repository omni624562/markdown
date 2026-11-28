/**
 * 檔案的版本：和某個存檔的版本（本機版本紀錄，E12，存檔時自動保存）比較、和某次 Git 提交比較、
 * 目前檔案在 GitHub／Azure DevOps 網頁上的連結。從 main.ts 拆出來，透過 `app` 取用目前的分頁與編輯器。
 */
import { type FileCommit, type FileVersion, desktop } from "../desktop.ts";
import { versionTitle } from "../history-label.ts";
import { t } from "../i18n.ts";
import { toast } from "../ui/toast.ts";
import { app } from "./context.ts";
import { compareWithOld } from "./compare-old.ts";
import { gitPanel } from "./work-item-updates.ts";

export async function compareWithVersion(v: FileVersion & { path: string }): Promise<void> {
  if (!desktop || app.cur.fileHandle?.path !== v.path) return;
  const text = await desktop.historyRead(v.path, v.id);
  if (app.cur.fileHandle?.path !== v.path) return;
  compareWithOld(text, {
    title: t("和 {version} 的版本比較：改了哪些地方", { version: versionTitle(v.id) }),
    when: t("{version} 的版本", { version: versionTitle(v.id) }),
    same: t("這個版本和目前的內容相同。"),
  });
}

// ---- Git：檔案的提交歷史、網頁連結 --------------------------------------------

export async function compareWithCommit(c: FileCommit & { path: string }): Promise<void> {
  if (!desktop || app.cur.fileHandle?.path !== c.path) return;
  const text = await desktop.gitFileAt(c.path, c.id);
  if (app.cur.fileHandle?.path !== c.path) return;
  compareWithOld(text, {
    title: t("和提交 {commit}（{summary}）比較：改了哪些地方", { commit: c.short, summary: c.summary }),
    when: t("提交 {commit} 時", { commit: c.short }),
    same: t("這次提交時的內容和目前相同。"),
  });
}

/** 目前檔案在 GitHub／Azure DevOps 網頁上的網址；有選取文字時標示那幾行。 */
async function webLink(): Promise<string | null> {
  const path = app.cur.fileHandle?.path;
  if (!desktop || !path) return null;
  const { state } = app.editor.view;
  const sel = state.selection.main;
  const lines = sel.empty
    ? undefined
    : [state.doc.lineAt(sel.from).number, state.doc.lineAt(Math.max(sel.from, sel.to - 1)).number];
  return desktop.gitWebUrl(path, lines?.[0], lines?.[1]);
}

export async function openOnWeb(): Promise<void> {
  if (app.cur.fileHandle && !app.active.dirty && gitPanel?.status?.branch?.ahead) {
    toast(t("這個檔案還有提交沒有推送，網頁上看到的可能是舊的內容。"));
  }
  const url = await webLink();
  if (url) await desktop!.openExternal(url);
}

export async function copyWebLink(): Promise<void> {
  const url = await webLink();
  if (!url) return;
  await navigator.clipboard.writeText(url);
  toast(url.includes("#L") || url.includes("&line=") ? t("已複製連結（含選取的行號）") : t("已複製連結"), { duration: 1500 });
}
