/**
 * 工作項目清單的篩選條件：預設值、讀回存起來的條件，與狀態篩選的選項（不碰畫面，方便測試）。
 *
 * 狀態篩選列出伺服器上實際的狀態（New、Active、Resolved、Closed…）。勾的剛好是所有「還沒結束」的狀態時
 * 存成 `state: "open"`（和以前的「進行中」一樣，新的狀態也算進去），剛好是「已結束」的是 `closed`，
 * 其他組合才存成指定的 `states`。讀不到狀態清單時，選單只有「進行中」「已結束」兩項（和以前一樣）。
 */
import type { AdoWorkItemFilter } from "./desktop.ts";
import { t } from "./i18n.ts";
import { choiceList } from "./multi-choice.ts";

/** 狀態篩選的一個選項（後端 `ado_work_item_filters` 的 `states`）。 */
export interface StateOption {
  name: string;
  /** 「已結束」的狀態（Closed、Done、Removed…）。 */
  closed: boolean;
}

export const DEFAULT_WORK_ITEM_FILTER: AdoWorkItemFilter = {
  role: "assigned",
  person: "@me",
  state: "open",
  states: [],
  kinds: [],
  projects: [],
  areas: [],
};

/** 讀回存起來的篩選條件；舊版存的是單一的 kind、project、area，沒有 states。 */
export function parseWorkItemFilter(raw: string | null): AdoWorkItemFilter {
  try {
    const v = JSON.parse(raw ?? "{}") as Partial<AdoWorkItemFilter> & Record<"kind" | "project" | "area", unknown>;
    const projects = choiceList(v.projects ?? v.project);
    return {
      role: v.role === "created" ? "created" : "assigned",
      person: typeof v.person === "string" ? v.person : "@me",
      state: v.state === "closed" || v.state === "all" ? v.state : "open",
      states: choiceList(v.states),
      kinds: choiceList(v.kinds ?? v.kind),
      projects,
      areas: projects.length ? choiceList(v.areas ?? v.area) : [],
    };
  } catch {
    return { ...DEFAULT_WORK_ITEM_FILTER };
  }
}

/** 和預設的條件一樣（指派給我、進行中、不限類型與專案）。 */
export function isDefaultWorkItemFilter(f: AdoWorkItemFilter): boolean {
  return (
    f.role === "assigned" &&
    f.person === "@me" &&
    f.state === "open" &&
    !f.states.length &&
    !f.kinds.length &&
    !f.projects.length &&
    !f.areas.length
  );
}

/** 讀不到狀態清單時的兩個選項（值不會和狀態名稱撞在一起）。 */
const OPEN = ":open";
const CLOSED = ":closed";

/** 狀態選單的選項（值、顯示的文字）。 */
export function stateOptions(states: readonly StateOption[]): [string, string][] {
  if (!states.length) {
    return [
      [OPEN, t("進行中")],
      [CLOSED, t("已結束")],
    ];
  }
  return states.map((s) => [s.name, s.name]);
}

/** 篩選條件在狀態選單上要勾哪些（空的是不限）。 */
export function stateChoice(f: AdoWorkItemFilter, states: readonly StateOption[]): string[] {
  if (f.states.length) return [...f.states];
  if (f.state === "all") return [];
  if (!states.length) return [f.state === "open" ? OPEN : CLOSED];
  return states.filter((s) => s.closed === (f.state === "closed")).map((s) => s.name);
}

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const set = new Set(a.map((v) => v.toLowerCase()));
  return set.size === b.length && b.every((v) => set.has(v.toLowerCase()));
};

/** 狀態選單勾的 → 篩選條件的 `state` 與 `states`。 */
export function fromStateChoice(picked: readonly string[], states: readonly StateOption[]): Pick<AdoWorkItemFilter, "state" | "states"> {
  if (!picked.length) return { state: "all", states: [] };
  if (picked.includes(OPEN) || picked.includes(CLOSED)) {
    if (picked.length !== 1) return { state: "all", states: [] };
    return { state: picked[0] === OPEN ? "open" : "closed", states: [] };
  }
  const open = states.filter((s) => !s.closed).map((s) => s.name);
  const closed = states.filter((s) => s.closed).map((s) => s.name);
  if (open.length && sameSet(picked, open)) return { state: "open", states: [] };
  if (closed.length && sameSet(picked, closed)) return { state: "closed", states: [] };
  return { state: "all", states: [...picked] };
}

/** 按鈕上的文字：「進行中」「已結束」照舊；指定狀態時是 null（列出狀態名稱）。 */
export function stateLabel(f: AdoWorkItemFilter): string | null {
  if (f.states.length) return null;
  if (f.state === "open") return t("進行中");
  if (f.state === "closed") return t("已結束");
  return null;
}
