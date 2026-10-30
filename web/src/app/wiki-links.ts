/**
 * 文件互連：[[文件]] 連結、改名時更新連結。
 */
import { renameLinks } from "../../pkg/md_wasm.js";
import { type FileItem, desktop, type LinkUpdate } from "../desktop.ts";
import { t } from "../i18n.ts";
import { type FileRef, resolveWiki, linkTarget } from "../links.ts";
import { refreshLivePreview } from "../live-preview.ts";
import { dirname, basename, isInside, rebase } from "../paths.ts";
import { saveDraft } from "../session.ts";
import { choose } from "../ui/choice.ts";
import { toast } from "../ui/toast.ts";
import type { IndexedDoc } from "../workspace-index.ts";
import { openPath, refreshIndexPanels } from "./workspace-ui.ts";
import { app } from "./context.ts";


const markdownLists = new WeakMap<readonly FileItem[], FileRef[]>();

/** 資料夾中的 Markdown 文件（同一份清單只過濾一次，`resolveWiki` 的索引也能沿用）。 */
export function markdownFiles(list: readonly FileItem[]): FileRef[] {
  let md = markdownLists.get(list);
  if (!md) {
    md = list.filter((f) => /\.(md|markdown)$/i.test(f.path));
    markdownLists.set(list, md);
  }
  return md;
}

let fileListLoading: Promise<void> | null = null;

/** `[[文件]]` 找不找得到對應的檔案；檔案清單還沒讀到時先回傳 null，讀到後重畫。 */
export function wikiExists(target: string): boolean | null {
  if (!desktop || !app.workspaceRoot) return null;
  if (!app.fileListCache) {
    const root = app.workspaceRoot.path;
    fileListLoading ??= desktop
      .listFiles(root)
      .then((list) => {
        if (app.workspaceRoot?.path === root) app.fileListCache ??= list;
      })
      .catch(() => {})
      .finally(() => {
        fileListLoading = null;
        if (!app.fileListCache) return;
        refreshLivePreview(app.editor.view);
        app.preview.clear();
        app.renderNow();
      });
    return null;
  }
  return resolveWiki(target, markdownFiles(app.fileListCache), app.fileHandle?.path ? dirname(app.fileHandle.path) : null) !== null;
}

/** 開啟 `[[文件#標題]]`；資料夾中還沒有這份文件時詢問要不要建立。 */
export async function openWiki(full: string): Promise<void> {
  const hashAt = full.indexOf("#");
  const target = (hashAt >= 0 ? full.slice(0, hashAt) : full).trim();
  const anchor = hashAt >= 0 ? full.slice(hashAt + 1).trim() : "";
  if (!target) {
    if (anchor) scrollToHeading(anchor);
    return;
  }
  if (!desktop || !app.workspaceRoot) {
    toast(desktop ? t("開啟資料夾後，才能用 [[文件]] 連到資料夾中的其他文件。") : t("網頁版無法開啟其他檔案，請改用桌面版。"));
    return;
  }
  const root = app.workspaceRoot.path;
  app.fileListCache ??= await desktop.listFiles(root).catch(() => []);
  const here = app.fileHandle?.path ? dirname(app.fileHandle.path) : null;
  const path = resolveWiki(target, markdownFiles(app.fileListCache), here);
  if (path) {
    await openPath(path);
    if (anchor) {
      app.renderNow();
      scrollToHeading(anchor);
    }
    return;
  }
  const name = basename(target.replace(/\\/g, "/")).replace(/\.(md|markdown)$/i, "");
  const parent = here && isInside(here, root) ? here : root;
  const choice = await choose(
    t("建立「{name}.md」？", { name }),
    t("資料夾中還沒有「{target}」這份文件。要在「{folder}」資料夾建立嗎？", { target, folder: basename(parent) || parent }),
    [
    { id: "create", label: t("建立"), primary: true },
    { id: "cancel", label: t("取消") },
  ]);
  if (choice !== "create") return;
  const created = await desktop.createEntry(parent, `${name}.md`, false);
  app.fileListCache = null;
  app.indexStale = true;
  await app.fileTree?.refresh([parent]);
  await openPath(created);
  if (!app.editor.text) app.editor.replaceAll(`# ${name}\n\n`);
  refreshLivePreview(app.editor.view);
}

/** 捲到標題：`[[文件#標題]]` 的標題可能是文字（例如「一、背景」）或錨點 id。 */
function scrollToHeading(anchor: string): void {
  const headings = app.preview.result?.headings ?? [];
  const h = headings.find((x) => x.id === anchor) ?? headings.find((x) => x.text.trim() === anchor);
  app.scrollToAnchor(h?.id ?? anchor);
}

/** 檔案或資料夾改名後，更新其他文件中指向它（或它底下檔案）的連結。 */
export async function updateLinksAfterRename(from: string, to: string, docsBefore: IndexedDoc[], files: FileRef[]): Promise<void> {
  const moved = (p: string) => rebase(p, from, to);
  // 先用索引裡的連結挑出可能要改的文件，只讀這幾份的內容。
  const linking = docsBefore.filter(
    (doc) =>
      doc.path &&
      doc.info.links.some((l) => {
        const p = linkTarget(l, doc.path, files);
        return p !== null && moved(p) !== null;
      }),
  );
  if (!linking.length) return;
  // 已開啟的分頁用編輯器裡的內容；沒開啟的檔案由後端讀取、改寫，只傳回有改到的。
  const changes: LinkUpdate[] = [];
  for (const doc of linking) {
    if (doc.text === null) continue;
    const next = renameLinks(doc.text, doc.path!, files, from, to);
    if (next !== undefined) changes.push({ path: moved(doc.path!) ?? doc.path!, before: doc.text, text: next });
  }
  const closed = linking.filter((doc) => doc.text === null).map((doc) => doc.path!);
  if (closed.length) changes.push(...(await desktop!.linkUpdates(closed, files, from, to)));
  if (!changes.length) return;
  const choice = await choose(
    t("更新連結？"),
    t("有 {n} 份文件連到「{from}」，要一起把連結改成「{to}」嗎？更新前的內容會記在版本記錄中。", {
      n: changes.length,
      from: basename(from),
      to: basename(to),
    }),
    [
      { id: "update", label: t("更新連結"), primary: true },
      { id: "skip", label: t("不用") },
    ],
  );
  if (choice !== "update") return;
  let done = 0;
  const failed: string[] = [];
  for (const c of changes) {
    try {
      await replaceDocText(c.path, c.before, c.text);
      done++;
    } catch (e) {
      failed.push(t("{name}（{error}）", { name: basename(c.path), error: e instanceof Error ? e.message : String(e) }));
    }
  }
  app.indexStale = true;
  refreshIndexPanels();
  if (failed.length) toast(t("已更新 {n} 份文件的連結；無法更新：{failed}", { n: done, failed: failed.join(t("、")) }), { tone: "error", duration: 10000 });
  else toast(t("已更新 {n} 份文件的連結。", { n: done }), { tone: "success" });
}

/**
 * 把一份文件的內容換成 `text`（`expected` 是改之前的內容）：
 * 目前的分頁直接改編輯器（可以復原）；背景分頁沒有未存檔的變更時一起寫入檔案；沒開啟的檔案直接改寫。
 */
async function replaceDocText(path: string, expected: string, text: string): Promise<void> {
  const tab = app.tabForPath(path);
  if (tab === app.active) {
    app.editor.replaceAll(text, { isolate: true });
    return;
  }
  if (tab) {
    const clean = !tab.dirty;
    if (clean) await desktop!.updateDoc(path, expected, text);
    tab.state = tab.state ? tab.state.update({ changes: { from: 0, to: tab.state.doc.length, insert: text } }).state : null;
    saveDraft(tab.id, text);
    if (clean) tab.baseline = app.hash(text);
    app.persistSession();
    app.renderTabs();
    return;
  }
  await desktop!.updateDoc(path, expected, text);
}
