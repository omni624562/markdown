/**
 * 左側圖示列上的檔案捷徑：常開的本機文字檔（例如 `D:\…\Notepad++\MENO.txt`、`週報.md`）放到圖示列，點一下開啟。
 * 從檔案樹、檔案的分頁拖到圖示列，或在它們的右鍵選單選「放到左側圖示列」。
 * 和 Wiki 頁面、工作項目的捷徑放在同一列、一起算上限，不分專案。
 * 只有桌面版、本機的檔案可以；SSH、WebDAV 遠端資料夾的檔案不行（不列選單、拖不起來）。
 * 列在圖示列上的檔案也告訴原生端，之後就算很久沒開、不在「最近開啟」裡，按捷徑也開得了。
 */
import { type Entry, desktop, isRemote } from "../desktop.ts";
import { t } from "../i18n.ts";
import { basename, rebase } from "../paths.ts";
import { toast } from "../ui/toast.ts";
import { type FileShortcut, SHORTCUT_DRAG_TYPE, fileExtension, fileInitial, isFileShortcut, isShortcutFile, shortcutHue } from "../wiki-shortcuts.ts";
import { app } from "./context.ts";
import { selectedItemId } from "./item-tabs.ts";
import { addBarShortcut, barShortcuts, removeBarShortcut, setBarShortcuts } from "./work-items-panel.ts";
import { openPath } from "./workspace-ui.ts";

/** 可以放到圖示列的檔案（桌面版、本機的檔案）；網頁版、遠端資料夾的檔案、還沒存成檔案的文件是 null。 */
export function fileShortcut(path: string | null | undefined): FileShortcut | null {
  return desktop && path && !isRemote(path) && isShortcutFile(path) ? { file: path } : null;
}

function hasFileShortcut(path: string): boolean {
  return barShortcuts.some((s) => isFileShortcut(s) && s.file === path);
}

/** 檔案放到圖示列，或從圖示列移除。 */
export function toggleFileShortcut(path: string): void {
  const item = fileShortcut(path);
  if (!item) return;
  if (hasFileShortcut(path)) removeBarShortcut(item);
  else addBarShortcut(item);
}

/** 右鍵選單的一項（分頁的選單、檔案樹的選單都用這個格式）。 */
interface FileMenuEntry {
  label: string;
  icon: string;
  when: () => boolean;
  run(): void;
}

/** 右鍵選單上的「放到左側圖示列」（已經放了的是「從左側圖示列移除」）；不能放的檔案沒有這一項。 */
function menuEntries(path: () => string | null): FileMenuEntry[] {
  const can = () => !!fileShortcut(path());
  return [
    { label: t("放到左側圖示列"), icon: "pin", when: () => can() && !hasFileShortcut(path()!), run: () => toggleFileShortcut(path()!) },
    { label: t("從左側圖示列移除"), icon: "pin-off", when: () => can() && hasFileShortcut(path()!), run: () => toggleFileShortcut(path()!) },
  ];
}

/** 文件分頁的右鍵選單（工作項目等的分頁不算）。 */
export const fileTabMenuEntries = (): FileMenuEntry[] => menuEntries(() => (app.menuItemTab() ? null : app.tabPath(app.menuTab())));

/**
 * 按了檔案捷徑：已經開著就切過去，否則開啟。
 * 打不開時看檔案還在不在：搬走或刪除了就說明，通知上可以直接從圖示列移除；其他原因照常顯示錯誤。
 */
export async function openFileShortcut(item: FileShortcut): Promise<boolean> {
  try {
    await openPath(item.file);
    return true;
  } catch (e) {
    const exists = await desktop?.pathsExist([item.file]).then(
      (r) => r[0],
      () => null,
    );
    if (exists !== false) throw e;
    toast(t("找不到這個檔案：「{name}」可能已經搬走或刪除。", { name: basename(item.file) }), {
      tone: "error",
      action: { label: t("從左側圖示列移除"), run: () => removeBarShortcut(item) },
    });
    return false;
  }
}

/** 檔案正開在中間（左右並排時任一邊），而且沒有被工作項目等的分頁蓋住。 */
export function fileShortcutShown(item: FileShortcut): boolean {
  if (selectedItemId() !== null) return false;
  return [app.paneDocs.main, app.paneDocs.side].some((doc) => !!doc && app.docs.includes(doc) && app.tabPath(doc) === item.file);
}

/** 圖示列上的檔案捷徑：和 Wiki 頁面一樣是檔名第一個字的彩色方塊，右下角加上副檔名；滑鼠提示是完整路徑。 */
export function drawFileShortcut(button: HTMLElement, badge: HTMLElement, item: FileShortcut): void {
  const name = basename(item.file);
  button.title = item.file;
  button.setAttribute("aria-label", name);
  button.classList.add("activity-file");
  badge.style.setProperty("--hue", String(shortcutHue(`file:${item.file}`)));
  badge.textContent = fileInitial(item.file);
  const ext = fileExtension(item.file);
  if (!ext) return;
  const mark = document.createElement("span");
  mark.className = "file-ext";
  mark.textContent = ext;
  mark.setAttribute("aria-hidden", "true");
  button.append(mark);
}

/** 檔案或資料夾改名、搬移後，圖示列上的捷徑跟著換到新路徑。 */
export function renameFileShortcuts(from: string, to: string): void {
  if (!barShortcuts.some((s) => isFileShortcut(s) && rebase(s.file, from, to))) return;
  setBarShortcuts(barShortcuts.map((s) => (isFileShortcut(s) ? { file: rebase(s.file, from, to) ?? s.file } : s)));
}

/** 上次告訴原生端的檔案捷徑（一樣就不再送）。 */
let trusted: string | null = null;

/** 圖示列上的檔案告訴原生端：之後就算不在「最近開啟」裡也開得了（原生端只接受目前就能開啟的檔案）。 */
export function syncFileShortcuts(): void {
  if (!desktop) return;
  const files = barShortcuts.filter(isFileShortcut).map((s) => s.file);
  const key = JSON.stringify(files);
  if (key === trusted) return;
  trusted = key;
  void desktop.setFileShortcuts(files).catch(console.error);
}

/** 拖曳時帶的資料：放到圖示列就變成捷徑。 */
const dragData = (path: string | null): Record<string, string> | null => {
  const item = fileShortcut(path);
  return item ? { [SHORTCUT_DRAG_TYPE]: JSON.stringify(item) } : null;
};

export function initFileShortcuts(): void {
  // 檔案樹：檔案的右鍵選單、拖到圖示列（資料夾不行）。
  app.fileTree?.extend({
    menuItems: (entry: Entry) => (entry.isDir ? [] : menuEntries(() => entry.path)),
    dragData: (entry: Entry) => (entry.isDir ? null : dragData(entry.path)),
  });
  // 文件的分頁：拖到圖示列。
  app.tabBar.extend({
    dragData: (id) => {
      const doc = app.docs.find((d) => d.id === id);
      return doc ? dragData(app.tabPath(doc)) : null;
    },
  });
  syncFileShortcuts();
}
