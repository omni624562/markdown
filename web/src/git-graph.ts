/**
 * Git 歷史的線圖排版：每個提交放在第幾條線（lane），以及每一列上半段、下半段的線怎麼接。
 * 只算位置，不碰畫面（畫圖在 history-view）。
 *
 * 做法：由上往下（新到舊）走，`lanes[i]` 記住第 i 條線「接下來等的是哪個提交」。
 * - 提交出現時，放在第一條等它的線上；好幾條線都在等它（分支在這裡分開）時，其他線在這裡收進來。
 * - 第一個上層提交接在同一條線往下（就算別條線也在等它）；其他上層提交（合併）另外開一條線，
 *   已經有線在等它時就接過去。
 * 線的顏色跟著線走：開新的線時換下一個顏色。
 */

export interface GraphInput {
  id: string;
  parents: string[];
}

/** 一段線：從第 `from` 條線到第 `to` 條線（同一條時是直線，不同時是曲線）。 */
export interface Segment {
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  /** 提交的圓點在第幾條線。 */
  lane: number;
  color: number;
  /** 上半段（從上一列接到這一列中間）。 */
  top: Segment[];
  /** 下半段（從這一列中間接到下一列）。 */
  bottom: Segment[];
}

export interface GraphLayout {
  rows: GraphRow[];
  /** 最多同時有幾條線（決定線圖的寬度）。 */
  width: number;
}

/** 接續排版（載入下一頁時不用從頭算）。 */
export class GraphBuilder {
  #lanes: (string | null)[] = [];
  #colors: number[] = [];
  #next = 0;
  #palette: number;
  width = 0;

  constructor(palette = 8) {
    this.#palette = palette;
  }

  #newColor(): number {
    const c = this.#next % this.#palette;
    this.#next++;
    return c;
  }

  #freeSlot(): number {
    const i = this.#lanes.indexOf(null);
    return i < 0 ? this.#lanes.length : i;
  }

  add(commit: GraphInput): GraphRow {
    const lanes = this.#lanes;
    const colors = this.#colors;
    const before = lanes.slice();
    const beforeColors = colors.slice();
    const waiting = before.flatMap((id, i) => (id === commit.id ? [i] : []));
    let lane = waiting[0] ?? this.#freeSlot();
    if (!waiting.length) colors[lane] = this.#newColor();
    const color = colors[lane];

    const top: Segment[] = [];
    before.forEach((id, i) => {
      if (id === null) return;
      top.push({ from: i, to: id === commit.id ? lane : i, color: beforeColors[i] });
    });
    for (const i of waiting) lanes[i] = null;
    lanes[lane] = null;

    const bottom: Segment[] = [];
    const assigned = new Set<number>();
    commit.parents.forEach((parent, k) => {
      // 第一個上層提交一律留在同一條線：分支在上層提交那一列才收回來，看得出從哪裡分出去。
      const existing = k === 0 ? -1 : lanes.indexOf(parent);
      if (existing >= 0) {
        bottom.push({ from: lane, to: existing, color: colors[existing] });
        return;
      }
      const slot = k === 0 ? lane : this.#freeSlot();
      lanes[slot] = parent;
      colors[slot] = k === 0 ? color : this.#newColor();
      assigned.add(slot);
      bottom.push({ from: lane, to: slot, color: colors[slot] });
    });
    lanes.forEach((id, i) => {
      if (id !== null && !assigned.has(i) && before[i] === id) bottom.push({ from: i, to: i, color: colors[i] });
    });
    while (lanes.length && lanes[lanes.length - 1] === null) {
      lanes.pop();
      colors.length = lanes.length;
    }
    this.width = Math.max(this.width, before.length, lane + 1, lanes.length);
    return { lane, color, top, bottom };
  }
}

export function layoutGraph(commits: GraphInput[], palette = 8): GraphLayout {
  const b = new GraphBuilder(palette);
  const rows = commits.map((c) => b.add(c));
  return { rows, width: b.width };
}
