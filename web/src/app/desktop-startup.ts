/**
 * 桌面版啟動與外部變更監看：開始監看檔案變動、還原工作區、重新讀取分頁對應的檔案；
 * 已開啟的檔案被其他程式改過時重新載入或提示比較差異。從 main.ts 拆出來，透過 `app` 取用目前的分頁與狀態。
 */
import { undo } from "@codemirror/commands";
import { desktop, isRemote } from "../desktop.ts";
import { fromDesktop } from "../files.ts";
import { t } from "../i18n.ts";
import type { Doc } from "../main.ts";
import { loadDraft, saveDraft } from "../session.ts";
import * as storage from "../storage.ts";
import { toast } from "../ui/toast.ts";
import { app } from "./context.ts";
import { reportError, showExternalChanges } from "./git-actions.ts";
import { searchPanel } from "./git-history.ts";
import { otherWriter, storeName } from "./offline-drive.ts";
import { renderSaveState } from "./outline.ts";
import { gitPanel } from "./work-item-updates.ts";
import { refreshIndexPanels, setWorkspace, showPanel, suggestReconnect } from "./workspace-ui.ts";

/**
 * 桌面版啟動：開始監看檔案變動、還原工作區、重新讀取分頁對應的檔案，
 * 最後處理命令列帶入的檔案或資料夾。
 */
export async function startDesktop(d: NonNullable<typeof desktop>): Promise<void> {
  await Promise.all([
    d.onFileChanged(({ path }) => void onExternalChange(path).catch(reportError)),
    d.onFileRemoved(({ path }) => {
      const doc = app.tabForPath(path);
      if (!doc || doc.missing) return;
      doc.missing = true;
      app.renderTabs();
      toast(t("「{name}」已從磁碟刪除或移走。內容仍保留在分頁中，存檔會重新建立檔案。", { name: doc.name }), { duration: 8000 });
    }),
    d.onTreeChanged(({ dirs }) => {
      app.fileListCache = null;
      app.indexStale = true;
      refreshIndexPanels(300);
      void app.fileTree?.refresh(dirs).then(() => gitPanel?.refreshSoon());
      // 搜尋面板沒顯示時先記下來，打開時再重新搜尋（每次存檔都會走到這裡）。
      if (app.outlineShown && app.sidePanel === "search") searchPanel?.rerun();
      else app.searchStale = true;
    }),
    d.onOpenTarget((t) => {
      if (t.kind === "file") app.openOpenedFile(fromDesktop(t));
      else void setWorkspace(t).then(() => showPanel("files")).catch(reportError);
    }),
    d.onOpenTargetFailed((message) => reportError(new Error(message))),
  ]);

  const target = await d.startupTarget();
  if (target?.kind === "folder") {
    await setWorkspace(target);
    showPanel("files");
  } else {
    const last = storage.load("workspace");
    let needPassword = false;
    const folder = last
      ? await d.reopenFolder(last).catch((e) => {
          // 遠端連線（或 SSH 的跳板主機）沒有記住密碼：提示使用者輸入，不自動跳出對話框打斷。
          if (isRemote(last) && /^NEED_(JUMP_)?PASSWORD(\n|$)/.test(String(e instanceof Error ? e.message : e))) {
            needPassword = true;
            void suggestReconnect(last, (name) => t("要重新連線到「{name}」，需要輸入密碼。", { name }), t("輸入密碼"));
          }
          return null;
        })
      : null;
    await setWorkspace(folder);
    // 還沒輸入密碼不代表不用這個資料夾了：下次啟動仍然提示。
    if (needPassword && last) storage.save("workspace", last);
  }

  await reloadDocs(app.docs);
  app.docsLoaded = true;

  if (target?.kind === "file") app.openOpenedFile(fromDesktop(target));
}

/** 重新讀取分頁的檔案；讀不到的標成「已刪除或移走」。 */
export async function reloadDocs(list: Doc[]): Promise<void> {
  const one = async (doc: Doc): Promise<void> => {
    const path = app.docPath(doc);
    if (!path) return;
    try {
      await reloadDoc(doc, path);
    } catch {
      // 遠端檔案讀不到多半是還沒重新連線，不代表檔案不見了；連線後會再讀一次。
      if (!isRemote(path)) doc.missing = true;
    }
  };
  // 目前的分頁先讀，畫面最快變成正確的內容。
  if (list.includes(app.active)) await one(app.active);
  // 其他分頁最多同時讀 4 個（網路磁碟上一個一個讀要等很久）。
  // 草稿被清掉的分頁（unloaded）切換過去時才讀，不必現在讀進來又寫回草稿、佔掉儲存空間。
  const rest = list.filter((doc) => doc !== app.active && !doc.unloaded);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, rest.length) }, async () => {
      while (next < rest.length) await one(rest[next++]);
    }),
  );
  app.persistSession();
  app.renderTabs();
  // 有了檔案路徑，預覽中的相對路徑圖片才能顯示。
  app.preview.clear();
  app.renderNow();
}

/**
 * 重新讀取分頁的檔案（啟動時、重新連線到遠端資料夾後）：沒有未存檔的變更就直接採用最新內容，
 * 有的話提示比較差異。
 */
export async function reloadDoc(doc: Doc, path: string): Promise<void> {
  const file = fromDesktop(await desktop!.reopenFile(path));
  doc.lossy = file.encoding === "unknown";
  const draft = doc === app.active ? app.editor.text : (loadDraft(doc.id) ?? "");
  // 沒有草稿的分頁：直接採用檔案的內容。
  const clean = doc.unloaded || app.hash(draft) === doc.baseline;
  if (doc.unloaded) {
    doc.unloaded = false;
    doc.dirty = false;
    if (file.text === draft) saveDraft(doc.id, file.text);
  }
  if (doc === app.active) app.cur.fileHandle = file.handle;
  doc.handle = file.handle;
  doc.missing = false;
  if (clean && file.text !== draft) {
    saveDraft(doc.id, file.text);
    doc.baseline = app.hash(file.text);
    doc.state = null;
    if (doc === app.active) {
      app.editor.load(file.text, app.cur.kind);
      app.cur.baseline = doc.baseline;
      app.renderNow();
    }
  } else if (!clean && app.hash(file.text) !== doc.baseline) {
    toast(t("「{name}」在上次關閉後被{who}修改過，你也有未存檔的變更。", { name: doc.name, who: otherWriter(path) }), {
      duration: 12000,
      action: { label: t("比較差異"), run: () => void compareDoc(doc).catch(reportError) },
    });
  }
}

/** 重新連線到遠端資料夾後，重新讀取屬於這個連線的分頁（圖片也重新載入）。 */
export async function reloadRemoteDocs(root: string): Promise<void> {
  for (const doc of app.docs) {
    const path = app.docPath(doc);
    if (!path?.startsWith(`${root}/`)) continue;
    await reloadDoc(doc, path).catch(() => {});
  }
  app.persistSession();
  app.renderTabs();
  app.preview.clear();
  app.renderNow();
}

/** 每個分頁上次提示「被其他程式修改」的時間。 */
const changeNoticeAt = new Map<string, number>();

/** 分頁關掉時忘記它的提示時間。 */
export function forgetChangeNotice(id: string): void {
  changeNoticeAt.delete(id);
}

/** 已開啟的檔案被其他程式（同步軟體、其他編輯器、AI 工具）改過。 */
async function onExternalChange(path: string): Promise<void> {
  const doc = app.tabForPath(path);
  if (!doc || !desktop) return;
  if (doc === app.active) app.stash();
  const markChanges = app.settings.value.aiEnabled && app.settings.value.markExternalChanges;
  // 正在逐段檢視上一次的外部修改時，接著用同一個基準標示（AI 常會連續改好幾次）。
  const continuing = markChanges && doc === app.active && app.review.current?.source === "external";
  if (doc.dirty && !continuing) {
    // 同步軟體常會連續寫入好幾次，提示一次就好。
    const now = Date.now();
    if (now - (changeNoticeAt.get(doc.id) ?? 0) < 15_000) return;
    changeNoticeAt.set(doc.id, now);
    toast(t("「{name}」被{who}修改了，你也有未存檔的變更。", { name: doc.name, who: otherWriter(path) }), {
      duration: 12000,
      action: { label: t("比較差異"), run: () => void compareDoc(doc).catch(reportError) },
    });
    return;
  }
  // 沒有未存檔的變更：直接重新載入。重新讀取也會更新原生端記錄的內容，之後存檔才不會誤判為衝突。
  const wasActive = doc === app.active;
  const before = wasActive ? app.editor.text : loadDraft(doc.id);
  const file = await desktop.reopenFile(path);
  // 讀檔期間（網路磁碟可能要等一陣子）又打了字或切換了分頁：不要蓋掉，改成提示比較差異。
  if (!app.docs.includes(doc)) return;
  const now = doc === app.active ? app.editor.text : loadDraft(doc.id);
  if ((doc === app.active) !== wasActive || now !== before) {
    toast(t("「{name}」被{who}修改了，你也有未存檔的變更。", { name: doc.name, who: otherWriter(path) }), {
      duration: 12000,
      action: { label: t("比較差異"), run: () => void compareDoc(doc).catch(reportError) },
    });
    return;
  }
  if (markChanges && doc !== app.active) doc.externalOriginal ??= loadDraft(doc.id) ?? "";
  saveDraft(doc.id, file.text);
  doc.baseline = app.hash(file.text);
  doc.missing = false;
  if (doc === app.active) {
    if (app.pendingDraft?.id === doc.id) app.pendingDraft = null;
    app.cur.baseline = doc.baseline;
    if (markChanges) {
      const original = continuing ? app.review.current!.original : app.editor.text;
      if (!showExternalChanges(original, file.text)) {
        // 改回原本的內容了：結束標示，直接顯示目前的版本。
        if (app.review.active) app.review.finish();
        if (app.editor.text !== file.text) app.editor.replaceAll(file.text, { userEvent: "input.reload" });
      }
    } else if (file.text !== app.editor.text) {
      app.editor.replaceAll(file.text, { userEvent: "input.reload" }); // 外部修改：COMET 設定檔鎖著也照常重新載入
      toast(t("「{name}」已被{who}更新，已重新載入。", { name: doc.name, who: otherWriter(path) }), {
        action: { label: t("復原"), run: () => void undo(app.editor.view) },
      });
    }
  } else {
    doc.state = null;
    doc.dirty = false;
    if (markChanges && doc.externalOriginal === file.text) doc.externalOriginal = undefined;
    const params = { name: doc.name, who: otherWriter(path) };
    toast(markChanges ? t("「{name}」已被{who}更新，切換過去可以看到改了哪裡。", params) : t("「{name}」已被{who}更新，已重新載入。", params));
  }
  app.persistSession();
  app.renderTabs();
}

/** 切換到分頁，重新讀取磁碟上的版本並逐段比較。 */
async function compareDoc(doc: Doc): Promise<void> {
  changeNoticeAt.delete(doc.id);
  app.activate(doc);
  const path = app.cur.fileHandle?.path;
  if (!path || !desktop) return;
  compareWithDisk((await desktop.reopenFile(path)).text);
}

/**
 * 把目前內容和磁碟上的版本逐段比較。呼叫前應已重新讀取檔案，
 * 這樣比較完存檔時會直接覆寫，不會再跳出衝突提示。
 */
function compareWithDisk(diskText: string): void {
  app.setBaseline(diskText, true);
  renderSaveState();
  const started = app.review.start(diskText, {
    title: t("與{store}上的版本比較", { store: storeName() }),
    hint: t("逐段選擇要採用哪個版本，處理完記得存檔。"),
    acceptLabel: isRemote(app.cur.fileHandle?.path) ? t("採用伺服器版本") : t("採用磁碟版本"),
    rejectLabel: t("保留我的版本"),
  });
  if (!started) toast(t("目前內容和{store}上的版本相同。", { store: storeName() }));
}

