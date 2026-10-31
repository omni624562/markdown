/**
 * 側邊欄的 Azure DevOps 面板：工作項目（含 TFS 的已儲存查詢）、Wiki、GitHub Issues，以及釘在上方的捷徑。
 */
import { workItemLink } from "../ado-text.ts";
import { setBounded } from "../bounded.ts";
import { type AdoSavedQuery, type AdoWorkItem, desktop, type AdoWorkItemFilter, type AdoWiki } from "../desktop.ts";
import { t } from "../i18n.ts";
import { issueFileName, githubIssueMarkdown } from "../issue-doc.ts";
import * as storage from "../storage.ts";
import { icon } from "../ui/icons.ts";
import { type IssueSummary, type IssueGroup, shortDate, IssuesPanel } from "../ui/issues-panel.ts";
import { MultiSelect } from "../ui/multi-select.ts";
import { Picker } from "../ui/picker.ts";
import { toast } from "../ui/toast.ts";
import { WikiPanel } from "../ui/wiki-panel.ts";
import { SHORTCUT_DRAG_TYPE, type Shortcut, parseShortcuts, migratePinned, isWorkItemShortcut, placeShortcut, SHORTCUT_LIMIT, sameShortcut, workItemHue, shortcutInitial, shortcutHue, parseDraggedShortcut } from "../wiki-shortcuts.ts";
import { pageName, wikiPageLink, wikiPageUrl, flattenPages, pageFromGitPath } from "../wiki-text.ts";
import { groupByParent } from "../workitem-groups.ts";
import { markOf } from "../workitem-seen.ts";
import { peekWorkItem, insertIssueLink } from "./ado-links.ts";
import { pingAdo } from "./ado-status.ts";
import { withOfflineCopy } from "./offline-copies.ts";
import { app } from "./context.ts";


/** 目前列出的查詢（null 是用篩選條件）。 */
let workItemQuery: AdoSavedQuery | null = (() => {
  try {
    const v = JSON.parse(storage.load("workitem-query") ?? "null") as AdoSavedQuery | null;
    return v && typeof v.id === "string" && typeof v.project === "string" ? v : null;
  } catch {
    return null;
  }
})();
/** 篩選列建好後設定：更新按鈕上的數字並重新列出。 */
let workItemFilterChanged: () => void = () => {};

function setWorkItemQuery(q: AdoSavedQuery | null, refresh = true): void {
  workItemQuery = q;
  if (q) storage.save("workitem-query", JSON.stringify(q));
  else storage.remove("workitem-query");
  if (refresh) workItemFilterChanged();
}

/** 查詢結果裡再用搜尋框的文字（標題或編號）縮小範圍。 */
function filterQueryResult(items: AdoWorkItem[], search: string): AdoWorkItem[] {
  const q = search.trim().replace(/^#/, "").toLowerCase();
  return q ? items.filter((w) => String(w.id).startsWith(q) || w.title.toLowerCase().includes(q)) : items;
}

let savedQueries: Promise<AdoSavedQuery[]> | null = null;
type QueryChoice = AdoSavedQuery | { clear: true };

const queryPicker = new Picker<QueryChoice>({
  label: t("TFS 的已儲存查詢"),
  placeholder: t("輸入查詢名稱或資料夾"),
  empty: t("找不到已儲存的查詢（可以在 TFS 網頁版的「查詢」建立）"),
  async query(text) {
    if (!desktop) return [];
    if (!savedQueries) {
      savedQueries = desktop.adoQueries();
      savedQueries.catch(() => (savedQueries = null));
    }
    const needle = text.trim().toLowerCase();
    const all = await savedQueries;
    const found = needle ? all.filter((q) => `${q.name} ${q.folder} ${q.project}`.toLowerCase().includes(needle)) : all;
    return workItemQuery && !needle ? [{ clear: true }, ...found] : found;
  },
  render: (q) =>
    "clear" in q
      ? { title: t("不用查詢，回到篩選條件"), detail: t("目前：{name}", { name: workItemQuery?.name ?? "" }), icon: "x" }
      : { title: q.name, detail: [q.project, q.folder].filter(Boolean).join(" › "), icon: "scroll-text" },
  pick: (q) => setWorkItemQuery("clear" in q ? null : q),
});

/**
 * 工作項目的篩選列：人（指派給、建立者）、狀態、類型、專案、區域。
 * 選項第一次列出工作項目時才讀取；區域只在選了專案後出現，人名是團隊成員的建議（也可以自己輸入）。
 * 平常收起來，按搜尋框右邊的「篩選」按鈕展開；按鈕上的數字是改過幾項條件。
 */
function workItemFilterBar(): { bar: HTMLElement; button: HTMLElement } {
  const bar = document.createElement("div");
  bar.className = "workitems-filters";
  bar.id = "workitem-filters";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "workitems-filter-toggle";
  button.setAttribute("aria-controls", bar.id);
  const badge = document.createElement("span");
  badge.className = "workitems-filter-count";
  button.append(icon("sliders-horizontal"), badge);
  const setOpen = (open: boolean) => {
    bar.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    storage.save("workitem-filter-open", open ? "1" : "");
  };
  button.addEventListener("click", () => setOpen(bar.hidden));
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "btn btn-small workitems-filter-reset";
  reset.textContent = t("清除篩選");
  // 有設定條件時，篩選按鈕旁邊多一個「×」，不用展開篩選列就能一次清掉。
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "workitems-filter-clear";
  const clearLabel = t("清除全部篩選條件（回到「指派給我、進行中」）");
  clear.title = clearLabel;
  clear.setAttribute("aria-label", clearLabel);
  clear.append(icon("x"));
  clear.addEventListener("click", () => reset.click());
  // TFS 存的查詢：選了就改列查詢的結果（篩選條件暫時不用）。
  const query = document.createElement("button");
  query.type = "button";
  query.className = "workitems-filter-toggle workitems-query";
  query.append(icon("scroll-text"));
  query.addEventListener("click", () => queryPicker.open());
  const group = document.createElement("span");
  group.className = "workitems-filter-group";
  group.append(button, query, clear);
  const queryOpen = document.createElement("button");
  queryOpen.type = "button";
  queryOpen.className = "btn btn-small workitems-query-open";
  queryOpen.append(icon("scroll-text"), t("已儲存的查詢…"));
  queryOpen.addEventListener("click", () => queryPicker.open());
  const queryNote = document.createElement("p");
  queryNote.className = "workitems-query-note";
  const updateBadge = () => {
    const q = workItemQuery;
    query.classList.toggle("active", !!q);
    const queryLabel = q ? t("目前列出查詢「{name}」的結果（按一下換查詢或取消）", { name: q.name }) : t("TFS 的已儲存查詢");
    query.title = queryLabel;
    query.setAttribute("aria-label", queryLabel);
    query.setAttribute("aria-pressed", String(!!q));
    // 平常收在篩選列裡；正在用查詢時才放在搜尋框旁邊，看得出來、也方便換掉。
    query.hidden = !q;
    queryNote.hidden = !q;
    queryNote.textContent = q ? t("目前列出查詢「{name}」的結果，下面的篩選條件暫時不套用。", { name: q.name }) : "";
    const set = [
      !(f.role === "assigned" && f.person === "@me"),
      f.state !== "open",
      f.kinds.length > 0,
      f.projects.length > 0,
      f.areas.length > 0,
    ];
    // 和預設不一樣的條件，按鈕用強調色（和徽章的數字一致）。
    [person, state, kind, project, area].forEach((m, i) => m.el.classList.toggle("chosen", set[i]));
    const n = set.filter(Boolean).length + (q ? 1 : 0);
    badge.textContent = n ? String(n) : "";
    badge.hidden = !n;
    reset.hidden = !n;
    clear.hidden = !n;
    button.classList.toggle("active", n > 0);
    const label = n ? t("篩選（已設定 {n} 項）", { n }) : t("篩選");
    button.title = label;
    button.setAttribute("aria-label", label);
  };
  const changed = () => {
    storage.save("workitem-filter", JSON.stringify(app.workItemFilter));
    updateBadge();
    void workItemsPanel?.refresh();
  };
  workItemFilterChanged = () => {
    updateBadge();
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
  // 狀態：進行中、已結束兩項，都勾（或都不勾）是全部。
  const stateValue = (s: AdoWorkItemFilter["state"]) => (s === "all" ? [] : [s]);
  const state = new MultiSelect({
    label: t("狀態"),
    all: t("全部狀態"),
    onChange: (v) => {
      f.state = v.length === 1 ? (v[0] as AdoWorkItemFilter["state"]) : "all";
      changed();
    },
  });
  state.setOptions([["open", t("進行中")], ["closed", t("已結束")]]);
  state.value = stateValue(f.state);
  const kind = new MultiSelect({
    label: t("類型"),
    all: t("所有類型"),
    onChange: (v) => {
      f.kinds = v;
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
      changed();
    },
  });
  kind.value = f.kinds;
  project.value = f.projects;
  area.value = f.areas;
  area.hidden = !f.projects.length;

  /** 區域（選了專案時）與人名建議；同一個專案只讀一次。 */
  const scopes = new Map<string, Promise<{ areas: string[]; people: string[] }>>();
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
    area.hidden = !keys.length;
    if (!desktop) return;
    const now = () => keys.join("\n") === f.projects.join("\n");
    void Promise.all((keys.length ? keys : [""]).map(scopeOf))
      .then((all) => {
        if (!now()) return;
        // 區域路徑的第一層是專案本身：只選一個專案時顯示時省略，選了幾個時留著才分得出來。
        area.setOptions(all.flatMap(({ areas }, i) => areas.map((a): [string, string] => [a, keys.length === 1 ? a.slice(keys[i].length + 1) : a])));
        const names = [...new Set(all.flatMap((s) => s.people))].sort((a, b) => a.localeCompare(b));
        people.replaceChildren(...names.map((n) => new Option(n)));
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
      .then(({ projects, kinds }) => {
        kind.setOptions(pairs(kinds));
        project.setOptions(pairs(projects));
      })
      .catch(() => (loaded = false));
  };
  reset.addEventListener("click", () => {
    clearTimeout(timer);
    setWorkItemQuery(null, false);
    Object.assign(f, app.DEFAULT_WORK_ITEM_FILTER);
    person.value = ["assigned:@me"];
    name.hidden = true;
    name.value = "";
    state.value = ["open"];
    kind.value = [];
    project.value = [];
    area.value = [];
    loadScope();
    changed();
  });
  bar.append(queryOpen, queryNote, person.el, state.el, name, kind.el, project.el, area.el, people, reset);
  updateBadge();
  setOpen(storage.load("workitem-filter-open") === "1");
  return { bar, button: group };
}

/** 「依上層項目分組」：每個工作項目的上層（null 是沒有）與讀到的上層項目；讀過的不再讀。 */
const workItemParentOf = new Map<number, number | null>();
/** 目前清單上的工作項目（分組標題列上另外讀來的上層項目不算）。 */
let workItemListed = new Set<number>();
const workItemParentItems = new Map<number, AdoWorkItem & IssueSummary>();
let workItemParentsLoading = false;

function groupByParentItems(items: (AdoWorkItem & IssueSummary)[]): IssueGroup<AdoWorkItem & IssueSummary>[] {
  const missing = items.map((w) => w.id).filter((id) => !workItemParentOf.has(id));
  if (missing.length) {
    // 先照原本的順序顯示，讀到上層項目後再重畫。
    if (!workItemParentsLoading && desktop) {
      workItemParentsLoading = true;
      void desktop
        .adoWorkItemParents(missing)
        .then(({ links, parents }) => {
          for (const id of missing) workItemParentOf.set(id, null);
          for (const [id, parent] of links) workItemParentOf.set(id, parent);
          for (const p of parents) setBounded(workItemParentItems, p.id, workItemRow(p), app.CACHE_MAX);
        })
        .catch((e) => {
          // 讀不到就當成都沒有上層（不要一直重試）。
          for (const id of missing) workItemParentOf.set(id, null);
          app.reportError(e);
        })
        .finally(() => {
          workItemParentsLoading = false;
          workItemsPanel?.rearrange();
        });
    }
    return [{ title: null, items }];
  }
  return groupByParent(items, workItemParentOf, workItemParentItems, t("沒有上層項目"), (item, id) =>
    item ? t("{kind} {id}：{title}", { kind: item.kind, id: item.id, title: item.title }) : `#${id}`,
  );
}

/** 清單上的一列：上面一行是類型、編號、狀態、指派對象與更新日期。 */
function workItemRow(w: AdoWorkItem): AdoWorkItem & IssueSummary {
  return {
    ...w,
    meta: [`${w.kind} ${w.id}`, w.state, app.showAssignee() ? w.assignedTo : "", shortDate(w.changed)].filter(Boolean).join("・"),
  };
}

export // 在 init 時建立。
let workItemsPanel: IssuesPanel<AdoWorkItem & IssueSummary> | null;

/** 左側圖示列上的捷徑：常看的 Wiki 頁面、工作項目（從清單拖過去，或用圖釘、「更多動作」放上去）。 */
export let barShortcuts: Shortcut[] = loadBarShortcuts();
/** 正在從 Wiki、工作項目清單拖曳（圖示列上顯示放置區）。 */
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
}

/** 捷徑的名稱（提示訊息、滑鼠提示用）。 */
export function shortcutName(item: Shortcut): string {
  return isWorkItemShortcut(item) ? t("{kind} {id}：{title}", { kind: item.kind, id: item.workItem, title: item.title }) : pageName(item.path);
}

/** 捷徑對應的檢視（和 `issueKey` 比對，標出開著的那一個）。 */
function shortcutKey(item: Shortcut): string {
  return isWorkItemShortcut(item) ? `ado:${item.workItem}` : `wiki:${item.wiki}:${item.path}`;
}

/** 放到圖示列（`index` 是位置，沒給放最後面）；已經有的移過去。 */
function addBarShortcut(item: Shortcut, index?: number): void {
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

export async function openBarShortcut(item: Shortcut): Promise<void> {
  if (!desktop) return;
  if (isWorkItemShortcut(item)) {
    let w: AdoWorkItem;
    try {
      w = await peekWorkItem(item.workItem);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      toast(t("讀不到工作項目 {id}：{error}。在捷徑上按右鍵可以移除。", { id: item.workItem, error }), { tone: "error" });
      return;
    }
    // 標題、類型改了就更新圖示。
    if (w.title !== item.title || w.kind !== item.kind)
      setBarShortcuts(barShortcuts.map((s) => (sameShortcut(s, item) ? { workItem: w.id, kind: w.kind, title: w.title } : s)));
    app.showWorkItem(w);
    return;
  }
  const wikis = await withOfflineCopy("wikis", () => desktop!.adoWikis());
  const wiki = wikis.find((w) => w.id === item.wiki);
  if (!wiki) {
    toast(t("找不到這個 Wiki（可能已經刪除或沒有權限），在捷徑上按右鍵可以移除。"), { tone: "error" });
    return;
  }
  // 舊的釘選搬過來時不知道 Wiki 名稱，開啟時補上（滑鼠提示用）。
  if (item.wikiName !== wiki.name) setBarShortcuts(barShortcuts.map((s) => (sameShortcut(s, item) ? { ...s, wikiName: wiki.name } : s)));
  app.showWikiPage(wiki, item.path);
}

function renderBarShortcuts(): void {
  const buttons = barShortcuts.map((item, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "activity-btn activity-wiki-page";
    b.dataset.index = String(i);
    b.draggable = true;
    if (app.issueKey === shortcutKey(item)) b.setAttribute("aria-current", "page");
    const badge = document.createElement("span");
    badge.className = "wiki-badge";
    if (isWorkItemShortcut(item)) {
      // 工作項目：依類型上色（左邊一條類型的顏色），字取標題。
      const name = shortcutName(item);
      b.title = name;
      b.setAttribute("aria-label", name);
      badge.classList.add("workitem-badge");
      badge.style.setProperty("--hue", String(workItemHue(item.kind)));
      badge.textContent = shortcutInitial(item.title);
    } else {
      const name = pageName(item.path);
      const where = [item.wikiName, ...item.path.slice(1).split("/").slice(0, -1)].filter(Boolean).join(" › ");
      b.title = where ? `${name}\n${where}` : name;
      b.setAttribute("aria-label", name);
      badge.style.setProperty("--hue", String(shortcutHue(`${item.wiki}:${item.path}`)));
      badge.textContent = shortcutInitial(name);
    }
    b.append(badge);
    b.addEventListener("click", () => void openBarShortcut(item).catch(app.reportError));
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
    const on = !!item && app.issueKey === shortcutKey(item);
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
  for (const panel of ["workitems", "wiki"] as const) {
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

export function initWorkItemsPanel(): void {
  workItemsPanel = desktop
    ? new IssuesPanel<AdoWorkItem & IssueSummary>(app.$("#workitems-host"), {
        placeholder: t("搜尋標題或內容，或輸入編號"),
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
        ...(() => {
          const { bar, button } = workItemFilterBar();
          return { filters: bar, filterButton: button };
        })(),
        list: async (search) => {
          app.loadWorkItemFilterOptions();
          const q = workItemQuery;
          const found = q
            ? filterQueryResult(await withOfflineCopy(`wi-query:${q.project}:${q.id}`, () => desktop!.adoQueryRun(q)), search)
            : await withOfflineCopy(`wi-list:${search}:${JSON.stringify(app.workItemFilter)}`, () => desktop!.adoWorkItems(search, app.workItemFilter));
          app.noteWorkItems(found, !q && !search && app.isDefaultFilter());
          workItemListed = new Set(found.map((w) => w.id));
          return found.map(workItemRow);
        },
        view: (item) => app.showWorkItem(item),
        status: (n, search) =>
          workItemQuery
            ? n
              ? t("查詢「{name}」的結果（{n}）", { name: workItemQuery.name, n })
              : search
                ? t("查詢「{name}」的結果裡找不到符合的工作項目", { name: workItemQuery.name })
                : t("查詢「{name}」沒有結果", { name: workItemQuery.name })
            : n
            ? search
              ? t("找到 {n} 個工作項目", { n })
              : app.isDefaultFilter()
                ? t("指派給你、還沒結束的工作項目（{n}）", { n })
                : t("符合篩選條件的工作項目（{n}）", { n })
            : search
              ? t("找不到符合的工作項目")
              : app.isDefaultFilter()
                ? t("目前沒有指派給你、還沒結束的工作項目")
                : t("沒有符合篩選條件的工作項目"),
      })
    : null;
  shortcutBar.className = "activity-wiki";
  shortcutBar.setAttribute("role", "toolbar");
  shortcutBar.setAttribute("aria-label", t("捷徑"));
  shortcutBar.setAttribute("aria-orientation", "vertical");
  shortcutBar.hidden = true;
  shortcutDrop.className = "activity-wiki-drop";
  shortcutDrop.title = t("放到這裡，變成圖示列上的捷徑");
  shortcutDrop.append(icon("plus"));
  app.$(".activity-cmds").after(shortcutBar);
  // 從 Wiki、工作項目清單拖曳時，圖示列上出現放置區；放下就變成捷徑。
  document.addEventListener("dragstart", (e) => {
    if (!(e.target as HTMLElement).closest?.("#wiki-host .wiki-page, #workitems-host .workitem")) return;
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
    if (!item) return;
    e.preventDefault();
    const index = [...shortcutBar.querySelectorAll(".activity-wiki-page, .activity-wiki-drop")].indexOf(shortcutDrop);
    shortcutDragging = false;
    addBarShortcut(item, index < 0 ? undefined : index);
  });
  renderBarShortcuts();
  wikiPanel = desktop
    ? new WikiPanel<AdoWiki>(app.$("#wiki-host"), {
        wikis: () => withOfflineCopy("wikis", () => desktop!.adoWikis()),
        pages: (wiki) => withOfflineCopy(`wiki-pages:${wiki.id}`, () => desktop!.adoWikiPages(wiki)),
        open: (wiki, path) => app.showWikiPage(wiki, path),
        load: () => storage.load("ado-wiki"),
        save: (id) => storage.save("ado-wiki", id),
        prefs(id) {
          const paths = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : []);
          try {
            const v = JSON.parse(storage.load(`ado-wiki-pages:${id}`) ?? "{}") as Record<string, unknown>;
            return { recent: paths(v.recent), pinned: paths(v.pinned), shown: paths(v.shown), root: typeof v.root === "string" ? v.root : undefined };
          } catch {
            return { recent: [], pinned: [] };
          }
        },
        savePrefs: (id, prefs) => storage.save(`ado-wiki-pages:${id}`, JSON.stringify(prefs)),
        link: (wiki, path) => (wiki.webUrl ? wikiPageLink(pageName(path), wikiPageUrl(wiki.webUrl, path)) : null),
        create: (wiki, parent) => void app.createWikiPage(wiki, parent).catch(app.reportError),
        canCreate: (wiki) => !wiki.code,
        // 釘選＝放到左側圖示列；拖曳頁面到圖示列也可以。
        pins: {
          has: (wiki, path) => barShortcuts.some((s) => !isWorkItemShortcut(s) && s.wiki === wiki.id && s.path === path),
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
            meta: [
              `#${i.number}`,
              i.state === "closed" ? t("已關閉") : "",
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
