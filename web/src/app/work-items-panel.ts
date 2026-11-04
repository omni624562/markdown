/**
 * 側邊欄的 Azure DevOps 面板：工作項目、Wiki、GitHub Issues，以及釘在上方的捷徑。
 */
import { workItemLink } from "../ado-text.ts";
import { setBounded } from "../bounded.ts";
import { type AdoWorkItem, desktop, type AdoWorkItemFilter, type AdoWiki } from "../desktop.ts";
import { t } from "../i18n.ts";
import { issueFileName, githubIssueMarkdown } from "../issue-doc.ts";
import * as storage from "../storage.ts";
import { icon } from "../ui/icons.ts";
import { type IssueSummary, type IssueGroup, type IssueTreeNode, shortDate, IssuesPanel } from "../ui/issues-panel.ts";
import { MultiSelect } from "../ui/multi-select.ts";
import { toast } from "../ui/toast.ts";
import { WikiPanel } from "../ui/wiki-panel.ts";
import { SHORTCUT_DRAG_TYPE, type Shortcut, parseShortcuts, migratePinned, isFileShortcut, isWikiShortcut, isWorkItemShortcut, placeShortcut, SHORTCUT_LIMIT, sameShortcut, shortcutInitial, shortcutHue, parseDraggedShortcut } from "../wiki-shortcuts.ts";
import { kindKey } from "../work-item-colors.ts";
import { pageName, wikiPageLink, wikiPageUrl, flattenPages, pageFromGitPath } from "../wiki-text.ts";
import { areaGroups, kindCounts, parentTree, type TreeNode } from "../workitem-groups.ts";
import { fromStateChoice, type KindStates, stateChoice, stateLabel, stateOptions, type StateOption, statesFor, workItemFilterKey } from "../work-item-filter.ts";
import { markOf } from "../workitem-seen.ts";
import { peekWorkItem, insertIssueLink } from "./ado-links.ts";
import { pingAdo } from "./ado-status.ts";
import { forgetListCopies, keepFreshness, withOfflineCopy } from "./offline-copies.ts";
import { favoriteProjects, favoriteWikis } from "./favorite-lists.ts";
import { favoritesFirst } from "../favorites.ts";
import { app } from "./context.ts";
import { openWikiRecent } from "./wiki-history.ts";
import { openWikiBacklinks } from "./wiki-backlinks.ts";
import { moveWikiPage } from "./wiki-move.ts";
import { bulkEditWorkItems } from "./work-item-bulk.ts";
import { drawFileShortcut, fileShortcut, fileShortcutShown, initFileShortcuts, openFileShortcut, syncFileShortcuts } from "./file-shortcuts.ts";
import { basename } from "../paths.ts";


// 舊版記住的 Azure DevOps 已儲存查詢（已經拿掉這個功能）。
storage.remove("workitem-query");

/**
 * 工作項目的篩選，一直顯示在面板上方：專案一整列（右邊的 × 一次清掉所有條件），下面是人與區域、類型與狀態，
 * 最後是搜尋框。
 * 選項第一次列出工作項目時才讀取；區域只在選了專案後出現，人名是團隊成員的建議（也可以自己輸入）。
 */
function workItemFilterBar(): { filters: HTMLElement; placeSearch(input: HTMLInputElement): void } {
  const bar = document.createElement("div");
  bar.className = "workitems-filters";
  bar.id = "workitem-filters";
  // 有設定條件時，專案右邊多一個「×」，一次清掉（只有這一個清除按鈕）。
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "workitems-filter-clear";
  const clearLabel = t("清除全部篩選條件（回到「指派給我、進行中」）");
  clear.title = clearLabel;
  clear.setAttribute("aria-label", clearLabel);
  clear.append(icon("x"));
  clear.addEventListener("click", () => resetAll());
  const searchBox = document.createElement("div");
  searchBox.className = "workitems-search-box";
  // 左邊的放大鏡：一眼看出這是搜尋框，不是另一個下拉選單。
  searchBox.append(icon("search"));
  /** 依目前的條件：和預設不同的條件用強調色、有條件時才有清除按鈕。 */
  const renderState = () => {
    const set = [
      !(f.role === "assigned" && f.person === "@me"),
      f.state !== "open" || f.states.length > 0,
      f.kinds.length > 0,
      f.projects.length > 0,
      f.areas.length > 0,
    ];
    // 和預設不一樣的條件，按鈕用強調色。
    [person, state, kind, project, area].forEach((m, i) => m.el.classList.toggle("chosen", set[i]));
    clear.hidden = !set.some(Boolean);
  };
  const changed = () => {
    storage.save("workitem-filter", JSON.stringify(app.workItemFilter));
    renderState();
    void workItemsPanel?.refresh();
  };
  const pairs = (values: string[]): [string, string][] => values.map((v) => [v, v]);

  // 人：指派給我、我建立的、所有人，或指定某個人（輸入名字）。
  const f = app.workItemFilter;
  const personValue = f.person === "@me" ? `${f.role}:@me` : f.person ? `${f.role}:` : "any";
  const name = document.createElement("input");
  name.type = "search";
  name.className = "workitems-person";
  name.value = f.person === "@me" ? "" : f.person;
  name.placeholder = t("輸入名字（部分即可）");
  name.setAttribute("aria-label", t("名字"));
  name.setAttribute("list", "workitem-people");
  name.hidden = !personValue.endsWith(":");
  const people = document.createElement("datalist");
  people.id = "workitem-people";
  let timer = 0;
  name.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (f.person === name.value.trim()) return;
      f.person = name.value.trim();
      changed();
    }, 500);
  });
  // 整排篩選用同一種下拉選單：人是單選（點了就套用），其他可以複選（選單關上時套用），
  // 都不勾或全部勾都等於不限。
  const person = new MultiSelect({
    label: t("人"),
    all: t("所有人"),
    single: true,
    onChange: ([v]) => {
      clearTimeout(timer);
      const [role, who] = v === "any" ? ["assigned", ""] : v.split(":");
      f.role = role as AdoWorkItemFilter["role"];
      name.hidden = !v.endsWith(":");
      f.person = who === "@me" ? "@me" : name.hidden ? "" : name.value.trim();
      if (!name.hidden) name.focus();
      changed();
    },
  });
  person.setOptions([
    ["assigned:@me", t("指派給我")],
    ["created:@me", t("我建立的")],
    ["any", t("所有人")],
    ["assigned:", t("指派給…")],
    ["created:", t("建立者是…")],
  ]);
  person.value = [personValue];
  // 狀態：選的專案、類型實際用得到的狀態（New、Active、Resolved…）；勾了所有還沒結束的就是「進行中」（見 work-item-filter.ts）。
  let states: StateOption[] = [];
  /** 各專案、類型的狀態：篩選選項讀到的（前 20 個專案），與選了的專案另外讀到的。 */
  let stateSets: KindStates[] = [];
  const projectStateSets = new Map<string, KindStates[]>();
  const state = new MultiSelect({
    label: t("狀態"),
    all: t("全部狀態"),
    summary: () => stateLabel(f),
    onChange: (v) => {
      Object.assign(f, fromStateChoice(v, states));
      // 按鈕上的文字跟著條件（例如勾回所有還沒結束的，顯示「進行中」）。
      state.value = stateChoice(f, states);
      changed();
    },
  });
  const setStates = (list: StateOption[]) => {
    states = list;
    state.setOptions(stateOptions(states));
    state.value = stateChoice(f, states);
  };
  setStates([]);
  /** 依目前選的專案、類型重新列狀態。 */
  const refreshStates = () => {
    const extra = [...projectStateSets.values()].flat().filter((s) => !stateSets.some((o) => o.project === s.project && o.kind === s.kind));
    setStates(statesFor([...stateSets, ...extra], f.projects, f.kinds));
  };
  const kind = new MultiSelect({
    label: t("類型"),
    all: t("所有類型"),
    onChange: (v) => {
      f.kinds = v;
      refreshStates();
      changed();
    },
  });
  const area = new MultiSelect({
    label: t("區域"),
    all: t("所有區域"),
    onChange: (v) => {
      f.areas = v;
      changed();
    },
  });
  area.el.classList.add("workitems-area");
  const project = new MultiSelect({
    label: t("專案"),
    all: t("所有專案"),
    onChange: (v) => {
      f.projects = v;
      // 區域跟著專案：留下還在選的專案底下的區域。
      f.areas = f.areas.filter((a) => v.some((p) => a === p || a.startsWith(`${p}\\`)));
      area.value = f.areas;
      loadScope();
      refreshStates();
      changed();
    },
  });
  project.el.classList.add("workitems-project");
  kind.value = f.kinds;
  project.value = f.projects;
  area.value = f.areas;
  /** 區域只在選了專案時出現（和人同一列）；沒有區域時人佔一整列。 */
  const showArea = (on: boolean) => {
    area.hidden = !on;
    person.el.classList.toggle("workitems-wide", !on);
  };
  showArea(f.projects.length > 0);

  /** 區域（選了專案時）與人名建議；同一個專案只讀一次。 */
  const scopes = new Map<string, Promise<{ areas: string[]; people: string[]; stateSets?: KindStates[] }>>();
  const scopeOf = (key: string) => {
    let p = scopes.get(key);
    if (!p) {
      p = desktop!.adoWorkItemScope(key || null);
      scopes.set(key, p);
      p.catch(() => scopes.delete(key));
    }
    return p;
  };
  const loadScope = () => {
    const keys = [...f.projects];
    showArea(keys.length > 0);
    if (!desktop) return;
    const now = () => keys.join("\n") === f.projects.join("\n");
    void Promise.all((keys.length ? keys : [""]).map(scopeOf))
      .then((all) => {
        if (!now()) return;
        // 區域路徑的第一層是專案本身：只選一個專案時顯示時省略，選了幾個時留著才分得出來。
        area.setOptions(all.flatMap(({ areas }, i) => areas.map((a): [string, string] => [a, keys.length === 1 ? a.slice(keys[i].length + 1) : a])));
        // 「依區域分組」的組照這個順序排（順序變了才重畫）。
        const order = all.flatMap(({ areas }) => areas);
        if (order.join("\n") !== workItemAreaOrder.join("\n")) {
          workItemAreaOrder = order;
          workItemsPanel?.rearrange();
        }
        const names = [...new Set(all.flatMap((s) => s.people))].sort((a, b) => a.localeCompare(b));
        people.replaceChildren(...names.map((n) => new Option(n)));
        // 選的專案不在篩選選項讀到的前 20 個裡時，狀態從這裡補。
        keys.forEach((k, i) => projectStateSets.set(k, all[i].stateSets ?? []));
        if (keys.length) refreshStates();
      })
      .catch(() => {});
  };
  let loaded = false;
  app.loadWorkItemFilterOptions = () => {
    if (loaded || !desktop) return;
    loaded = true;
    loadScope();
    void desktop
      .adoWorkItemFilters()
      .then(({ projects, kinds, stateSets: sets }) => {
        kind.setOptions(pairs(kinds));
        stateSets = sets ?? [];
        refreshStates();
        // 常用的專案（工作板、Wiki 旁的星號勾選）排在前面。
        project.setOptions(favoritesFirst(pairs(projects), favoriteProjects.load()));
      })
      .catch(() => (loaded = false));
  };
  /** 清掉全部條件，回到預設（指派給我、進行中）。 */
  const resetAll = () => {
    clearTimeout(timer);
    Object.assign(f, app.DEFAULT_WORK_ITEM_FILTER);
    person.value = ["assigned:@me"];
    name.hidden = true;
    name.value = "";
    kind.value = [];
    project.value = [];
    area.value = [];
    loadScope();
    refreshStates();
    changed();
  };
  // 專案在最上面一整列（區域、狀態都看選的專案），右邊是清掉全部條件的 ×；下面是人與區域（輸入名字的框在這列下面）、
  // 類型與狀態，最後是搜尋框。
  const top = document.createElement("div");
  top.className = "workitems-filter-top";
  top.append(project.el, clear);
  bar.append(top, person.el, area.el, name, kind.el, state.el, searchBox, people);
  renderState();
  return {
    filters: bar,
    placeSearch: (input) => searchBox.append(input),
  };
}

/** 「依上層項目分組」：每個工作項目的上層（null 是沒有）與讀到的上層項目；讀過的不再讀。 */
const workItemParentOf = new Map<number, number | null>();
/** 目前清單上的工作項目（分組標題列上另外讀來的上層項目不算）。 */
let workItemListed = new Set<number>();
const workItemParentItems = new Map<number, AdoWorkItem & IssueSummary>();
let workItemParentsLoading = false;

/** 清單最多幾個工作項目（後端只取最近更新的這麼多個，見 ado_work_items）。 */
const WORK_ITEM_LIMIT = 100;
/**
 * 「依上層項目分組」補齊的子項目（上層 → 子項目）：清單只有最近更新的 100 個，比較早更新的子項目
 * 不在清單上，組裡就會比上層項目實際的子項目少；另外依目前的搜尋與篩選讀上層底下的子項目補進組裡。
 */
const workItemChildren = new Map<number, (AdoWorkItem & IssueSummary)[]>();
/** 讀子項目用的搜尋與篩選；「只看這些」時是 null（不補）。 */
let workItemChildScope: { search: string; filter: AdoWorkItemFilter } | null = null;
/** 每次重新讀清單就換一代，舊的子項目結果不用。 */
let workItemChildGen = 0;
let workItemChildrenLoading: number | null = null;

/** 清單重新讀取時：子項目跟著重讀（`scope` 是 null 時不補）。 */
function resetWorkItemChildren(scope: { search: string; filter: AdoWorkItemFilter } | null): void {
  workItemChildScope = scope;
  workItemChildGen++;
  workItemChildren.clear();
}

/** 組裡要補上的子項目（不在清單上的）；還沒讀過的上層在背景讀，讀到後重畫。 */
function moreChildren(items: (AdoWorkItem & IssueSummary)[]): (AdoWorkItem & IssueSummary)[] {
  const scope = workItemChildScope;
  if (!scope || !desktop) return [];
  const parents = [...new Set(items.map((w) => workItemParentOf.get(w.id)).filter((p): p is number => p != null))];
  const missing = parents.filter((p) => !workItemChildren.has(p));
  if (missing.length && workItemChildrenLoading !== workItemChildGen) {
    const gen = (workItemChildrenLoading = workItemChildGen);
    void desktop
      .adoWorkItemChildren(missing, scope.search, scope.filter)
      .then(({ links, items: found }) => {
        if (gen !== workItemChildGen) return;
        const byId = new Map(found.map((w) => [w.id, w]));
        for (const p of missing) workItemChildren.set(p, []);
        for (const [child, parent] of links) {
          const w = byId.get(child);
          if (!w) continue;
          workItemParentOf.set(child, parent);
          workItemChildren.get(parent)?.push(workItemRow(w));
        }
      })
      // 讀不到（例如舊版伺服器不支援連結查詢）：組裡就只有清單上的，不另外提示。
      .catch(() => {
        if (gen === workItemChildGen) for (const p of missing) workItemChildren.set(p, []);
      })
      .finally(() => {
        if (workItemChildrenLoading === gen) workItemChildrenLoading = null;
        workItemsPanel?.rearrange();
      });
  }
  const seen = new Set(items.map((w) => w.id));
  const out: (AdoWorkItem & IssueSummary)[] = [];
  for (const p of parents) {
    for (const w of workItemChildren.get(p) ?? []) {
      if (seen.has(w.id)) continue;
      seen.add(w.id);
      out.push(w);
    }
  }
  // 樹裡依編號排，這裡不用排。
  return out;
}

/** 還沒讀過上層的項目在背景讀（一次讀一批），讀到後重畫；上層的上層也這樣一層一層往上讀。 */
function loadWorkItemParents(ids: number[]): void {
  if (workItemParentsLoading || !desktop || !ids.length) return;
  workItemParentsLoading = true;
  void desktop
    .adoWorkItemParents(ids)
    .then(({ links, parents }) => {
      for (const id of ids) workItemParentOf.set(id, null);
      for (const [id, parent] of links) workItemParentOf.set(id, parent);
      for (const p of parents) setBounded(workItemParentItems, p.id, workItemRow(p), app.CACHE_MAX);
    })
    .catch((e) => {
      // 讀不到就當成都沒有上層（不要一直重試）。
      for (const id of ids) workItemParentOf.set(id, null);
      app.reportError(e);
    })
    .finally(() => {
      workItemParentsLoading = false;
      workItemsPanel?.rearrange();
    });
}

/**
 * 「依上層項目分組」：排成樹（Epic → Feature → Story → Task），每一項只出現一次。
 * 清單上的項目的上層還沒讀到時先照原本的順序顯示；上層的上層讀到一層就重畫一次。
 */
function groupByParentItems(items: (AdoWorkItem & IssueSummary)[]): IssueGroup<AdoWorkItem & IssueSummary>[] {
  const missing = items.map((w) => w.id).filter((id) => !workItemParentOf.has(id));
  if (missing.length) {
    loadWorkItemParents(missing);
    return [{ title: null, items }];
  }
  const extra = moreChildren(items);
  const all = extra.length ? [...items, ...extra] : items;
  // 沿著上層往上走，走到還沒讀過上層的項目就在背景讀（讀過的不再讀）。
  const ids = new Set(all.map((w) => w.id));
  const ancestors = new Set<number>();
  for (const w of all) {
    const seen = new Set<number>();
    for (let p = workItemParentOf.get(w.id); p != null && !seen.has(p) && (ids.has(p) || workItemParentItems.has(p)); p = workItemParentOf.get(p)) {
      seen.add(p);
      if (!workItemParentOf.has(p)) {
        ancestors.add(p);
        break;
      }
    }
  }
  loadWorkItemParents([...ancestors]);
  const roots = parentTree(all, workItemParentOf, workItemParentItems);
  const toNode = (n: TreeNode<AdoWorkItem & IssueSummary>): IssueTreeNode<AdoWorkItem & IssueSummary> => ({
    item: n.item,
    dim: n.dim,
    summary: n.children.length
      ? kindCounts(n)
          .map(([kind, count]) => t("{n} 個 {kind}", { n: count, kind }))
          .join(t("・"))
      : undefined,
    children: n.children.map(toNode),
  });
  // 沒有上層的項目也是樹的最上層（例如 Epic 底下的都不在清單上），不另外分「沒有上層」一組。
  return [{ title: null, items: [], tree: roots.map(toNode) }];
}

/** 區域下拉選單列出的順序（「依區域分組」的組照這個順序）；還沒讀到時是空的。 */
let workItemAreaOrder: string[] = [];

/**
 * 「依區域分組」：篩選選了區域時一個區域一組（照下拉選單的順序），在子區域的項目列上標出子區域（例如 ITA 那一組裡的「監控」，
 * 滑鼠移上去看完整的區域）；沒選區域時依專案底下的第一層區域分組。
 * 沒有區域的（更新前存下的離線副本）放在最後的「其他」，重新整理後就會分好。
 */
function groupByArea(items: (AdoWorkItem & IssueSummary)[]): IssueGroup<AdoWorkItem & IssueSummary>[] {
  return areaGroups(items, app.workItemFilter.areas, workItemAreaOrder).map((g) => ({
    // 區域可能就叫「其他」：收合用路徑分開。
    key: g.area === null ? "none" : `area:${g.area.toLowerCase()}`,
    title: g.title ?? t("其他"),
    items: g.items.map(({ item, sub }) =>
      sub ? { ...item, note: sub, noteTitle: t("區域：{area}", { area: (item.area ?? "").split("\\").join(" › ") }) } : item,
    ),
  }));
}

/** 清單上的一列：上面一行是類型、編號、指派對象與更新日期，狀態在右邊（`kind`、`state` 由清單上色）。 */
function workItemRow(w: AdoWorkItem): AdoWorkItem & IssueSummary {
  return {
    ...w,
    meta: [`${w.kind} ${w.id}`, app.showAssignee() ? w.assignedTo : "", shortDate(w.changed)].filter(Boolean).join("・"),
  };
}

export // 在 init 時建立。
let workItemsPanel: IssuesPanel<AdoWorkItem & IssueSummary> | null;

/** 左側圖示列上的捷徑：常看的 Wiki 頁面、工作項目、本機的檔案（從清單、檔案樹拖過去，或用圖釘、分頁的右鍵選單放上去）。 */
export let barShortcuts: Shortcut[] = loadBarShortcuts();
/** 正在從 Wiki、工作項目清單、檔案樹或分頁拖曳（圖示列上顯示放置區）。 */
let shortcutDragging = false;
export const shortcutBar = document.createElement("div");
const shortcutDrop = document.createElement("div");

function loadBarShortcuts(): Shortcut[] {
  const raw = storage.load("wiki-shortcuts");
  if (raw !== null) return parseShortcuts(raw);
  // 第一次：舊版每個 Wiki 各自的「已釘選」搬到圖示列。
  const prefix = "ado-wiki-pages:";
  const lists = storage.keys(prefix).map((key) => {
    try {
      const v = JSON.parse(storage.load(key) ?? "{}") as { pinned?: unknown };
      const pinned = Array.isArray(v.pinned) ? v.pinned.filter((p): p is string => typeof p === "string") : [];
      return { wiki: key.slice(prefix.length), pinned };
    } catch {
      return { wiki: key.slice(prefix.length), pinned: [] };
    }
  });
  const list = migratePinned(lists);
  storage.save("wiki-shortcuts", JSON.stringify(list));
  return list;
}

export function setBarShortcuts(list: Shortcut[]): void {
  barShortcuts = list;
  storage.save("wiki-shortcuts", JSON.stringify(list));
  renderBarShortcuts();
  wikiPanel?.refreshPins();
  syncFileShortcuts();
}

/** 捷徑的名稱（提示訊息、滑鼠提示用）。 */
export function shortcutName(item: Shortcut): string {
  if (isFileShortcut(item)) return basename(item.file);
  return isWorkItemShortcut(item) ? t("{kind} {id}：{title}", { kind: item.kind, id: item.workItem, title: item.title }) : pageName(item.path);
}

/** 捷徑的內容正開在中間（工作項目、Wiki 頁面和 `issueKey` 比對；檔案看目前的文件）。 */
function shortcutShown(item: Shortcut): boolean {
  if (isFileShortcut(item)) return fileShortcutShown(item);
  return app.issueKey === (isWorkItemShortcut(item) ? `ado:${item.workItem}` : `wiki:${item.wiki}:${item.path}`);
}

/** 放到圖示列（`index` 是位置，沒給放最後面）；已經有的移過去。 */
export function addBarShortcut(item: Shortcut, index?: number): void {
  const next = placeShortcut(barShortcuts, item, index);
  if (!next) {
    toast(t("左側圖示列最多放 {n} 個捷徑，先移除一些再加。", { n: SHORTCUT_LIMIT }), { tone: "error" });
    return;
  }
  const added = !barShortcuts.some((s) => sameShortcut(s, item));
  setBarShortcuts(next);
  if (added) toast(t("已把「{name}」放到左側圖示列：點一下開啟，右鍵可以移除。", { name: shortcutName(item) }), { tone: "success" });
}

export function removeBarShortcut(item: Shortcut): void {
  setBarShortcuts(barShortcuts.filter((s) => !sameShortcut(s, item)));
}

/** 工作項目放到圖示列，或從圖示列移除。 */
export function toggleWorkItemShortcut(w: AdoWorkItem): void {
  const item = { workItem: w.id, kind: w.kind, title: w.title };
  if (barShortcuts.some((s) => sameShortcut(s, item))) removeBarShortcut(item);
  else addBarShortcut(item);
}

export function toggleWikiShortcut(wiki: AdoWiki, path: string): void {
  const item = { wiki: wiki.id, wikiName: wiki.name, path };
  if (barShortcuts.some((s) => sameShortcut(s, item))) removeBarShortcut(item);
  else addBarShortcut(item);
}

export async function openBarShortcut(item: Shortcut): Promise<boolean> {
  if (!desktop) return false;
  if (isFileShortcut(item)) return openFileShortcut(item);
  if (isWorkItemShortcut(item)) {
    let w: AdoWorkItem;
    try {
      w = await peekWorkItem(item.workItem);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      toast(t("讀不到工作項目 {id}：{error}。在捷徑上按右鍵可以移除。", { id: item.workItem, error }), { tone: "error" });
      return false;
    }
    // 標題、類型改了就更新圖示。
    if (w.title !== item.title || w.kind !== item.kind)
      setBarShortcuts(barShortcuts.map((s) => (sameShortcut(s, item) ? { workItem: w.id, kind: w.kind, title: w.title } : s)));
    app.showWorkItem(w);
    return true;
  }
  const wikis = await withOfflineCopy("wikis", () => desktop!.adoWikis());
  const wiki = wikis.find((w) => w.id === item.wiki);
  if (!wiki) {
    toast(t("找不到這個 Wiki（可能已經刪除或沒有權限），在捷徑上按右鍵可以移除。"), { tone: "error" });
    return false;
  }
  // 舊的釘選搬過來時不知道 Wiki 名稱，開啟時補上（滑鼠提示用）。
  if (item.wikiName !== wiki.name) setBarShortcuts(barShortcuts.map((s) => (sameShortcut(s, item) ? { ...s, wikiName: wiki.name } : s)));
  app.showWikiPage(wiki, item.path);
  return true;
}

/**
 * 在左側圖示列按了捷徑：開啟後側邊欄換到對應的面板（工作項目、Wiki），
 * 和按面板圖示一樣看得到它在清單、樹上的位置（開啟時已經標出來）。側邊欄收起來時不打開。
 */
export async function openShortcutFromBar(item: Shortcut): Promise<void> {
  if (await openBarShortcut(item)) showShortcutPanel(item);
}

function showShortcutPanel(item: Shortcut): void {
  // 檔案：側邊欄維持原樣（檔案常不在目前的資料夾裡，換到檔案面板也看不到它）。
  if (isFileShortcut(item)) return;
  const panel = isWorkItemShortcut(item) ? "workitems" : "wiki";
  // Wiki 放在右側、右側欄收起來時，和左邊的側邊欄收起來一樣不自己打開。
  if (panel === "wiki" && app.wikiPlacedRight() && !app.rightOutlineShown) return;
  app.showPanel(panel, false);
}

function renderBarShortcuts(): void {
  const buttons = barShortcuts.map((item, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "activity-btn activity-wiki-page";
    b.dataset.index = String(i);
    b.draggable = true;
    if (shortcutShown(item)) b.setAttribute("aria-current", "page");
    const badge = document.createElement("span");
    badge.className = "wiki-badge";
    if (isFileShortcut(item)) {
      drawFileShortcut(b, badge, item);
    } else if (isWorkItemShortcut(item)) {
      // 工作項目：整塊塗上類型的顏色，字取標題。
      const name = shortcutName(item);
      b.title = name;
      b.setAttribute("aria-label", name);
      badge.classList.add("workitem-badge");
      badge.dataset.wiKind = kindKey(item.kind);
      badge.textContent = shortcutInitial(item.title);
    } else {
      const name = pageName(item.path);
      const where = [item.wikiName, ...item.path.slice(1).split("/").slice(0, -1)].filter(Boolean).join(" › ");
      b.title = where ? `${name}\n${where}` : name;
      b.setAttribute("aria-label", name);
      badge.style.setProperty("--hue", String(shortcutHue(`${item.wiki}:${item.path}`)));
      badge.textContent = shortcutInitial(name);
    }
    b.prepend(badge);
    b.addEventListener("click", () => {
      // 開著的那一個再按一次：捲回最上面（不要「按了沒反應」）。
      if (!isFileShortcut(item) && b.getAttribute("aria-current") === "page" && app.issueView.isOpen) {
        app.issueView.scrollToTop();
        showShortcutPanel(item);
        return;
      }
      void openShortcutFromBar(item).catch(app.reportError);
    });
    return b;
  });
  shortcutDrop.classList.remove("over");
  shortcutDrop.hidden = !shortcutDragging;
  shortcutBar.classList.toggle("dropping", shortcutDragging);
  shortcutBar.replaceChildren(...buttons, shortcutDrop);
  shortcutBar.hidden = !desktop || (!barShortcuts.length && !shortcutDragging);
}

/** 目前開著的頁面在圖示列上標出來。 */
export function markBarShortcuts(): void {
  for (const b of shortcutBar.querySelectorAll<HTMLElement>(".activity-wiki-page")) {
    const item = barShortcuts[Number(b.dataset.index)];
    const on = !!item && shortcutShown(item);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
}
// 整條圖示列都可以放（包含下面的空白處），放置區跟著滑鼠移到要插入的位置。
// 在 init 時建立。
let activityBar: HTMLElement;
const carriesShortcut = (e: DragEvent) => !!e.dataTransfer?.types.includes(SHORTCUT_DRAG_TYPE);
const shortcutDragOver = (e: DragEvent) => {
  if (!carriesShortcut(e)) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = "copy";
  if (shortcutBar.hidden || shortcutDrop.hidden) {
    shortcutDragging = true;
    renderBarShortcuts();
  }
  shortcutDrop.classList.add("over");
  // 在哪個捷徑的上半就插在它前面；在所有捷徑下面（或圖示列其他地方）就放最後面。
  const target = [...shortcutBar.querySelectorAll<HTMLElement>(".activity-wiki-page")].find((b) => {
    const r = b.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 && e.clientY >= shortcutBar.getBoundingClientRect().top;
  });
  if (target) {
    if (shortcutDrop.nextSibling !== target) shortcutBar.insertBefore(shortcutDrop, target);
  } else if (shortcutBar.lastChild !== shortcutDrop) shortcutBar.append(shortcutDrop);
};

/** Azure DevOps 的 Wiki：選一個 Wiki，看頁面樹狀目錄，點頁面在主要區域開啟（唯讀）。 */
export // 在 init 時建立。
let wikiPanel: WikiPanel<AdoWiki> | null;

/** GitHub Issues：目前開啟的資料夾連到 GitHub、而且已經登入時才顯示。 */
export // 在 init 時建立。
let issuesPanel: IssuesPanel<IssueSummary> | null;

export let issuesRepo: string | null = null;
export async function renderIssuesTab(): Promise<void> {
  const repo = desktop && app.github?.account ? await desktop.githubWorkspaceRepo().catch(() => null) : null;
  if (repo !== issuesRepo) {
    issuesRepo = repo;
    issuesPanel?.reset();
    if (app.sidePanel === "issues" && repo) issuesPanel?.shown();
  }
  const tab = app.$("#side-tab-issues");
  tab.hidden = !repo;
  tab.title = repo ? t("Issues（{repo}）", { repo }) : "Issues";
  if (tab.hidden) app.panelUnavailable("issues");
  else app.panelAvailable("issues");
}

/** 連線到 Azure DevOps 後才顯示「工作項目」「Wiki」圖示。 */
export function renderAdoTab(): void {
  for (const panel of ["workitems", "board", "wiki"] as const) {
    const tab = app.$(`#side-tab-${panel}`);
    tab.hidden = !app.ado?.account;
    if (tab.hidden) app.panelUnavailable(panel);
    else app.panelAvailable(panel);
  }
  // Wiki 放在右側的：連線或中斷時放上去或拿下來。
  app.applyLayout();
  void pingAdo();
  if (app.ado?.account) void app.pollWorkItems();
  else {
    app.pollItems = [];
    app.renderAdoBadge();
  }
}

/** 「只看這些」：清單只列圖示上的數字算的那些。 */
let onlyUnseen = false;
const unseenLine = document.createElement("div");

/** 指派給你、還沒結束的工作項目裡，新的或看過之後有更新的（圖示上的數字）。 */
export function unseenItems(): AdoWorkItem[] {
  return app.pollItems.filter((w) => markOf(app.workItemSeen, w));
}

function showOnlyUnseen(on: boolean): void {
  onlyUnseen = on;
  renderUnseenLine();
  void workItemsPanel?.refresh();
}

/** 清單上方的「指派給你的有 N 個新的或有更新・只看這些・全部標示為看過」。 */
export function renderUnseenLine(): void {
  if (!workItemsPanel) return;
  const n = unseenItems().length;
  unseenLine.hidden = !onlyUnseen && !n;
  if (unseenLine.hidden) return;
  const link = (text: string, run: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "workitems-unseen-action";
    b.textContent = text;
    b.addEventListener("click", run);
    return b;
  };
  const text = document.createElement("span");
  if (onlyUnseen) {
    text.textContent = t("只列出新的或有更新的（{n}）", { n });
    unseenLine.replaceChildren(text, link(t("顯示完整清單"), () => showOnlyUnseen(false)));
    return;
  }
  text.textContent = t("指派給你的工作項目有 {n} 個新的或有更新", { n });
  unseenLine.replaceChildren(
    text,
    link(t("只看這些"), () => showOnlyUnseen(true)),
    link(t("全部標示為看過"), () => app.commands.run("workitems-mark-all-seen")),
  );
}

export function initWorkItemsPanel(): void {
  workItemsPanel = desktop
    ? new IssuesPanel<AdoWorkItem & IssueSummary>(app.$("#workitems-host"), {
        placeholder: t("搜尋標題、內容或 #編號"),
        arrangements: [
          // 伺服器回傳的順序就是最近更新的在前面。
          { id: "recent", label: t("最近更新"), arrange: (items) => [{ title: null, items }] },
          {
            id: "priority",
            label: t("優先順序"),
            arrange: (items) => [{ title: null, items: [...items].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)) }],
          },
          { id: "state", label: t("依狀態分組"), arrange: (items) => app.groupItems(items, (w) => w.state) },
          { id: "parent", label: t("依上層項目分組"), arrange: (items) => groupByParentItems(items) },
          { id: "kind", label: t("依類型分組"), arrange: (items) => app.groupItems(items, (w) => w.kind) },
          { id: "area", label: t("依區域分組"), arrange: (items) => groupByArea(items) },
        ],
        arrangement: {
          load: () => storage.load("workitem-arrange"),
          save: (id) => storage.save("workitem-arrange", id),
        },
        mark: (item) => {
          // 分組標題列上、不在清單裡的上層項目（不是指派給你的）不標。
          if (!workItemListed.has(item.id)) return null;
          const mark = markOf(app.workItemSeen, item);
          if (!mark) return null;
          return { kind: mark, label: mark === "new" ? t("新指派給你，還沒看過") : t("上次看過之後有更新") };
        },
        link: (item) => workItemLink(item),
        // 拖到左側圖示列變成捷徑（例如常看的 User Story、Feature）。
        dragData: (item) => ({ [SHORTCUT_DRAG_TYPE]: JSON.stringify({ workItem: item.id, kind: item.kind, title: item.title }) }),
        ...workItemFilterBar(),
        list: async (search, update) => {
          app.loadWorkItemFilterOptions();
          // 「只看這些」：圖示上的數字算的那些（指派給你、新的或有更新的），不用再讀一次。
          resetWorkItemChildren(onlyUnseen && !search ? null : { search, filter: { ...app.workItemFilter } });
          if (onlyUnseen && !search) {
            const items = unseenItems();
            workItemListed = new Set(items.map((w) => w.id));
            return items.map(workItemRow);
          }
          // 有副本就先顯示（不用等伺服器），背景讀完再換上新的。
          const found = await withOfflineCopy(`wi-list:${search}:${workItemFilterKey(app.workItemFilter)}`, () => desktop!.adoWorkItems(search, app.workItemFilter), update);
          app.noteWorkItems(found, !search && app.isDefaultFilter());
          workItemListed = new Set(found.map((w) => w.id));
          return keepFreshness(found, found.map(workItemRow));
        },
        forget: () => forgetListCopies("wi-"),
        view: (item) => app.showWorkItem(item),
        // 選了好幾個一起改狀態、指派、優先順序、Sprint，或一起加留言。
        bulk: { run: (items) => bulkEditWorkItems(items, () => workItemsPanel?.clearSelection()) },
        status: (n, search) =>
          onlyUnseen && !search
            ? n
              ? t("{n} 個指派給你、新的或有更新的工作項目", { n })
              : t("指派給你的工作項目都看過了")
            : n
            ? search
              ? t("找到 {n} 個工作項目", { n })
              : app.isDefaultFilter()
                ? t("{n} 個指派給你、還沒結束的工作項目", { n })
                : n >= WORK_ITEM_LIMIT
                  ? t("{n} 個符合篩選條件的工作項目（只列最近更新的）", { n })
                  : t("{n} 個符合篩選條件的工作項目", { n })
            : search
              ? t("找不到符合的工作項目")
              : app.isDefaultFilter()
                ? t("目前沒有指派給你、還沒結束的工作項目")
                : t("沒有符合篩選條件的工作項目"),
      })
    : null;
  if (workItemsPanel) {
    unseenLine.className = "workitems-unseen";
    unseenLine.hidden = true;
    app.$("#workitem-filters").after(unseenLine);
  }
  shortcutBar.className = "activity-wiki";
  shortcutBar.setAttribute("role", "toolbar");
  shortcutBar.setAttribute("aria-label", t("捷徑"));
  shortcutBar.setAttribute("aria-orientation", "vertical");
  shortcutBar.hidden = true;
  shortcutDrop.className = "activity-wiki-drop";
  shortcutDrop.title = t("放到這裡，變成圖示列上的捷徑");
  shortcutDrop.append(icon("plus"));
  app.$(".activity-cmds").after(shortcutBar);
  // 從 Wiki、工作項目清單、檔案樹、文件的分頁拖曳時（帶著捷徑的資料），圖示列上出現放置區；放下就變成捷徑。
  document.addEventListener("dragstart", (e) => {
    if (e.defaultPrevented || !e.dataTransfer?.types.includes(SHORTCUT_DRAG_TYPE)) return;
    shortcutDragging = true;
    // 等瀏覽器取完拖曳的畫面再改版面。
    requestAnimationFrame(() => renderBarShortcuts());
  });
  document.addEventListener("dragend", () => {
    if (!shortcutDragging) return;
    shortcutDragging = false;
    renderBarShortcuts();
  });
  activityBar = app.$(".activity-bar");
  activityBar.addEventListener("dragenter", shortcutDragOver);
  activityBar.addEventListener("dragover", shortcutDragOver);
  activityBar.addEventListener("dragleave", (e) => {
    if (!activityBar.contains(e.relatedTarget as Node)) shortcutDrop.classList.remove("over");
  });
  activityBar.addEventListener("drop", (e) => {
    const item = carriesShortcut(e) ? parseDraggedShortcut(e.dataTransfer!.getData(SHORTCUT_DRAG_TYPE)) : null;
    // 檔案只收這台電腦上的（網頁版、遠端資料夾的檔案不能放）。
    if (!item || (isFileShortcut(item) && !fileShortcut(item.file))) return;
    e.preventDefault();
    const index = [...shortcutBar.querySelectorAll(".activity-wiki-page, .activity-wiki-drop")].indexOf(shortcutDrop);
    shortcutDragging = false;
    addBarShortcut(item, index < 0 ? undefined : index);
  });
  renderBarShortcuts();
  initFileShortcuts();
  wikiPanel = desktop
    ? new WikiPanel<AdoWiki>(app.$("#wiki-host"), {
        // 有副本就先顯示（不用等伺服器），背景讀完再換上新的。
        wikis: (update) => withOfflineCopy("wikis", () => desktop!.adoWikis(), update),
        pages: (wiki, update) => withOfflineCopy(`wiki-pages:${wiki.id}`, () => desktop!.adoWikiPages(wiki), update),
        forget: () => forgetListCopies("wiki"),
        favorites: favoriteWikis,
        open: (wiki, path) => app.showWikiPage(wiki, path),
        load: () => storage.load("ado-wiki"),
        save: (id) => storage.save("ado-wiki", id),
        prefs(id) {
          const paths = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : []);
          try {
            const v = JSON.parse(storage.load(`ado-wiki-pages:${id}`) ?? "{}") as Record<string, unknown>;
            return { pinned: paths(v.pinned), shown: paths(v.shown), root: typeof v.root === "string" ? v.root : undefined };
          } catch {
            return { pinned: [] };
          }
        },
        savePrefs: (id, prefs) => storage.save(`ado-wiki-pages:${id}`, JSON.stringify(prefs)),
        link: (wiki, path) => (wiki.webUrl ? wikiPageLink(pageName(path), wikiPageUrl(wiki.webUrl, path)) : null),
        create: (wiki, parent) => void app.createWikiPage(wiki, parent).catch(app.reportError),
        recent: (wiki, scope) => openWikiRecent(wiki, scope),
        backlinks: (wiki, path) => void openWikiBacklinks(wiki, path).catch(app.reportError),
        move: (wiki, path, to) => void moveWikiPage(wiki, path, to).catch(app.reportError),
        canCreate: (wiki) => !wiki.code,
        async reorder(wiki, path, index) {
          try {
            await desktop!.adoWikiMove(wiki, path, path, index);
          } catch (e) {
            app.reportError(e);
            throw e;
          }
          // 下次讀頁面樹時向伺服器讀新的順序。
          forgetListCopies("wiki");
        },
        // 釘選＝放到左側圖示列；拖曳頁面到圖示列也可以。
        pins: {
          has: (wiki, path) => barShortcuts.some((s) => isWikiShortcut(s) && s.wiki === wiki.id && s.path === path),
          toggle: (wiki, path) => toggleWikiShortcut(wiki, path),
          labels: [t("放到左側圖示列"), t("從左側圖示列移除")],
        },
        dragData: (wiki, path) => ({ [SHORTCUT_DRAG_TYPE]: JSON.stringify({ wiki: wiki.id, wikiName: wiki.name, path }) }),
        async searchContent(wiki, text) {
          const found = await desktop!.adoWikiSearch(wiki, text);
          const pages = flattenPages(wikiPanel?.pages ?? []);
          const seen = new Set<string>();
          const results: { path: string; snippet: string }[] = [];
          for (const r of found.results) {
            const path = pageFromGitPath(r.path, wiki.mappedPath, pages);
            if (path && !seen.has(path)) {
              seen.add(path);
              results.push({ path, snippet: r.snippet });
            }
          }
          return { available: found.available, results };
        },
      })
    : null;
  issuesPanel = desktop
    ? new IssuesPanel(app.$("#issues-host"), {
        placeholder: t("搜尋 issue，或輸入編號"),
        link: (item) => workItemLink(item),
        list: async (search) =>
          (await desktop!.githubIssues(search)).map((i) => ({
            ...i,
            id: i.number,
            // 已關閉的才標狀態（清單預設只列開啟中的）。
            state: i.state === "closed" ? t("已關閉") : "",
            meta: [
              `#${i.number}`,
              i.labels.join(t("、")),
              i.comments ? t("{n} 則留言", { n: i.comments }) : "",
              shortDate(i.updated),
            ]
              .filter(Boolean)
              .join("・"),
          })),
        view: (item) =>
          void app.showIssue({
            key: `github:${item.id}`,
            origin: { kind: "github", icon: "circle-dot", text: "GitHub Issue" },
            label: `#${item.id}`,
            title: item.title,
            webUrl: item.webUrl,
            fileName: issueFileName(`#${item.id}`, item.title),
            load: async () => githubIssueMarkdown(await desktop!.githubIssue(item.id)),
            insertLink: () => insertIssueLink(item),
          }),
        status: (n, search) =>
          n
            ? search
              ? t("找到 {n} 個 issue", { n })
              : t("還沒關閉的 issue（{n}）", { n })
            : search
              ? t("找不到符合的 issue")
              : t("目前沒有還沒關閉的 issue"),
      })
    : null;
  app.$("#issues-refresh").addEventListener("click", () => void issuesPanel?.refresh());
}
