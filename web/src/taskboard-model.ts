/**
 * Sprint 工作板的排法（不碰畫面，方便測試）：每一列是一個上層項目（User Story、Bug…），
 * 每一欄是一個狀態，格子裡是那個上層項目底下、在那個狀態的工作（Task）。
 */

export interface BoardItem {
  id: number;
  title: string;
  state: string;
  kind: string;
  assignedTo: string | null;
  priority: number | null;
  /** 上層項目的編號（不一定在這個 Sprint 裡）。 */
  parent: number | null;
  remaining?: number | null;
  completed?: number | null;
  original?: number | null;
  rev?: number | null;
}

export interface BoardRow {
  /** 上層項目；`null` 是「沒有上層」的那一列。 */
  parent: BoardItem | null;
  /** 狀態 → 卡片（依原本的順序）。 */
  cells: Map<string, BoardItem[]>;
}

export interface Board {
  columns: string[];
  rows: BoardRow[];
}

/**
 * 排出工作板。`items` 是這個 Sprint 的工作項目，`outside` 是不在這個 Sprint、但有子項目在的上層項目，
 * `states` 是卡片（工作）的狀態順序（依工作項目類型的流程）；卡片上出現了清單裡沒有的狀態，接在最後。
 *
 * 哪些是一列、哪些是卡片：上層項目在工作板上的是一列，它的子項目是卡片；沒有上層、底下也沒有子項目的，
 * 「工作」類（Task）放在「沒有上層」那一列，其他（User Story、Bug…）自己是一列（沒有卡片）。
 */
export function buildBoard(items: readonly BoardItem[], outside: readonly BoardItem[], states: readonly string[], taskKinds: ReadonlySet<string>): Board {
  const byId = new Map(items.map((w) => [w.id, w]));
  const outsideById = new Map(outside.map((w) => [w.id, w]));
  const hasChildren = new Set(items.map((w) => w.parent).filter((p): p is number => p !== null));
  const cards: BoardItem[] = [];
  const parents = new Map<number, BoardItem>();
  const orphans: BoardItem[] = [];
  for (const w of items) {
    const parent = w.parent !== null ? (byId.get(w.parent) ?? outsideById.get(w.parent)) : undefined;
    if (parent) {
      cards.push(w);
      parents.set(parent.id, parent);
    } else if (hasChildren.has(w.id) || !taskKinds.has(w.kind)) {
      parents.set(w.id, w);
    } else {
      cards.push(w);
      orphans.push(w);
    }
  }
  // 上層項目自己也是別人的子項目（例如 Feature → Story → Task）：只在當列的上層，不當卡片。
  const cardList = cards.filter((c) => !parents.has(c.id));
  const columns = [...states];
  for (const c of cardList) if (!columns.includes(c.state)) columns.push(c.state);
  const empty = () => new Map(columns.map((s) => [s, [] as BoardItem[]]));
  const rows = new Map<number | null, BoardRow>();
  const order = [...parents.values()].sort(byPriority);
  for (const p of order) rows.set(p.id, { parent: p, cells: empty() });
  for (const c of cardList) {
    const key = orphans.includes(c) ? null : c.parent;
    if (!rows.has(key)) rows.set(key, { parent: null, cells: empty() });
    rows.get(key)!.cells.get(c.state)!.push(c);
  }
  // 「沒有上層」排最後。
  const list = [...rows.entries()].sort(([a], [b]) => Number(a === null) - Number(b === null)).map(([, r]) => r);
  return { columns, rows: list };
}

/** 優先順序小的在前（沒有優先順序的排後面），一樣時編號小的在前。 */
function byPriority(a: BoardItem, b: BoardItem): number {
  return (a.priority ?? Infinity) - (b.priority ?? Infinity) || a.id - b.id;
}

/** 只留下某個人的卡片（`null` 是不限）；整列都沒有卡片、上層也不是他的，那一列不顯示。 */
export function filterBoard(board: Board, person: string | null): Board {
  if (!person) return board;
  const mine = (w: BoardItem) => w.assignedTo === person;
  const rows = board.rows
    .map((r) => ({ parent: r.parent, cells: new Map([...r.cells].map(([s, list]) => [s, list.filter(mine)])) }))
    .filter((r) => [...r.cells.values()].some((l) => l.length) || (r.parent && mine(r.parent)));
  return { columns: board.columns, rows };
}

/** 卡片上的工時：「剩 3 小時」之類的摘要；沒填工時的是空字串。 */
export function hoursText(w: BoardItem, label: { remaining: (n: string) => string; completed: (n: string) => string }): string {
  const round = (n: number) => Math.round(n * 10) / 10;
  const parts: string[] = [];
  // 沒填（或是 0）的不顯示，不然每張卡片都是「完成 0 小時」。
  if (typeof w.remaining === "number" && round(w.remaining) > 0) parts.push(label.remaining(String(round(w.remaining))));
  if (typeof w.completed === "number" && round(w.completed) > 0) parts.push(label.completed(String(round(w.completed))));
  return parts.join(" · ");
}

/** 一段休假（含頭尾）；日期只看前 10 個字（`YYYY-MM-DD`）。 */
export interface DaysOff {
  start: string;
  end: string;
}

export interface CapacityData {
  members: { name: string; perDay: number; daysOff: DaysOff[] }[];
  teamDaysOff: DaysOff[];
}

export interface CapacityRow {
  /** 成員名稱；`null` 是沒有指派的工作。 */
  name: string | null;
  /** 這個 Sprint 剩下的工作天可以做幾小時。 */
  available: number;
  /** 指派給他、還沒做完的工時（剩餘工時加總）。 */
  assigned: number;
  /** 工作排得比時間多。 */
  over: boolean;
}

const day = (s: string) => s.slice(0, 10);

/** `from` 到 `to`（含頭尾）有幾個工作天：週一到週五，扣掉休假。 */
export function workingDays(from: string, to: string, off: readonly DaysOff[]): number {
  const end = day(to);
  let n = 0;
  for (let d = new Date(`${day(from)}T00:00:00Z`); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    const iso = d.toISOString().slice(0, 10);
    if (wd === 0 || wd === 6) continue;
    if (off.some((o) => day(o.start) <= iso && iso <= day(o.end))) continue;
    n++;
  }
  return n;
}

/**
 * 每個人這個 Sprint 還有多少時間、排了多少工作：時間從今天（或 Sprint 開始，取晚的）算到 Sprint 結束，
 * 扣掉週末、團隊與個人的休假；工作是指派給他的卡片的剩餘工時。
 * 沒有容量也沒有工作的人不列；沒有指派的工作放最後。
 */
export function capacityRows(cap: CapacityData, cards: readonly BoardItem[], start: string, finish: string, today: string): CapacityRow[] {
  const from = day(today) > day(start) ? today : start;
  const assigned = new Map<string | null, number>();
  for (const c of cards) assigned.set(c.assignedTo, (assigned.get(c.assignedTo) ?? 0) + (c.remaining ?? 0));
  const round = (n: number) => Math.round(n * 10) / 10;
  const rows: CapacityRow[] = cap.members.map((m) => {
    const available = round(m.perDay * workingDays(from, finish, [...cap.teamDaysOff, ...m.daysOff]));
    const mine = round(assigned.get(m.name) ?? 0);
    assigned.delete(m.name);
    return { name: m.name, available, assigned: mine, over: mine > available };
  });
  // 有工作、但團隊容量裡沒有這個人（例如別的團隊的人）：時間不知道。
  for (const [name, hours] of assigned) if (name !== null && hours > 0) rows.push({ name, available: 0, assigned: round(hours), over: true });
  const out = rows.filter((r) => r.available > 0 || r.assigned > 0);
  const none = assigned.get(null) ?? 0;
  if (none > 0) out.push({ name: null, available: 0, assigned: round(none), over: false });
  return out;
}
