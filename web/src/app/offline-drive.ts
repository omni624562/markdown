/**
 * 網路磁碟斷線（R1）：存不進去時先留在本機，接上後再寫回；也處理別人同時修改的衝突。
 */
import { formatTable } from "../../pkg/md_wasm.js";
import { desktop, isRemote } from "../desktop.ts";
import { t } from "../i18n.ts";
import { editTable } from "../table.ts";
import { choose } from "../ui/choice.ts";
import { icon } from "../ui/icons.ts";
import { toast } from "../ui/toast.ts";
import { app } from "./context.ts";


/** 原生端回報網路錯誤時，訊息以這段文字開頭（和後端的 `io::OFFLINE` 一致）。 */
const OFFLINE = t("網路磁碟無法連線");
// 在 init 時建立。
let offlineBar: HTMLElement;
export let offline: { path: string; timer: number; back: boolean } | null = null;

export function isOffline(e: unknown): boolean {
  return (e instanceof Error ? e.message : String(e)).startsWith(OFFLINE);
}

/** 存檔時網路磁碟無法連線：保留內容，每 10 秒檢查一次，恢復後提醒存檔。 */
export function showOffline(path: string): void {
  if (offline?.path !== path) {
    clearOffline();
    offline = { path, back: false, timer: window.setInterval(() => void probeOffline(), 10_000) };
  } else {
    offline.back = false;
  }
  renderOffline();
}

async function probeOffline(): Promise<void> {
  if (!offline || offline.back || !desktop) return;
  const reachable = await desktop.probePath(offline.path).catch(() => false);
  if (!reachable || !offline) return;
  offline.back = true;
  clearInterval(offline.timer);
  renderOffline();
  if (app.fileHandle?.path !== offline.path) {
    toast(
      isRemote(offline.path)
        ? t("遠端伺服器已恢復連線，記得回到那份文件存檔。")
        : t("網路磁碟已恢復連線，記得回到那份文件存檔。"),
    );
  }
}

export function clearOffline(): void {
  if (offline) clearInterval(offline.timer);
  offline = null;
  renderOffline();
}

export function renderOffline(): void {
  const show = !!offline && app.fileHandle?.path === offline.path;
  offlineBar.hidden = !show;
  if (!show || !offline) return;
  offlineBar.classList.toggle("back", offline.back);
  const remote = isRemote(offline.path);
  const msg = document.createElement("p");
  msg.append(icon(offline.back ? "refresh-cw" : "circle-alert"));
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn";
  if (offline.back) {
    msg.append(remote ? t("遠端伺服器已恢復連線。") : t("網路磁碟已恢復連線。"));
    button.textContent = t("立即存檔");
    button.addEventListener("click", () => void app.save(false).catch(app.reportError));
  } else {
    msg.append(
      Object.assign(document.createElement("strong"), { textContent: remote ? t("遠端伺服器無法連線") : t("網路磁碟無法連線") }),
      Object.assign(document.createElement("span"), {
        textContent: t("這次沒有存到檔案。內容會保留在編輯器裡（草稿也已自動保存），連線恢復後會提醒你。"),
      }),
    );
    button.textContent = t("重試存檔");
    button.addEventListener("click", () => void app.save(false).catch(app.reportError));
  }
  offlineBar.replaceChildren(msg, button);
}

/** 提示文字用：遠端檔案存在「伺服器」，本機檔案存在「磁碟」。 */
export function storeName(path = app.fileHandle?.path): string {
  return isRemote(path) ? t("伺服器") : t("磁碟");
}

/** 提示文字用：誰會在背後改檔案。 */
export function otherWriter(path = app.fileHandle?.path): string {
  return isRemote(path) ? t("其他電腦或程式") : t("其他程式");
}

/** 檔案在開啟後被別的程式改過：讓使用者比較差異、覆蓋或另存。 */
export async function resolveConflict(name: string, diskText: string): Promise<void> {
  const remote = isRemote(app.fileHandle?.path);
  const wiki = !!app.active.wiki;
  const choice = await choose(
    wiki ? t("Wiki 頁面已被別人修改") : t("檔案已被{who}修改", { who: otherWriter() }),
    wiki
      ? t("「{name}」在你開始編輯之後被別人改過了。要怎麼處理？", { name })
      : remote
        ? t("「{name}」在你開啟之後被其他電腦或程式改過。要怎麼處理？", { name })
        : t("「{name}」在你開啟之後被其他程式（例如同步軟體或另一個編輯器）改過。要怎麼處理？", { name }),
    [
      { id: "compare", label: t("比較差異"), primary: true },
      ...(wiki ? [{ id: "reload", label: t("載入最新版，保留我的修改") }] : []),
      { id: "overwrite", label: t("用我的版本覆蓋"), danger: true },
      { id: "save-as", label: t("另存新檔") },
      { id: "cancel", label: t("取消") },
    ],
  );
  if (choice === "reload") await app.loadWikiLatest(app.active, { content: diskText, etag: app.wikiServerEtag.get(app.active.id) ?? null });
  else if (choice === "overwrite") await app.save(false, true);
  else if (choice === "save-as") await app.save(true);
  else if (choice === "compare") {
    const started = app.review.start(diskText, {
      title: wiki ? t("與 Wiki 上的版本比較") : t("與{store}上的版本比較", { store: storeName() }),
      hint: t("逐段選擇要採用哪個版本，全部處理完會自動存檔。"),
      acceptLabel: wiki || isRemote(app.fileHandle?.path) ? t("採用伺服器版本") : t("採用磁碟版本"),
      rejectLabel: t("保留我的版本"),
      onFinish: () => void app.save(false, true).catch(app.reportError),
    });
    if (!started) await app.save(false, true);
  }
}

/** 對游標所在的表格執行操作；不在表格中時提示使用者。 */
export function runTableEdit(kind: Parameters<typeof editTable>[0]): void {
  const ok = editTable(kind, (b) => formatTable(b))({
    state: app.editor.view.state,
    dispatch: (tr) => app.editor.view.dispatch(tr),
  });
  if (!ok) toast(kind === "delete-row" ? t("標題列與分隔列不能刪除，或游標不在表格中。") : t("請先把游標移到表格裡。"));
  app.editor.view.focus();
}

export function initOfflineDrive(): void {
  offlineBar = app.$("#offline-bar");
}
