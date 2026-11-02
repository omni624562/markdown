/**
 * Sprint 工作板（左側圖示列的「工作板」）：側邊欄選專案、團隊、Sprint 與人員，
 * 主要區域開一個「工作板」分頁。每一列是一個上層項目，每一欄是一個狀態；拖曳卡片換欄就是改狀態，
 * 點卡片在同一個分頁開啟工作項目（按 < 或 Alt+← 回到工作板）。
 */
import { type AdoBoardItem, type AdoTeam, type AdoTeamIteration, desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import * as storage from "../storage.ts";
import { type Board, type BoardItem, buildBoard, filterBoard, hoursText } from "../taskboard-model.ts";
import { icon } from "../ui/icons.ts";
import type { IssueSource } from "../ui/issue-view.ts";
import { toast } from "../ui/toast.ts";
import { stateTone } from "../workitem-chips.ts";
import { shortcutHue, shortcutInitial } from "../wiki-shortcuts.ts";
import { app } from "./context.ts";
import { reportError } from "./git-actions.ts";
import { showIssue } from "./ado-files.ts";
import { insertAtCursor } from "./image-paste.ts";
import { showWorkItem } from "./work-item-actions.ts";

/** 「工作」類型（卡片）：各種流程範本的名稱。 */
const TASK_KINDS = new Set(["Task", "工作"]); // i18n-ignore：伺服器上的類型名稱

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
    p = desktop!.adoWorkItemStates(project, kind).catch(() => []);
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
  return {
    key: `board:${s.project}/${s.team.id}/${s.iteration.id}`,
    origin: { kind: "ado", icon: "layout-grid", text: t("Azure DevOps 工作板") },
    label: t("工作板"),
    title,
    webUrl: boardUrl(s),
    fileName: t("工作板 {sprint}.md", { sprint: s.iteration.name }),
    async load() {
      const items = await desktop!.adoBoard(s.project, s.team.name, s.iteration.path);
      raw = new Map(items.map((w) => [w.id, w]));
      const list = items.map(toBoardItem);
      // 上層項目不在這個 Sprint 裡：另外讀標題。
      const missing = [...new Set(list.map((w) => w.parent).filter((p): p is number => p !== null && !raw.has(p)))];
      const outside = missing.length ? (await desktop!.adoWorkItemsByIds(missing).catch(() => [])).map(toBoardItem) : [];
      const cards = list.filter((w) => TASK_KINDS.has(w.kind) || (w.parent !== null && (raw.has(w.parent) || missing.includes(w.parent))));
      board = buildBoard(list, outside, await columnsFor(s.project, cards), TASK_KINDS);
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

function card(w: BoardItem, raw: Map<number, AdoBoardItem>, draggable: boolean): HTMLElement {
  const c = document.createElement("div");
  c.className = "tb-card";
  c.dataset.id = String(w.id);
  c.tabIndex = 0;
  c.draggable = draggable;
  c.title = t("{kind} {id}：{title}", { kind: w.kind, id: w.id, title: w.title });
  const head = document.createElement("div");
  head.className = "tb-card-head";
  head.append(Object.assign(document.createElement("span"), { className: "tb-id", textContent: String(w.id) }));
  head.append(Object.assign(document.createElement("span"), { className: "tb-title", textContent: w.title }));
  const meta = document.createElement("div");
  meta.className = "tb-card-meta";
  meta.append(avatar(w.assignedTo), Object.assign(document.createElement("span"), { textContent: w.assignedTo ?? t("沒有指派") }));
  const hours = hoursText(w, { remaining: (n) => t("剩 {n} 小時", { n }), completed: (n) => t("完成 {n} 小時", { n }) });
  c.append(head, meta);
  if (hours) c.append(Object.assign(document.createElement("div"), { className: "tb-hours", textContent: hours }));
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
    const h = document.createElement("div");
    h.className = "tb-col-head";
    h.append(stateDot(state), state);
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
      const state = document.createElement("div");
      state.className = "tb-parent-state";
      state.append(stateDot(p.state), p.state);
      link.append(state);
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
      void app.issueView.refresh(true);
    })();
  });
  void s;
}

// ---- 側邊欄 -------------------------------------------------------------------

function select(id: string, label: string): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.id = id;
  sel.setAttribute("aria-label", label);
  return sel;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "tb-field";
  wrap.append(Object.assign(document.createElement("span"), { textContent: label }), control);
  return wrap;
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
  const project = select("board-project", t("專案"));
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
  open.className = "btn btn-primary";
  open.append(icon("layout-grid"), t("開啟工作板"));
  const hint = Object.assign(document.createElement("p"), { className: "side-hint", textContent: t("拖曳卡片到別的欄就是改狀態；點卡片開啟工作項目，按 < 回到工作板。") });
  host.replaceChildren(field(t("專案"), project), field(t("團隊"), team), field(t("Sprint"), sprint), field(t("人員"), who), open, hint);

  const projects = (await desktop!.adoWorkItemFilters()).projects;
  for (const p of projects) project.append(new Option(p, p));
  const savedProject = storage.load("board-project");
  project.value = savedProject && projects.includes(savedProject) ? savedProject : (projects[0] ?? "");

  let teams: AdoTeam[] = [];
  let sprints: AdoTeamIteration[] = [];
  const loadSprints = async () => {
    sprints = team.value ? await desktop!.adoTeamIterations(project.value, teams.find((x) => x.id === team.value)?.name ?? team.value) : [];
    sprint.replaceChildren(
      ...sprints.map((i) => new Option(i.current ? t("{name}（目前）", { name: i.name }) : i.name, i.id)),
    );
    const saved = storage.load("board-sprint");
    sprint.value = sprints.find((i) => i.id === saved)?.id ?? sprints.find((i) => i.current)?.id ?? sprints[sprints.length - 1]?.id ?? "";
    remember();
  };
  const loadTeams = async () => {
    teams = project.value ? await desktop!.adoTeams(project.value) : [];
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
  project.addEventListener("change", () => void loadTeams().catch(reportError));
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
