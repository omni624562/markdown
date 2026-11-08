/**
 * 每日筆記：「今天的筆記」打開開啟的資料夾裡的 `每日筆記/2026-11-02.md`，還沒有就用範本建立並存檔；
 * 「前一天／後一天的筆記」跳到最近一份有寫的筆記。資料夾與範本在設定 → 編輯 → 每日筆記。
 * 範本裡單獨一行的 `{{工作項目}}` 換成指派給你、還沒結束的工作項目（待辦清單）；連上 Azure DevOps 時內建範本也有這一段。
 */
import { dailyName, dailyTemplate, dateOfDaily, fillWorkItems, folderSegments, hasWorkItemsVar, neighborNote, withCursor, workItemChecklist } from "../daily-notes.ts";
import { type Entry, desktop } from "../desktop.ts";
import { dayOf } from "../doc-stats-text.ts";
import { t } from "../i18n.ts";
import { basename, dirname } from "../paths.ts";
import { fillTemplate } from "../templates.ts";
import { toast } from "../ui/toast.ts";
import { app } from "./context.ts";
import { insertAtCursor } from "./image-paste.ts";
import { openPath } from "./workspace-ui.ts";
import { DEFAULT_WORK_ITEM_FILTER } from "../work-item-filter.ts";
import { commands } from "./commands.ts";
import { reportError } from "./git-actions.ts";

/** 開著的資料夾；還沒開資料夾時提示一下，回傳 null。 */
function workspace(): string | null {
  if (!desktop) return null;
  if (app.workspaceRoot) return app.workspaceRoot.path;
  toast(t("先開啟一個資料夾：每日筆記會存在資料夾裡。"), {
    action: { label: t("開啟資料夾…"), run: () => void commands.run("open-folder").catch(reportError) },
  });
  return null;
}

/** 同名的項目（Windows 不分大小寫：完全相同的優先）。 */
function named(entries: Entry[], name: string): Entry | undefined {
  return entries.find((e) => e.name === name) ?? entries.find((e) => e.name.toLowerCase() === name.toLowerCase());
}

/**
 * 每日筆記的資料夾（設定裡的子資料夾，一層一層找）。`create` 為 true 時沒有的就建立；
 * 為 false 時找不到回傳 null。
 */
async function notesDir(root: string, create: boolean): Promise<string | null> {
  const parts = folderSegments(app.settings.value.dailyFolder) ?? [];
  let dir = root;
  for (const name of parts) {
    const found = named(await desktop!.listDir(dir), name);
    if (found && !found.isDir) {
      throw new Error(t("「{name}」是檔案，不是資料夾。請到設定 → 編輯 → 每日筆記換一個資料夾。", { name }));
    }
    if (found) dir = found.path;
    else if (!create) return null;
    else {
      const parent = dir;
      dir = await desktop!.createEntry(parent, name, true);
      await app.fileTree?.refresh([parent]);
    }
  }
  return dir;
}

/** 設定選的範本（找不到時用內建的）。 */
function templateBody(): string {
  const name = app.settings.value.dailyTemplate;
  const custom = name ? app.settings.value.templates.find((x) => x.name === name) : undefined;
  return custom?.body.trim() ? custom.body : dailyTemplate(!!app.ado?.account);
}

/** 指派給我、還沒結束的工作項目（和工作項目面板的預設清單一樣）。 */
function myWorkItems() {
  return desktop!.adoWorkItems("", DEFAULT_WORK_ITEM_FILTER);
}

/** 範本裡的 `{{工作項目}}` 換成待辦清單；沒有連上時拿掉，讀不到時寫原因（筆記照樣建立）。 */
async function withWorkItems(body: string): Promise<string> {
  if (!hasWorkItemsVar(body)) return body;
  if (!app.ado?.account) return fillWorkItems(body, null, "");
  try {
    return fillWorkItems(body, await myWorkItems(), t("（目前沒有指派給你、還沒結束的工作項目）"));
  } catch (e) {
    return fillWorkItems(body, [], t("（讀不到指派給你的工作項目：{error}）", { error: e instanceof Error ? e.message : String(e) }));
  }
}

/** 在游標的位置插入指派給我、還沒結束的工作項目（待辦清單）。 */
export async function insertMyWorkItems(): Promise<void> {
  const items = await myWorkItems();
  if (!items.length) {
    toast(t("目前沒有指派給你、還沒結束的工作項目"));
    return;
  }
  insertAtCursor(`${workItemChecklist(items)}\n`);
  toast(t("已插入 {n} 個工作項目", { n: items.length }));
}

/** 打開今天的筆記；還沒有就用範本建立、存檔，游標放在第一個待辦。 */
export async function openDailyNote(now = new Date()): Promise<void> {
  const root = workspace();
  if (!root) return;
  const dir = (await notesDir(root, true))!;
  const name = dailyName(now);
  const existing = named(await desktop!.listDir(dir), name);
  if (existing && !existing.isDir) return openPath(existing.path);
  // 建立之前先讀工作項目（範本有用到時），打開時內容就是完整的。
  const body = await withWorkItems(templateBody());
  const path = await desktop!.createEntry(dir, name, false);
  app.fileListCache = null;
  app.indexStale = true;
  await app.fileTree?.refresh([dir]);
  await openPath(path);
  // 確定開的是剛建立的空白檔案，才填入範本。
  if (app.cur.fileHandle?.path !== path || app.editor.text) return;
  const { text, line, column } = withCursor(fillTemplate(body, now));
  app.editor.replaceAll(text, { isolate: true });
  await app.save(false);
  app.editor.reveal(line, column);
}

/** 往前（-1）或往後（1）跳到最近一份每日筆記：開著每日筆記時從它的日期算，否則從今天算。 */
export async function openNeighborNote(step: -1 | 1): Promise<void> {
  const root = workspace();
  if (!root) return;
  const dir = await notesDir(root, false);
  const entries = dir ? (await desktop!.listDir(dir)).filter((e) => !e.isDir) : [];
  const here = app.cur.fileHandle?.path;
  const from = (dir && here && dirname(here) === dir && dateOfDaily(basename(here))) || dayOf(new Date());
  const next = neighborNote(
    entries.map((e) => e.name),
    from,
    step,
  );
  const entry = next ? entries.find((e) => e.name === next) : undefined;
  if (!entry) {
    toast(step < 0 ? t("沒有更早的每日筆記。") : t("沒有更晚的每日筆記。"));
    return;
  }
  await openPath(entry.path);
}
