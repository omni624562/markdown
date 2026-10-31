/**
 * 工作項目、Wiki 頁面、GitHub issue 等唯讀內容的分頁：和文件的分頁排在同一列（文件在前）。
 * 點清單上的項目開在「預覽分頁」（名稱斜體），再點別的會換掉它；雙擊分頁（或右鍵「保留分頁」）才留下來。
 * 一次顯示一個（蓋住編輯區，或並排在文件右邊）；切換分頁時換上那個分頁的內容、上一頁與捲動位置。
 */
import { t } from "../i18n.ts";
import { SAVED_ITEM_TABS_LIMIT, type SavedItemTab, neighborAfterClose, parseSavedItemTabs, placeItem } from "../item-tabs.ts";
import * as storage from "../storage.ts";
import type { IssueSource, IssueViewState } from "../ui/issue-view.ts";
import type { TabInfo } from "../ui/tabbar.ts";
import type { Shortcut } from "../wiki-shortcuts.ts";
import { floatingMenu } from "./activity-bar.ts";
import { app } from "./context.ts";
import { historyView } from "./git-history.ts";
import { offlineRefs } from "./offline-copies.ts";
import { issueSide, issueView, toggleIssueSide } from "./wiki-edit.ts";
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
  /** 預覽分頁：點別的項目時換掉它。 */
  preview: boolean;
  /** 上次顯示時的狀態；從上次還原、還沒開過的是 null。 */
  state: IssueViewState | null;
  /** 下次開啟時怎麼重新開啟（工作項目、Wiki 頁面才有）。 */
  ref: Shortcut | null;
}

const ORIGIN_ICONS: Record<string, string> = { ado: "square-kanban", wiki: "book-open-text", github: "circle-dot", repo: "git-branch" };

let seq = 0;
const newId = () => `item-${Date.now().toString(36)}-${++seq}`;

/** 開著的項目分頁（分頁列上排在文件後面）。 */
export const itemTabs: ItemTab[] = parseSavedItemTabs(storage.load("item-tabs")).map((s) => ({
  id: newId(),
  key: s.key,
  name: s.name,
  title: s.title,
  origin: s.origin,
  icon: ORIGIN_ICONS[s.origin],
  preview: s.preview,
  state: null,
  ref: s.ref,
}));

/** 顯示中的分頁（蓋住編輯區或並排在右邊）；都沒有顯示時是 null。 */
export let shownItem: ItemTab | null = null;

/** 按右鍵的項目分頁。 */
let menuItem: ItemTab | null = null;

function persist(): void {
  const saved: SavedItemTab[] = itemTabs
    .filter((tab): tab is ItemTab & { ref: Shortcut; origin: "ado" | "wiki" } => !!tab.ref && (tab.origin === "ado" || tab.origin === "wiki"))
    .slice(0, SAVED_ITEM_TABS_LIMIT)
    .map(({ key, name, title, origin, preview, ref }) => ({ key, name, title, origin, preview, ref }));
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

/** 分頁列上的項目分頁。 */
export function itemTabInfos(): TabInfo[] {
  const side = sideShown();
  return itemTabs.map((tab) => ({
    id: tab.id,
    name: tab.name,
    title: tab.preview ? t("{title}（預覽：點別的項目會換掉這個分頁，雙擊留下來）", { title: tab.title }) : tab.title,
    dirty: false,
    item: { icon: tab.icon, origin: tab.origin, preview: tab.preview, side: side && tab === shownItem },
  }));
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
  if (!keep && shownItem && issueView.isOpen && issueView.hasFocus) return issueView.show(source);
  const place = placeItem(itemTabs, source.key, keep);
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
  const tab: ItemTab = {
    id: newId(),
    key: source.key,
    name: source.title,
    title: source.title,
    origin: source.origin.kind,
    icon: source.origin.icon,
    preview: !keep,
    state: null,
    ref: null,
  };
  // 新的分頁放在顯示中的分頁右邊（沒有顯示時放最後面）。
  const at = shownItem ? itemTabs.indexOf(shownItem) + 1 : itemTabs.length;
  itemTabs.splice(at, 0, tab);
  return showTab(tab, { source, back: [], forward: [], scroll: 0 });
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

/** 關掉項目分頁；關掉的是顯示中的分頁時，切到旁邊的分頁（並排時換上另一個項目，沒有就只留文件）。 */
export function closeItem(id: string): void {
  const tab = findItemTab(id);
  if (!tab) return;
  const order = sideShown() ? itemTabs.map((x) => x.id) : [...app.docs.map((d) => d.id), ...itemTabs.map((x) => x.id)];
  const next = neighborAfterClose(order, id);
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

/** 一次關掉好幾個分頁（不會逐一切換過去）；顯示中的也關掉時，改顯示 `then`（沒給就回到文件）。 */
function closeMany(tabs: ItemTab[], then?: ItemTab): void {
  if (!tabs.length) return;
  const shownClosed = !!shownItem && tabs.includes(shownItem);
  if (shownClosed) hideItem();
  for (const tab of tabs) itemTabs.splice(itemTabs.indexOf(tab), 1);
  if (shownClosed && then) void showTab(then);
  changed();
}

/** 關掉符合條件的項目分頁（例如刪除的 Wiki 頁面）。 */
export function closeItemsWhere(test: (key: string) => boolean): void {
  closeMany(itemTabs.filter((x) => test(x.key)));
}

/** 目前的項目分頁（Ctrl+W 用）：顯示中而且（並排時）焦點在檢視裡。 */
export function focusedItem(): ItemTab | null {
  if (!shownItem || !issueView.isOpen) return null;
  return !sideShown() || issueView.hasFocus ? shownItem : null;
}

let itemMenu: { open(at: DOMRect): void } | null = null;

/** 項目分頁的右鍵選單。 */
export function openItemMenu(id: string, at: DOMRect): void {
  menuItem = findItemTab(id) ?? null;
  if (!menuItem) return;
  itemMenu ??= floatingMenu(
    "item-tab-menu-anchor",
    [
      { label: t("關閉"), icon: "x", run: () => menuItem && closeItem(menuItem.id) },
      {
        label: t("關閉其他工作項目分頁"),
        icon: "x",
        when: () => itemTabs.length > 1,
        run: () => {
          const keep = menuItem;
          if (keep) closeMany(itemTabs.filter((x) => x !== keep), keep);
        },
      },
      { label: t("關閉所有工作項目分頁"), icon: "x", run: () => closeMany([...itemTabs]) },
      "-",
      { label: t("保留分頁"), icon: "pin", when: () => !!menuItem?.preview, run: () => menuItem && keepItem(menuItem.id) },
      {
        label: t("在文件右邊並排顯示"),
        icon: "columns-2",
        checked: () => issueSide,
        run: () => {
          const tab = menuItem;
          toggleIssueSide();
          if (tab && tab !== shownItem) void showTab(tab);
        },
      },
    ],
    () => setTimeout(() => (menuItem = null)),
  );
  itemMenu.open(at);
}
