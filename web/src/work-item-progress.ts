/**
 * 工作項目的進度（Feature、Story 底下的子項目完成了多少）：依狀態分成完成、待驗證、進行中、還沒開始，
 * 顏色和清單上的狀態圓點一樣（`stateTone`）。移除的不算進去。
 * 「依工時」時用剩餘與已完成工時（Task 才有）；都沒填工時時沒有工時的進度。
 */
import { type StateTone, stateTone } from "./issue-doc.ts";
import type { TreeNode } from "./workitem-groups.ts";

export interface ProgressItem {
  state: string;
  remaining?: number | null;
  completed?: number | null;
}

/** 長條上的順序：完成、待驗證、進行中、還沒開始。 */
export const PROGRESS_TONES = ["closed", "resolved", "active", "new"] as const satisfies readonly StateTone[];
export type ProgressTone = (typeof PROGRESS_TONES)[number];

export interface Progress {
  /** 各類的數量（不含移除的）。 */
  counts: Record<ProgressTone, number>;
  total: number;
  /** 各類裡的狀態名稱與數量（例如完成：Closed 3、Done 1），照第一次出現的順序。 */
  states: Record<ProgressTone, [string, number][]>;
  /** 剩餘、已完成工時的合計；沒有任何一項填工時時是 null。 */
  remaining: number | null;
  completed: number | null;
}

export function progressOf(items: readonly ProgressItem[]): Progress {
  const counts = { closed: 0, resolved: 0, active: 0, new: 0 };
  const states: Record<ProgressTone, [string, number][]> = { closed: [], resolved: [], active: [], new: [] };
  let remaining: number | null = null;
  let completed: number | null = null;
  for (const it of items) {
    const tone = stateTone(it.state);
    if (tone === "removed") continue;
    counts[tone]++;
    const list = states[tone];
    const name = it.state.trim();
    const found = list.find(([s]) => s === name);
    if (found) found[1]++;
    else list.push([name, 1]);
    if (typeof it.remaining === "number" && Number.isFinite(it.remaining)) remaining = (remaining ?? 0) + it.remaining;
    if (typeof it.completed === "number" && Number.isFinite(it.completed)) completed = (completed ?? 0) + it.completed;
  }
  const total = counts.closed + counts.resolved + counts.active + counts.new;
  return { counts, total, states, remaining, completed };
}

/** 完成的比例（0～1）；沒有項目時是 null。 */
export function doneRatio(p: Progress): number | null {
  return p.total ? p.counts.closed / p.total : null;
}

/** 依工時的完成比例：已完成 ÷（已完成＋剩餘）；沒有工時時是 null。 */
export function hoursRatio(p: Progress): number | null {
  const done = p.completed ?? 0;
  const all = done + (p.remaining ?? 0);
  return p.remaining === null && p.completed === null ? null : all > 0 ? done / all : null;
}

/**
 * 節點底下最下層的項目（沒有子項目的，例如 Feature 底下所有的 Task）；淡色的（不在清單上）不算。
 * Feature 的進度是底下所有 Task 的進度，不是 Story 的數量。
 */
export function leaves<T>(node: TreeNode<T>): T[] {
  const out: T[] = [];
  const walk = (n: TreeNode<T>) => {
    for (const c of n.children) {
      if (c.children.length) walk(c);
      else if (!c.dim) out.push(c.item);
    }
  };
  walk(node);
  return out;
}

/** 工時的寫法：整數不帶小數點，其他留一位（`9`、`2.5`）。 */
export function hoursText(h: number): string {
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}
