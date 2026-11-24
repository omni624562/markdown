/**
 * 檔案的選單（檔案面板每一列的「⋯」／右鍵、原始碼控制每一列的「⋯」／右鍵共用同一份）：
 * 同一個動作在兩邊的名稱、圖示、順序、危險標示都一樣，只差「在那裡才有意義」的幾項。
 * 依「看 → 找 → 改 → 刪」分四組：
 * - 看：開啟（原始碼控制才有；檔案面板點檔名就開）、看改了哪些地方（修改過的）、歷史。
 * - 找：在檔案面板中顯示（原始碼控制才有）、在檔案總管中顯示（本機）、下載到電腦（遠端）、複製路徑、插入連結。
 * - 改：重新命名、放到左側圖示列（檔案面板才有）、捨棄修改（修改過的）、復原這個檔案（刪除的）。
 * - 刪：移到資源回收筒（最下面、紅色）。
 */
import { type Entry, isRemote } from "../desktop.ts";
import { desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { samePath } from "../links.ts";
import { basename } from "../paths.ts";
import { type MenuEntry, setupMenu } from "../ui/menu.ts";
import { app } from "./context.ts";
import { compareWithHead, discardChanges, reportError } from "./git-actions.ts";
import { menuEntries as shortcutEntries } from "./file-shortcuts.ts";
import { showHistoryOf } from "./history-panel.ts";
import { gitPanel } from "./work-item-updates.ts";
import { openPath, showPanel, treeAction } from "./workspace-ui.ts";

export type FileMenuPlace = "tree" | "scm";

/** 這個檔案在原始碼控制裡的狀態（沒有變更時 null）。 */
function gitStatusOf(path: string) {
  return gitPanel?.status?.changes.find((c) => samePath(c.path, path))?.status ?? null;
}

export function fileMenuEntries(path: string, place: FileMenuPlace): MenuEntry[] {
  const entry: Entry = { path, name: basename(path), isDir: false };
  const status = gitStatusOf(path);
  const deleted = status === "deleted";
  const modified = status === "modified";
  const remote = isRemote(path);
  const act = (action: Parameters<typeof treeAction>[0]) => () => void treeAction(action, entry).catch(reportError);
  const look: MenuEntry[] = deleted
    ? []
    : [
        ...(place === "scm" ? [{ label: t("開啟"), icon: "file-text", run: () => void openPath(path).catch(reportError) }] : []),
        ...(modified ? [{ label: t("看改了哪些地方"), icon: "git-compare", run: () => void compareWithHead(path).catch(reportError) }] : []),
        ...(desktop ? [{ label: t("歷史（存檔版本、提交）…"), icon: "history", run: () => void showHistoryOf(path).catch(reportError) }] : []),
      ];
  const find: MenuEntry[] = [
    ...(place === "scm" && !deleted
      ? [
          {
            label: t("在檔案面板中顯示"),
            icon: "folder-open",
            run: () => {
              showPanel("files");
              void app.fileTree?.setActive(path);
            },
          },
        ]
      : []),
    ...(remote || deleted ? [] : [{ label: t("在檔案總管中顯示"), icon: "external-link", run: act("reveal") }]),
    ...(remote && !deleted ? [{ label: t("下載到電腦…"), icon: "download", run: act("download") }] : []),
    { label: t("複製路徑"), icon: "copy", run: act("copy-path") },
    ...(deleted ? [] : [{ label: t("插入連結到目前的文件"), icon: "link", run: act("insert-link") }]),
  ];
  const change: MenuEntry[] = [
    ...(place === "tree" && !deleted ? [{ label: t("重新命名"), icon: "pencil", run: act("rename") }] : []),
    ...(place === "tree" ? shortcutEntries(() => path) : []),
    ...(modified ? [{ label: t("捨棄修改…"), icon: "undo-2", run: () => void discardChanges(path).catch(reportError) }] : []),
    ...(deleted
      ? [
          {
            label: t("復原這個檔案（拿回上次提交的版本）"),
            icon: "undo-2",
            run: () =>
              void desktop
                ?.gitRestore(path)
                .then(() => gitPanel?.refresh())
                .catch(reportError),
          },
        ]
      : []),
  ];
  const remove: MenuEntry[] = deleted ? [] : [{ label: t("移到資源回收筒…"), icon: "trash", danger: true, run: act("trash") }];
  const groups = [look, find, change, remove].filter((g) => g.length);
  return groups.flatMap((g, i) => (i ? ["-" as const, ...g] : g));
}

let anchor: HTMLButtonElement | null = null;
let current: { path: string; place: FileMenuPlace } | null = null;

/** 在 (x, y) 打開某個檔案的選單（「⋯」按鈕的下緣，或右鍵的位置）。 */
export function showFileMenu(path: string, place: FileMenuPlace, x: number, y: number): void {
  if (!anchor) {
    anchor = document.createElement("button");
    anchor.type = "button";
    anchor.className = "insert-anchor";
    anchor.tabIndex = -1;
    anchor.id = "file-menu";
    document.body.append(anchor);
    setupMenu(anchor, null, () => (current ? fileMenuEntries(current.path, current.place) : []));
  }
  current = { path, place };
  Object.assign(anchor.style, { left: `${x}px`, top: `${y}px`, width: "0px", height: "0px" });
  const pop = document.getElementById("file-menu-popover");
  if (pop?.matches(":popover-open")) pop.hidePopover();
  anchor.click();
}
