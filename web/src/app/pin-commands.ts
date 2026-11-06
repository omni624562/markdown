/**
 * 把常用的指令釘到看得到的地方：「☰」等選單裡的指令按右鍵，可以釘到「檔案」面板上方（專案名稱旁邊）
 * 或左側圖示列；已經釘了的換成移除。
 *
 * 檔案面板上方的按鈕跟著專案：那一列只在開著資料夾時顯示，沒開專案時按鈕也一起不見；
 * 指令用不到時（例如遠端資料夾不能在 Codex 開啟、這台電腦沒裝 Codex）也藏起來。
 * 新增檔案、新增資料夾、重新讀取和釘上去的按鈕一直顯示（不隨滑鼠位置出現或藏起來，畫面才不會變來變去）；
 * 面板太窄時專案名稱縮短。
 */
import { t } from "../i18n.ts";
import { ACTIVITY_LIMIT, FILES_HEAD_LIMIT } from "../settings.ts";
import { checkAiApps } from "./ai-app-presence.ts";
import { icon } from "../ui/icons.ts";
import { onCommandContextMenu, type MenuEntry } from "../ui/menu.ts";
import { toast } from "../ui/toast.ts";
import { floatingMenu } from "./activity-bar.ts";
import { reportError } from "./git-actions.ts";
import { app } from "./context.ts";

/** 釘到檔案面板上方，或從那裡移除。 */
function toggleHead(id: string): void {
  const list = app.settings.value.filesHeadCommands;
  if (list.includes(id)) {
    app.settings.update({ filesHeadCommands: list.filter((x) => x !== id) });
    return;
  }
  if (list.length >= FILES_HEAD_LIMIT) {
    toast(t("檔案面板上方最多放 {n} 個按鈕。", { n: FILES_HEAD_LIMIT }), { tone: "error" });
    return;
  }
  app.settings.update({ filesHeadCommands: [...list, id] });
  const name = app.commands.get(id)?.title ?? id;
  // 沒開資料夾時看不到那一列：說明開了專案才會出現。
  const where = app.workspaceRoot ? t("已把「{name}」釘到檔案面板上方。", { name }) : t("已把「{name}」釘到檔案面板上方，開啟專案後就會出現。", { name });
  toast(where, { tone: "success" });
}

/** 釘到左側圖示列，或從那裡移除。 */
function toggleActivity(id: string): void {
  const list = app.settings.value.activityCommands;
  if (list.includes(id)) {
    app.settings.update({ activityCommands: list.filter((x) => x !== id) });
    return;
  }
  if (list.length >= ACTIVITY_LIMIT) {
    toast(t("圖示列最多放 {n} 個按鈕。", { n: ACTIVITY_LIMIT }), { tone: "error" });
    return;
  }
  app.settings.update({ activityCommands: [...list, id] });
  toast(t("已把「{name}」放到圖示列，拖曳可以調整位置。", { name: app.commands.get(id)?.title ?? id }), { tone: "success" });
}

/** 指令的右鍵選單：釘到檔案面板上方、左側圖示列（已經釘了的換成移除）。 */
export function openPinMenu(id: string, at: DOMRect): void {
  for (const el of ["pin-menu-anchor", "pin-menu-anchor-popover"]) document.getElementById(el)?.remove();
  const inHead = app.settings.value.filesHeadCommands.includes(id);
  const inBar = app.settings.value.activityCommands.includes(id);
  const entries: MenuEntry[] = [
    { label: inHead ? t("從檔案面板上方移除") : t("釘到檔案面板上方"), icon: inHead ? "pin-off" : "panel-top", run: () => toggleHead(id) },
    { label: inBar ? t("從左側圖示列移除") : t("釘到左側圖示列"), icon: inBar ? "pin-off" : "pin", run: () => toggleActivity(id) },
  ];
  floatingMenu("pin-menu-anchor", entries).open(at);
}

/**
 * 檔案面板上方釘上去的按鈕：放在最右邊，滑鼠移到面板上、新增檔案等按鈕出現時（在它們左邊）位置也不會動，
 * 不會點錯。
 */
export function renderFilesHeadPins(): void {
  const head = document.getElementById("files-head");
  if (!head) return;
  for (const el of head.querySelectorAll(".head-pin, .head-pin-sep")) el.remove();
  const buttons = app.settings.value.filesHeadCommands.flatMap((id) => {
    const cmd = app.commands.get(id);
    if (!cmd || !(cmd.when?.() ?? true)) return [];
    const label = cmd.tip?.() ?? cmd.title;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn icon-only head-pin";
    b.dataset.command = id;
    b.title = app.withKeys(label, cmd.keys);
    b.setAttribute("aria-label", label);
    b.append(icon(cmd.icon ?? "command"));
    b.addEventListener("click", () => void app.commands.run(id).catch(reportError));
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const at = new DOMRect(e.clientX, e.clientY, 0, 0);
      // 右鍵還按著時（Linux 放開前就觸發）：放開後才開，否則放開那一下會把剛開的選單關掉。
      if (e.buttons & 2) window.addEventListener("pointerup", () => setTimeout(() => openPinMenu(id, at)), { once: true });
      else openPinMenu(id, at);
    });
    return [b];
  });
  head.classList.toggle("has-pins", buttons.length > 0);
  if (!buttons.length) return;
  const sep = document.createElement("span");
  sep.className = "head-pin-sep";
  sep.setAttribute("aria-hidden", "true");
  head.append(sep, ...buttons);
}

/** 指令能不能用變了（開了別的資料夾、偵測到裝了 Codex）：釘上去的按鈕跟著更新。 */
function refreshPins(): void {
  renderFilesHeadPins();
  app.refreshActivityCommands();
}

export function initPinCommands(): void {
  onCommandContextMenu(openPinMenu);
  renderFilesHeadPins();
  app.settings.subscribe((_, changed) => {
    if (!changed || changed.includes("filesHeadCommands")) renderFilesHeadPins();
  });
  // 有沒有裝 Codex、Claude 是啟動後才查到的，視窗切回來時也會再查一次。
  void checkAiApps().then(refreshPins);
  window.addEventListener("focus", () => void checkAiApps().then(refreshPins));
}
