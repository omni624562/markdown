/**
 * 工作項目、Wiki 頁面、GitHub issue 等唯讀內容的分頁：和文件的分頁排在同一列，新的放在目前分頁的右邊，
 * 也可以固定；右鍵選單、Ctrl+Tab、Ctrl+Shift+T、Ctrl+P 和文件一樣。
 * 點清單上的項目開在「預覽分頁」（名稱斜體），再點別的會換掉它；雙擊分頁（或右鍵「保留分頁」）才留下來。
 * 工作項目與 Wiki 頁面各自有預覽分頁，互不覆蓋；內容裡連到另一種的連結也開在那一種的分頁。
 * 一次顯示一個（蓋住編輯區，或並排在文件右邊）；切換分頁時換上那個分頁的內容、上一頁與捲動位置。
 */
import { t } from "../i18n.ts";
import {
  SAVED_ITEM_TABS_LIMIT,
  type ItemGroup,
  type SavedItemTab,
  arrangeTabs,
  followInTab,
  itemGroup,
  itemTabText,
  neighborAfterClose,
  parseSavedItemTabs,
  placeItem,
  placeNewItem,
} from "../item-tabs.ts";
import * as storage from "../storage.ts";
import type { IssueSource, IssueViewState } from "../ui/issue-view.ts";
import type { TabInfo } from "../ui/tabbar.ts";
import type { Shortcut } from "../wiki-shortcuts.ts";
import { app } from "./context.ts";
import { historyView } from "./git-history.ts";
import { offlineRefs } from "./offline-copies.ts";
import { issueView } from "./wiki-edit.ts";
import { openBarShortcut } from "./work-items-panel.ts";

export interface ItemTab {
  id: string;
  /** 顯示中的內容（和 `IssueSource.key` 相同）。 */
  key: string;
  name: string;
  /** 滑鼠提示，例如「Task 123：標題」。 */
  title: string;
  /** 來源（`ado`、`wiki`、`github`、`repo`）。 */
  origin: string;
  icon: string;
  /** 預覽分頁：點別的同一種項目時換掉它。 */
  preview: boolean;
  /** 種類（工作項目或 Wiki 頁面）：各自有預覽分頁；內容裡連到另一種的連結開在那一種的分頁。 */
  group: ItemGroup;
  /** 上次顯示時的狀態；從上次還原、還沒開過的是 null。 */
  state: IssueViewState | null;
  /** 下次開啟時怎麼重新開啟（工作項目、Wiki 頁面才有）。 */
  ref: Shortcut | null;
  /** 接在哪個文件分頁後面（null 是一般分頁的最前面）。 */
  after: string | null;
  /** 固定的分頁：排在最左邊，不會被換掉，關閉按鈕換成圖釘。 */
  pinned: boolean;
}

/** 關掉的項目分頁（Ctrl+Shift+T 重新開啟用）。 */
export interface ClosedItem {
  name: string;
  origin: string;
  icon: string;
  key: string;
  state: IssueViewState | null;
  ref: Shortcut | null;
}

const ORIGIN_ICONS: Record<string, string> = { ado: "square-kanban", wiki: "book-open-text", github: "circle-dot", repo: "git-branch" };

let seq = 0;
const newId = () => `item-${Date.now().toString(36)}-${++seq}`;

/** 開著的項目分頁（在分頁列上的位置看 `after` 與 `pinned`，見 `tabOrder()`）。 */
export const itemTabs: ItemTab[] = parseSavedItemTabs(storage.load("item-tabs")).map((s) => ({
  id: newId(),
  key: s.key,
  name: s.name,
  title: s.title,
  origin: s.origin,
  icon: ORIGIN_ICONS[s.origin],
  preview: s.preview,
  group: itemGroup(s.origin) ?? "workitem",
  state: null,
  ref: s.ref,
  after: s.after,
  pinned: s.pinned,
}));

/** 顯示中的分頁（蓋住編輯區或並排在右邊）；都沒有顯示時是 null。 */
export let shownItem: ItemTab | null = null;

function persist(): void {
  const saved: SavedItemTab[] = itemTabs
    .filter((tab): tab is ItemTab & { ref: Shortcut; origin: "ado" | "wiki" } => !!tab.ref && (tab.origin === "ado" || tab.origin === "wiki"))
    .slice(0, SAVED_ITEM_TABS_LIMIT)
    .map(({ key, name, title, origin, preview, ref, after, pinned }) => ({ key, name, title, origin, preview, ref, after, pinned }));
  storage.save("item-tabs", JSON.stringify(saved));
}

function changed(): void {
  persist();
  app.renderTabs();
}

/** 並排顯示中（項目在右邊，左邊是文件）。 */
export function sideShown(): boolean {
  return !!shownItem && app.workspace.classList.contains("issue-side");
}

/** 分頁列上所有分頁（文件與項目）的順序。 */
export function tabOrder(): string[] {
  return arrangeTabs(app.docs, itemTabs);
}

/** 分頁列上的一個項目分頁。 */
export function itemTabInfo(tab: ItemTab): TabInfo {
  const text = itemTabText(tab.name, tab.title, tab.ref);
  return {
    id: tab.id,
    name: text.name,
    title: tab.preview ? t("{title}（預覽：點別的項目會換掉這個分頁，雙擊留下來）", { title: text.title }) : text.title,
    dirty: false,
    pinned: tab.pinned,
    item: { icon: tab.icon, origin: tab.origin, preview: tab.preview, side: sideShown() && tab === shownItem, kind: text.kind },
  };
}

/** 分頁列上要標成目前分頁的項目分頁（蓋住編輯區時）；並排或沒有顯示時是 null。 */
export function selectedItemId(): string | null {
  return shownItem && !sideShown() ? shownItem.id : null;
}

export const findItemTab = (id: string): ItemTab | undefined => itemTabs.find((tab) => tab.id === id);

/** 把顯示中的分頁狀態存起來（切換到別的分頁之前）。 */
function stashShown(): void {
  if (shownItem && issueView.isOpen) shownItem.state = issueView.snapshot() ?? shownItem.state;
}

async function showTab(tab: ItemTab, state = tab.state): Promise<void> {
  historyView?.close();
  if (!state) {
    // 從上次還原、還沒開過：重新開啟（讀到後依 key 找回這個分頁）。
    if (tab.ref) await openBarShortcut(tab.ref);
    return;
  }
  if (tab !== shownItem) stashShown();
  shownItem = tab;
  app.renderTabs();
  await issueView.restore(state);
}

/**
 * 開啟工作項目、Wiki 頁面等。內容裡的連結（焦點在檢視裡）在同一個分頁往下走，可以按「上一頁」回來；
 * 其他（側邊欄清單、捷徑）已經開著就切過去，否則開在預覽分頁；`keep` 是新開一個留下來的分頁。
 */
export function openItem(source: IssueSource, keep = false): Promise<void> {
  historyView?.close();
  // 指定了位置（例如 Wiki 頁面結束編輯，換回閱讀）：新開一個留下來的分頁放在那裡。
  const near = besideNext;
  besideNext = undefined;
  if (near !== undefined) keep = true;
  // 內容裡的連結：同一種內容（或附件之類）在同一個分頁往下走；另一種（例如工作項目裡的 Wiki 連結）開在它自己那種的分頁。
  if (!keep && shownItem && issueView.isOpen && issueView.hasFocus && followInTab(shownItem.group, source.origin.kind)) {
    return issueView.show(source);
  }
  const group = itemGroup(source.origin.kind) ?? shownItem?.group ?? "workitem";
  const place = placeItem(itemTabs, source.key, keep, group);
  if (place.kind === "same") {
    const tab = itemTabs[place.index];
    if (keep && tab.preview) {
      tab.preview = false;
      changed();
    }
    // 已經顯示著：用新的資料重新開啟（例如標題改了），位置不變。
    if (tab === shownItem && issueView.isOpen) return issueView.show(source);
    const old = tab.state;
    return showTab(tab, old ? { ...old, source } : { source, back: [], forward: [], scroll: 0 });
  }
  if (place.kind === "preview") {
    const tab = itemTabs[place.index];
    const old = tab === shownItem && issueView.isOpen ? issueView.snapshot() : tab.state;
    // 換掉預覽分頁時，原本的內容記到這個分頁的「上一頁」。
    const back = old ? [...old.back, { source: old.source, scroll: old.scroll }].slice(-50) : [];
    return showTab(tab, { source, back, forward: [], scroll: 0 });
  }
  const tab = addItemTab({ key: source.key, name: source.title, origin: source.origin.kind, icon: source.origin.icon, ref: null, group }, !keep, near);
  return showTab(tab, { source, back: [], forward: [], scroll: 0 });
}

/** 下一個開啟的項目放在這個分頁的右邊（id；null 是一般分頁的最前面）；undefined 是照平常的規則。 */
let besideNext: string | null | undefined;

/** 下一個開啟的項目新開一個留下來的分頁，放在 `id` 這個分頁的右邊（null 是一般分頁的最前面）；`undefined` 取消。 */
export function openNextBeside(id: string | null | undefined): void {
  besideNext = id;
}

/**
 * 項目分頁換成文件分頁時，文件放在哪裡：接在哪個文件後面（null 是一般分頁的最前面），
 * 以及原本在它右邊、接在同一個文件後面的項目分頁（要改接在新的文件後面，位置才不變）。
 */
export function itemSlot(key: string): { after: string | null; right: ItemTab[] } | null {
  const tab = itemTabs.find((x) => x.key === key);
  if (!tab) return null;
  const unpinned = app.docs.filter((d) => !d.pinned).map((d) => d.id);
  const after = !tab.pinned && tab.after && unpinned.includes(tab.after) ? tab.after : null;
  const order = tabOrder();
  const at = order.indexOf(tab.id);
  const right = itemTabs.filter((x) => x !== tab && !x.pinned && x.after === tab.after && order.indexOf(x.id) > at);
  return { after, right };
}

/** 這些項目分頁改接在 `docId` 這個文件後面。 */
export function anchorItems(tabs: ItemTab[], docId: string): void {
  for (const tab of tabs) tab.after = docId;
  changed();
}

/** 新增一個項目分頁，放在目前分頁（顯示中的項目，或目前的文件）的右邊。 */
function addItemTab(
  from: { key: string; name: string; origin: string; icon: string; ref: Shortcut | null; group: ItemGroup },
  preview: boolean,
  near?: string | null,
): ItemTab {
  const id = newId();
  // 放在 `near` 的右邊（null：一般分頁的最前面）；沒給時放在目前分頁的右邊。
  const at = placeNewItem(app.docs, itemTabs, near === undefined ? (shownItem?.id ?? app.active.id) : (near ?? ""));
  const tab: ItemTab = { id, ...from, title: from.name, preview, state: null, after: at.after, pinned: false };
  itemTabs.splice(at.index, 0, tab);
  return tab;
}

/** 檢視換上了一項內容（開啟、上一頁、內容裡的連結）：更新分頁的名稱與還原用的資料。 */
export function itemOpened(source: IssueSource): void {
  const tab = shownItem;
  if (!tab) return;
  tab.key = source.key;
  tab.name = source.title;
  tab.title = source.label && source.label !== source.title ? t("{label}：{title}", { label: source.label, title: source.title }) : source.title;
  tab.origin = source.origin.kind;
  tab.icon = source.origin.icon;
  const ref = offlineRefs.get(source.key);
  tab.ref =
    ref?.type === "ado"
      ? { workItem: ref.item.id, kind: ref.item.kind, title: ref.item.title }
      : ref?.type === "wiki"
        ? { wiki: ref.wiki.id, wikiName: ref.wiki.name, path: ref.path }
        : null;
  changed();
}

/** 切換到項目分頁。 */
export function selectItem(id: string): void {
  const tab = findItemTab(id);
  if (!tab) return;
  if (tab === shownItem && issueView.isOpen) return;
  void showTab(tab);
}

/** 回到文件（分頁留著）：Esc、狀態列的「回到文件」、點文件的分頁。 */
export function hideItem(): void {
  if (!shownItem) {
    issueView.close();
    return;
  }
  stashShown();
  shownItem = null;
  issueView.close();
  app.renderTabs();
}

/** 預覽分頁留下來（不會被換掉）。 */
export function keepItem(id: string): void {
  const tab = findItemTab(id);
  if (!tab?.preview) return;
  tab.preview = false;
  changed();
}

/** 關掉的項目分頁，記下來給「重新開啟關閉的分頁」用。 */
function rememberClosed(tab: ItemTab): void {
  const state = tab === shownItem && issueView.isOpen ? issueView.snapshot() : tab.state;
  app.rememberClosedItem({ name: tab.name, origin: tab.origin, icon: tab.icon, key: tab.key, state, ref: tab.ref });
}

/** 關掉項目分頁；關掉的是顯示中的分頁時，切到旁邊的分頁（並排時換上另一個項目，沒有就只留文件）。 */
export function closeItem(id: string): void {
  const tab = findItemTab(id);
  if (!tab) return;
  const order = sideShown() ? tabOrder().filter((x) => findItemTab(x)) : tabOrder();
  const next = neighborAfterClose(order, id);
  rememberClosed(tab);
  itemTabs.splice(itemTabs.indexOf(tab), 1);
  if (tab === shownItem) {
    shownItem = null;
    const nextItem = next ? findItemTab(next) : undefined;
    if (nextItem) void showTab(nextItem);
    else {
      issueView.close();
      const doc = app.docs.find((d) => d.id === next);
      if (doc && doc !== app.active) app.activate(doc);
    }
  }
  changed();
}

/**
 * 一次關掉好幾個分頁（不會逐一切換過去）；顯示中的也關掉時回到文件。
 * `remember`：記下來給「重新開啟關閉的分頁」用（刪掉的 Wiki 頁面不記）。
 */
export function closeItems(tabs: ItemTab[], remember = true): void {
  if (!tabs.length) return;
  if (remember) tabs.forEach(rememberClosed);
  if (shownItem && tabs.includes(shownItem)) hideItem();
  for (const tab of tabs) itemTabs.splice(itemTabs.indexOf(tab), 1);
  changed();
}

/** 關掉符合條件的項目分頁（例如刪除的 Wiki 頁面）。 */
export function closeItemsWhere(test: (key: string) => boolean): void {
  closeItems(
    itemTabs.filter((x) => test(x.key)),
    false,
  );
}

/** 重新開啟關掉的項目分頁（Ctrl+Shift+T）：看過的內容直接顯示，從上次還原、還沒開過的重新讀取。 */
export function reopenItem(closed: ClosedItem): void {
  const group = itemGroup(closed.origin) ?? "workitem";
  const tab = addItemTab({ key: closed.key, name: closed.name, origin: closed.origin, icon: closed.icon, ref: closed.ref, group }, false);
  tab.state = closed.state;
  changed();
  void showTab(tab);
}

/** 固定或取消固定項目分頁（固定的不是預覽分頁）。 */
export function setItemPinned(id: string, pinned: boolean): void {
  const tab = findItemTab(id);
  if (!tab) return;
  tab.pinned = pinned;
  if (pinned) tab.preview = false;
  changed();
}

/** 文件分頁要關了：接在它後面的項目分頁改接在它左邊的文件後面（位置不變）。 */
export function docClosing(id: string): void {
  const docs = app.docs.filter((d) => !d.pinned);
  const i = docs.findIndex((d) => d.id === id);
  if (i < 0) return;
  const prev = docs[i - 1]?.id ?? null;
  for (const tab of itemTabs) if (tab.after === id) tab.after = prev;
  persist();
}

/** 目前的項目分頁（Ctrl+W 用）：顯示中而且（並排時）焦點在檢視裡。 */
export function focusedItem(): ItemTab | null {
  if (!shownItem || !issueView.isOpen) return null;
  return !sideShown() || issueView.hasFocus ? shownItem : null;
}
