/**
 * Sprint 工作板（左側圖示列的「工作板」）：側邊欄選專案、團隊、Sprint 與人員，
 * 主要區域開一個「工作板」分頁。每一列是一個上層項目，每一欄是一個狀態；拖曳卡片換欄就是改狀態，
 * 點卡片在同一個分頁開啟工作項目（按 < 或 Alt+← 回到工作板）。
 */
import { adoOnline } from "../ado-online.ts";
import { type AdoBoardItem, type AdoTeam, type AdoTeamIteration, desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import * as storage from "../storage.ts";
import { type Board, type BoardItem, buildBoard, filterBoard, hoursText } from "../taskboard-model.ts";
import { icon } from "../ui/icons.ts";
import type { IssueSource } from "../ui/issue-view.ts";
import { toast } from "../ui/toast.ts";
import { stateTone } from "../workitem-chips.ts";
import { kindKey } from "../work-item-colors.ts";
import { shortcutHue, shortcutInitial } from "../wiki-shortcuts.ts";
import { app } from "./context.ts";
import { favoriteProjects } from "./favorite-lists.ts";
import { FavoriteSelect } from "../ui/favorite-select.ts";
import { type Freshness, forgetListCopies, freshnessOf, withOfflineCopy } from "./offline-copies.ts";
import { copyTime } from "../ui/issues-panel.ts";
import { reportError } from "./git-actions.ts";
import { showIssue } from "./ado-files.ts";
import { insertAtCursor } from "./image-paste.ts";
import { showWorkItem } from "./work-item-actions.ts";

/** 「工作」類型（卡片）：各種流程範本的名稱。 */
const TASK_KINDS = new Set(["Task", "工作"]); // i18n-ignore：伺服器上的類型名稱
/** 已移除的狀態：查詢本來就不含這些項目，不顯示這一欄。 */
const REMOVED = new Set(["removed", "cut", "已移除", "已刪除"]); // i18n-ignore：伺服器上的狀態名稱

interface Selection {
  project: string;
  team: AdoTeam;
  iteration: AdoTeamIteration;
}

/** 側邊欄目前的選擇；人員篩選：`null` 全部、`@me` 只看我、其他是名字。 */
let selection: Selection | null = null;
let person: string | null = storage.load("board-person");

/** 讀過的狀態順序（專案|類型）。 */
const statesCache = new Map<string, Promise<string[]>>();
function statesOf(project: string, kind: string): Promise<string[]> {
  const key = `${project}|${kind}`;
  let p = statesCache.get(key);
  if (!p) {
    // 狀態很少改：有副本就用副本，背景更新副本給下次用。
    p = withOfflineCopy(`states:${key}`, () => desktop!.adoWorkItemStates(project, kind), () => {}, true).catch(() => []);
    statesCache.set(key, p);
  }
  return p;
}

/** 工作板的網頁版網址（Azure DevOps 的 Sprints → Taskboard）。 */
function boardUrl(s: Selection): string {
  const base = app.ado?.account?.url ?? "";
  const path = s.iteration.path.split("\\").map(encodeURIComponent).join("/");
  return `${base}/${encodeURIComponent(s.project)}/_sprints/taskboard/${encodeURIComponent(s.team.name)}/${path}`;
}

/** 卡片的狀態欄（依卡片最多的類型的流程）。 */
async function columnsFor(project: string, cards: BoardItem[]): Promise<string[]> {
  const count = new Map<string, number>();
  for (const c of cards) count.set(c.kind, (count.get(c.kind) ?? 0) + 1);
  const kinds = [...count].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  if (!kinds.length) kinds.push("Task");
  const lists = await Promise.all(kinds.map((k) => statesOf(project, k)));
  const out: string[] = [];
  for (const list of lists) for (const s of list) if (!out.includes(s)) out.push(s);
  return out;
}

const toBoardItem = (w: AdoBoardItem | (Omit<AdoBoardItem, "parent" | "rev" | "remaining" | "completed" | "original"> & Partial<AdoBoardItem>)): BoardItem => ({
  id: w.id,
  title: w.title,
  state: w.state,
  kind: w.kind,
  assignedTo: w.assignedTo,
  priority: w.priority,
  parent: w.parent ?? null,
  remaining: w.remaining ?? null,
  completed: w.completed ?? null,
  original: w.original ?? null,
  rev: w.rev ?? null,
});

/** 開啟（或重新整理）目前選擇的工作板。 */
export function openBoard(): void {
  if (!selection) return;
  void showIssue(boardSource(selection)).catch(reportError);
}

function boardSource(s: Selection): IssueSource {
  let board: Board | null = null;
  let raw: Map<number, AdoBoardItem> = new Map();
  const title = t("{sprint}（{team}）", { sprint: s.iteration.name, team: s.team.name });
  const key = `board:${s.project}/${s.team.id}/${s.iteration.id}`;
  /** 顯示的是副本時：存下的時間與狀態。 */
  let fresh: Freshness | null = null;
  return {
    key,
    // 工作板要靠 load 讀到的資料才畫得出來；它自己的清單副本已經讓 load 很快。
    copyFirst: false,
    origin: { kind: "ado", icon: "layout-grid", text: t("Azure DevOps 工作板") },
    label: t("工作板"),
    title,
    webUrl: boardUrl(s),
    fileName: t("工作板 {sprint}.md", { sprint: s.iteration.name }),
    async load() {
      // 有副本就先顯示（不用等伺服器），背景讀完再重畫一次。
      const update = () => {
        if (app.issueView.shownKey === key) void app.issueView.refresh(true);
      };
      const items = await withOfflineCopy(`board:${key}`, () => desktop!.adoBoard(s.project, s.team.name, s.iteration.path), update);
      fresh = freshnessOf(items);
      raw = new Map(items.map((w) => [w.id, w]));
      const list = items.map(toBoardItem);
      // 上層項目不在這個 Sprint 裡：另外讀標題。
      const missing = [...new Set(list.map((w) => w.parent).filter((p): p is number => p !== null && !raw.has(p)))];
      const outside = missing.length
        ? (await withOfflineCopy(`board-parents:${key}`, () => desktop!.adoWorkItemsByIds(missing), update).catch(() => [])).map(toBoardItem)
        : [];
      const cards = list.filter((w) => TASK_KINDS.has(w.kind) || (w.parent !== null && (raw.has(w.parent) || missing.includes(w.parent))));
      const columns = (await columnsFor(s.project, cards)).filter((state) => !REMOVED.has(state.toLowerCase()));
      board = buildBoard(list, outside, columns, TASK_KINDS);
      return boardMarkdown(board, title);
    },
    insertLink: () => insertAtCursor(`[${title}](${boardUrl(s)})`),
    decorate(body) {
      if (board) renderBoard(body, filterBoard(board, personName()), s, raw);
    },
    facts: () => {
      if (!board) return [];
      const cards = board.rows.flatMap((r) => [...r.cells.values()].flat());
      const left = cards.reduce((n, c) => n + (c.remaining ?? 0), 0);
      return [
        { text: t("{n} 個工作", { n: cards.length }) },
        ...(left ? [{ text: t("剩 {n} 小時", { n: Math.round(left * 10) / 10 }) }] : []),
        ...(s.iteration.finish ? [{ text: t("到 {date}", { date: s.iteration.finish.slice(0, 10) }) }] : []),
        ...(fresh
          ? [
              {
                text:
                  fresh.state === "updating"
                    ? t("{time} 的資料，更新中…", { time: copyTime(fresh.savedAt) })
                    : t("連不上伺服器，顯示 {time} 存下的資料", { time: copyTime(fresh.savedAt) }),
              },
            ]
          : []),
      ];
    },
  };
}

function personName(): string | null {
  if (person === "@me") return app.ado?.account?.name ?? null;
  return person;
}

/** 讀不到互動版時（例如離線副本）顯示的表格，也是「複製成 Markdown 文件」的內容。 */
function boardMarkdown(board: Board, title: string): string {
  const cell = (list: BoardItem[]) => list.map((c) => `#${c.id} ${c.title.replace(/\|/g, "\\|")}`).join(t("；")) || " ";
  const parentLabel = t("上層項目");
  const head = `| ${parentLabel} | ${board.columns.join(" | ")} |`;
  const sep = `|${" --- |".repeat(board.columns.length + 1)}`;
  const rows = board.rows.map((r) => {
    const parent = r.parent ? `#${r.parent.id} ${r.parent.title.replace(/\|/g, "\\|")}` : t("沒有上層");
    return `| ${parent} | ${board.columns.map((s) => cell(r.cells.get(s) ?? [])).join(" | ")} |`;
  });
  return `# ${title}\n\n${[head, sep, ...rows].join("\n")}\n`;
}

function avatar(name: string | null): HTMLElement {
  const a = document.createElement("span");
  a.className = "ado-avatar tb-avatar";
  a.textContent = name ? shortcutInitial(name) : "?";
  a.style.setProperty("--hue", String(shortcutHue(name ?? "")));
  a.setAttribute("aria-hidden", "true");
  return a;
}

function stateDot(state: string): HTMLElement {
  const dot = document.createElement("span");
  dot.className = `ado-state-dot ${stateTone(state)}`;
  dot.setAttribute("aria-hidden", "true");
  return dot;
}

/** 卡片：和工作項目清單同一種排法（上面一行是類型、編號與狀態，下面是標題），色條用類型的顏色。 */
function card(w: BoardItem, raw: Map<number, AdoBoardItem>, draggable: boolean): HTMLElement {
  const c = document.createElement("div");
  c.className = "tb-card";
  c.dataset.id = String(w.id);
  c.dataset.wiKind = kindKey(w.kind);
  c.tabIndex = 0;
  c.draggable = draggable;
  c.title = t("{kind} {id}：{title}", { kind: w.kind, id: w.id, title: w.title });
  const meta = document.createElement("div");
  meta.className = "workitem-meta";
  meta.append(Object.assign(document.createElement("span"), { className: "workitem-meta-text", textContent: `${w.kind} ${w.id}` }));
  const title = Object.assign(document.createElement("div"), { className: "tb-title", textContent: w.title });
  const who = document.createElement("div");
  who.className = "tb-who";
  who.append(avatar(w.assignedTo), Object.assign(document.createElement("span"), { textContent: w.assignedTo ?? t("沒有指派") }));
  const hours = hoursText(w, { remaining: (n) => t("剩 {n} 小時", { n }), completed: (n) => t("完成 {n} 小時", { n }) });
  if (hours) who.append(Object.assign(document.createElement("span"), { className: "tb-hours", textContent: hours }));
  c.append(meta, title, who);
  const open = () => {
    const item = raw.get(w.id);
    if (item) showWorkItem(item);
  };
  c.addEventListener("click", open);
  c.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      open();
    }
  });
  return c;
}

/** 把工作板畫進 `body`（取代 Markdown 表格）。 */
function renderBoard(body: HTMLElement, board: Board, s: Selection, raw: Map<number, AdoBoardItem>): void {
  const root = document.createElement("div");
  root.className = "taskboard";
  root.style.setProperty("--tb-columns", String(board.columns.length));
  const head = document.createElement("div");
  head.className = "tb-row tb-head";
  head.append(Object.assign(document.createElement("div"), { className: "tb-parent", textContent: t("上層項目") }));
  for (const state of board.columns) {
    const n = board.rows.reduce((sum, r) => sum + (r.cells.get(state)?.length ?? 0), 0);
    const h = document.createElement("div");
    h.className = "tb-col-head";
    h.append(stateDot(state), state, Object.assign(document.createElement("span"), { className: "tb-count", textContent: String(n) }));
    head.append(h);
  }
  root.append(head);
  if (!board.rows.length) {
    root.append(Object.assign(document.createElement("p"), { className: "tb-empty", textContent: t("這個 Sprint 沒有工作項目。") }));
  }
  for (const row of board.rows) {
    const r = document.createElement("div");
    r.className = "tb-row";
    const parent = document.createElement("div");
    parent.className = "tb-parent";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "btn icon-only tb-toggle";
    toggle.setAttribute("aria-label", t("收合這一列"));
    toggle.append(icon("chevron-down"));
    toggle.addEventListener("click", () => r.classList.toggle("collapsed"));
    if (row.parent) {
      const p = row.parent;
      const link = card(p, raw, false);
      link.classList.add("tb-parent-card");
      // 上層項目不在這個 Sprint 裡時，點了用編號開。
      if (!raw.has(p.id)) link.addEventListener("click", () => void app.openWorkItemById(p.id));
      const state = document.createElement("span");
      state.className = "workitem-state";
      state.append(stateDot(p.state), p.state);
      link.querySelector(".workitem-meta")?.append(state);
      parent.append(toggle, link);
    } else {
      parent.append(toggle, Object.assign(document.createElement("div"), { className: "tb-orphans", textContent: t("沒有上層") }));
    }
    r.append(parent);
    const count = [...row.cells.values()].reduce((n, l) => n + l.length, 0);
    parent.dataset.count = String(count);
    for (const state of board.columns) {
      const cell = document.createElement("div");
      cell.className = "tb-cell";
      cell.dataset.state = state;
      for (const w of row.cells.get(state) ?? []) cell.append(card(w, raw, true));
      dropZone(cell, s, raw);
      r.append(cell);
    }
    root.append(r);
  }
  body.replaceChildren(root);
}

/** 拖曳卡片到別的欄：改狀態（送出時帶修訂版本，別人剛改過會失敗並重新整理）。 */
function dropZone(cell: HTMLElement, s: Selection, raw: Map<number, AdoBoardItem>): void {
  cell.addEventListener("dragstart", (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>(".tb-card");
    if (!c) return;
    // 離線時改不了狀態：一開始拖就說明，不要等放下才失敗。
    if (adoOnline.offline) {
      e.preventDefault();
      toast(t("目前離線，連上 Azure DevOps 之後才能拖曳改狀態"), { tone: "error" });
      return;
    }
    e.dataTransfer?.setData("text/x-omarker-card", c.dataset.id ?? "");
    c.classList.add("dragging");
  });
  cell.addEventListener("dragend", (e) => (e.target as HTMLElement).closest(".tb-card")?.classList.remove("dragging"));
  cell.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes("text/x-omarker-card")) return;
    e.preventDefault();
    cell.classList.add("drop");
  });
  cell.addEventListener("dragleave", () => cell.classList.remove("drop"));
  cell.addEventListener("drop", (e) => {
    cell.classList.remove("drop");
    const id = Number(e.dataTransfer?.getData("text/x-omarker-card"));
    const item = raw.get(id);
    const state = cell.dataset.state;
    if (!item || !state || item.state === state) return;
    e.preventDefault();
    const el = cell.closest(".taskboard")?.querySelector<HTMLElement>(`.tb-card[data-id="${id}"]`);
    if (el) cell.append(el);
    void (async () => {
      try {
        await desktop!.adoWorkItemUpdate(id, { state, rev: item.rev });
        toast(t("已把 {id} 改成「{state}」", { id, state }), { tone: "success" });
      } catch (err) {
        reportError(err);
      }
      forgetListCopies("board");
      void app.issueView.refresh(true);
    })();
  });
  void s;
}

// ---- 側邊欄 -------------------------------------------------------------------

/** 專案選單與旁邊的星號（常用的專案）排在同一列。 */
function projectRow(project: FavoriteSelect): HTMLElement {
  const row = document.createElement("div");
  row.className = "tb-project-row";
  row.append(project.select, project.star);
  return row;
}

function select(id: string, label: string): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.id = id;
  sel.className = "workitems-select";
  sel.title = label;
  sel.setAttribute("aria-label", label);
  return sel;
}

let loaded = false;

/** 側邊欄第一次打開時讀專案、團隊、Sprint。 */
export function boardPanelShown(): void {
  if (loaded || !desktop || !app.ado?.account) return;
  loaded = true;
  void fillPanel().catch((e) => {
    loaded = false;
    reportError(e);
  });
}

async function fillPanel(): Promise<void> {
  const host = app.$("#board-host");
  // 專案只列常用的（旁邊的星號勾選），最下面可以「顯示全部」。
  const project = new FavoriteSelect({
    label: t("專案"),
    caption: t("選單列出哪些專案（常用的）"),
    load: favoriteProjects.load,
    save: favoriteProjects.save,
    onChange: () => void loadTeams().catch(reportError),
  });
  project.select.id = "board-project";
  project.select.title = t("專案");
  const team = select("board-team", t("團隊"));
  const sprint = select("board-sprint", t("Sprint"));
  const who = select("board-person", t("人員"));
  for (const [v, l] of [
    ["", t("所有人")],
    ["@me", t("只看我")],
  ]) who.append(new Option(l, v));
  who.value = person ?? "";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "btn btn-small tb-open";
  open.append(icon("layout-grid"), t("開啟工作板"));
  const filters = document.createElement("div");
  filters.className = "workitems-filters tb-filters";
  filters.append(projectRow(project), team, sprint, who);
  const hint = Object.assign(document.createElement("p"), { className: "workitems-status", textContent: t("拖曳卡片到別的欄就是改狀態；點卡片開啟工作項目，按 < 回到工作板。") });
  host.replaceChildren(filters, open, hint);

  // 有副本就先列出來（不用等伺服器）；背景讀到不一樣的清單再重建選單。
  const refill = (changed: boolean) => {
    if (!changed) return;
    loaded = false;
    boardPanelShown();
  };
  const projects = (await withOfflineCopy("wi-filters", () => desktop!.adoWorkItemFilters(), refill)).projects;
  const savedProject = storage.load("board-project");
  project.setItems(
    projects.map((p) => [p, p]),
    savedProject && projects.includes(savedProject) ? savedProject : (projects[0] ?? ""),
  );

  let teams: AdoTeam[] = [];
  let sprints: AdoTeamIteration[] = [];
  const loadSprints = async () => {
    const name = teams.find((x) => x.id === team.value)?.name ?? team.value;
    sprints = team.value ? await withOfflineCopy(`sprints:${project.value}/${team.value}`, () => desktop!.adoTeamIterations(project.value, name), refill) : [];
    sprint.replaceChildren(
      ...sprints.map((i) => new Option(i.current ? t("{name}（目前）", { name: i.name }) : i.name, i.id)),
    );
    const saved = storage.load("board-sprint");
    sprint.value = sprints.find((i) => i.id === saved)?.id ?? sprints.find((i) => i.current)?.id ?? sprints[sprints.length - 1]?.id ?? "";
    remember();
  };
  const loadTeams = async () => {
    teams = project.value ? await withOfflineCopy(`teams:${project.value}`, () => desktop!.adoTeams(project.value), refill) : [];
    team.replaceChildren(...teams.map((x) => new Option(x.default ? t("{name}（預設）", { name: x.name }) : x.name, x.id)));
    const saved = storage.load("board-team");
    team.value = teams.find((x) => x.id === saved)?.id ?? teams[0]?.id ?? "";
    await loadSprints();
  };
  const remember = () => {
    const tm = teams.find((x) => x.id === team.value);
    const it = sprints.find((i) => i.id === sprint.value);
    selection = tm && it ? { project: project.value, team: tm, iteration: it } : null;
    open.disabled = !selection;
    storage.save("board-project", project.value);
    if (tm) storage.save("board-team", tm.id);
    if (it) storage.save("board-sprint", it.id);
  };
  team.addEventListener("change", () => void loadSprints().then(openBoard, reportError));
  sprint.addEventListener("change", () => {
    remember();
    openBoard();
  });
  who.addEventListener("change", () => {
    person = who.value || null;
    if (person) storage.save("board-person", person);
    else storage.remove("board-person");
    // 開著工作板時馬上套用。
    if (app.issueView.shownKey?.startsWith("board:")) app.issueView.rerender();
  });
  open.addEventListener("click", openBoard);
  await loadTeams();
}

export function initTaskboard(): void {
  app.$("#board-refresh").addEventListener("click", () => {
    loaded = false;
    statesCache.clear();
    forgetListCopies("board");
    forgetListCopies("teams:");
    forgetListCopies("sprints:");
    forgetListCopies("wi-filters");
    boardPanelShown();
    if (app.issueView.shownKey?.startsWith("board:")) void app.issueView.refresh();
  });
  app.commands.register({
    id: "show-board",
    title: t("顯示工作板（Azure DevOps）"),
    group: t("檢視"),
    icon: "layout-grid",
    when: () => !!app.ado?.account,
    run: () => app.showPanel("board"),
  });
}
