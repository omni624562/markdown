/**
 * 刪除工作項目：從工作項目分頁的右鍵選單（最後一項，紅字）、指令面板「工作項目：刪除目前的工作項目…」，
 * 或上層的「相關工作項目」裡子項目那一列的垃圾桶。
 * 先確認（寫出類型、編號、標題；有子項目時提醒子項目不會一起刪除），焦點預設在「取消」。
 * 伺服器上只移到回收筒，網頁版可以還原；刪除後關掉它的分頁、拿掉左側圖示列的捷徑、重新讀取清單，
 * 顯示中的工作項目（例如它的上層）也重新讀取，「子項目」不再列出它。
 * 「相關工作項目」裡子項目那一列的垃圾桶也用這裡（同一個確認對話框），刪除後只拿掉那一列，不重新讀取整頁；
 * 「移除關聯」只拿掉關聯，不會刪除。
 */
import { type AdoWorkItem, type AdoWorkItemDetail, desktop } from "../desktop.ts";
import { currentLang, t } from "../i18n.ts";
import { choose } from "../ui/choice.ts";
import { toast } from "../ui/toast.ts";
import { isWorkItemShortcut } from "../wiki-shortcuts.ts";
import { openUrl } from "./activity-bar.ts";
import { closeItemsWhere } from "./item-tabs.ts";
import { forgetListCopies } from "./offline-copies.ts";
import { issueView } from "./wiki-edit.ts";
import { barShortcuts, setBarShortcuts, workItemsPanel } from "./work-items-panel.ts";

/** 網頁版的回收筒：工作項目網址的 `…/_workitems/edit/編號` 換成 `…/_workitems/recyclebin`；看不出來時是 null。 */
export function recycleBinUrl(webUrl: string): string | null {
  const m = webUrl.match(/^(.*\/_workitems)\/edit\/\d+(?:[/?#].*)?$/i);
  return m ? `${m[1]}/recyclebin` : null;
}

/**
 * `detail` 是已經讀到的內容（算子項目用）；沒有時另外讀一次，讀不到就不寫子項目。
 * `refreshShown` 為 false 時不重新讀取顯示中的工作項目（從上層的子項目列刪除時，由那一列自己拿掉，不重刷頁面）。
 * 真的刪除了回傳 true（取消或失敗是 false）。
 */
export async function deleteWorkItem(
  item: AdoWorkItem,
  detail: AdoWorkItemDetail | null,
  { refreshShown = true }: { refreshShown?: boolean } = {},
): Promise<boolean> {
  const info = detail ?? (await desktop!.adoWorkItem(item.id).catch(() => null));
  const children = info?.relations.filter((r) => r.link === "child") ?? [];
  const name = t("{kind} {id}「{title}」", { kind: item.kind, id: item.id, title: item.title });
  const parts = [
    children.length === 1
      ? t("底下有 1 個子項目（{child}），不會一起刪除，刪除後它會變成沒有上層。", { child: `${children[0].kind} ${children[0].id}` })
      : children.length > 1
        ? t("底下有 {n} 個子項目，不會一起刪除，刪除後它們會變成沒有上層。", { n: children.length })
        : "",
    t("刪除後會移到 Azure DevOps 的回收筒，可以在網頁版的回收筒還原。"),
  ].filter(Boolean);
  const choice = await choose(t("刪除 {name}？", { name }), parts.join(currentLang() === "en" ? " " : ""), [
    { id: "delete", label: t("刪除"), danger: true },
    { id: "cancel", label: t("取消") },
  ]);
  if (choice !== "delete") return false;
  try {
    await desktop!.adoWorkItemDelete(item.id);
  } catch (e) {
    toast(String(e), { tone: "error" });
    return false;
  }
  const bin = recycleBinUrl(item.webUrl);
  toast(t("已刪除 {name}，可以在網頁版的回收筒還原", { name }), {
    tone: "success",
    duration: 10000,
    action: bin ? { label: t("打開回收筒"), run: () => openUrl(bin) } : undefined,
  });
  // 它的分頁、圖示列上的捷徑一併拿掉；清單、顯示中的上層重新讀取。
  closeItemsWhere((key) => key === `ado:${item.id}`);
  const left = barShortcuts.filter((s) => !isWorkItemShortcut(s) || s.workItem !== item.id);
  if (left.length !== barShortcuts.length) setBarShortcuts(left);
  forgetListCopies("wi-");
  void workItemsPanel?.refresh();
  if (refreshShown && issueView.shownKey?.startsWith("ado:")) void issueView.refresh(true);
  return true;
}
