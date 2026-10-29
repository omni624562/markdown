/**
 * 左側圖示列上的捷徑：常看的 Wiki 頁面、工作項目（例如 User Story、Feature）放到圖示列，點一下開啟。
 * 這裡只有資料的處理（讀寫、去重、顯示的字與顏色），畫面在 main.ts。
 */

export interface WikiShortcut {
  /** Wiki 的 id。 */
  wiki: string;
  /** Wiki 的名稱（滑鼠提示用；舊的釘選搬過來時不知道，開啟後補上）。 */
  wikiName: string;
  /** 頁面路徑，例如 `/產品/安裝`。 */
  path: string;
}

export interface WorkItemShortcut {
  /** 工作項目編號。 */
  workItem: number;
  /** 類型，例如 `User Story`（決定圖示的顏色）。 */
  kind: string;
  /** 標題（滑鼠提示、圖示上的字；開啟後更新）。 */
  title: string;
}

export type Shortcut = WikiShortcut | WorkItemShortcut;

/** 圖示列最多放幾個捷徑。 */
export const SHORTCUT_LIMIT = 12;

/** 拖曳 Wiki 頁面、工作項目時帶的資料型別（放到圖示列上變成捷徑）。 */
export const SHORTCUT_DRAG_TYPE = "application/x-omarker-shortcut";

export function isWorkItemShortcut(s: Shortcut): s is WorkItemShortcut {
  return "workItem" in s;
}

/** 檢查格式並只留需要的欄位；格式不對回傳 null。 */
function toShortcut(v: unknown): Shortcut | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.workItem === "number") {
    if (!Number.isInteger(o.workItem) || o.workItem <= 0 || typeof o.kind !== "string" || typeof o.title !== "string") return null;
    return { workItem: o.workItem, kind: o.kind, title: o.title };
  }
  const wikiName = o.wikiName ?? "";
  if (typeof o.wiki !== "string" || typeof o.path !== "string" || !o.path.startsWith("/") || typeof wikiName !== "string") return null;
  return { wiki: o.wiki, wikiName, path: o.path };
}

/** 讀取存下的捷徑；格式不對的略過。 */
export function parseShortcuts(raw: string | null): Shortcut[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .map(toShortcut)
      .filter((s): s is Shortcut => s !== null)
      .slice(0, SHORTCUT_LIMIT);
  } catch {
    return [];
  }
}

/** 讀取拖曳帶過來的 Wiki 頁面或工作項目；都不是時回傳 null。 */
export function parseDraggedShortcut(raw: string): Shortcut | null {
  try {
    return toShortcut(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function sameShortcut(a: Shortcut, b: Shortcut): boolean {
  if (isWorkItemShortcut(a) || isWorkItemShortcut(b)) return isWorkItemShortcut(a) && isWorkItemShortcut(b) && a.workItem === b.workItem;
  return a.wiki === b.wiki && a.path === b.path;
}

/**
 * 把頁面放到第 `index` 個位置（沒給放最後面）；已經有的移過去。
 * 滿了回傳 null（已經有的不算新增，不會滿）。
 */
export function placeShortcut(list: Shortcut[], item: Shortcut, index = list.length): Shortcut[] | null {
  const at = list.findIndex((s) => sameShortcut(s, item));
  if (at < 0 && list.length >= SHORTCUT_LIMIT) return null;
  const rest = list.filter((s) => !sameShortcut(s, item));
  // 原本在前面的移走後，後面的位置往前一格。
  const pos = Math.max(0, Math.min(at >= 0 && at < index ? index - 1 : index, rest.length));
  return [...rest.slice(0, pos), item, ...rest.slice(pos)];
}

/** 舊版每個 Wiki 各自的「已釘選」搬到圖示列（依序、去重、最多 SHORTCUT_LIMIT 個）。 */
export function migratePinned(lists: { wiki: string; pinned: string[] }[]): WikiShortcut[] {
  const out: WikiShortcut[] = [];
  for (const { wiki, pinned } of lists) {
    for (const path of pinned) {
      if (out.length >= SHORTCUT_LIMIT) return out;
      if (path.startsWith("/") && !out.some((s) => s.wiki === wiki && s.path === path)) out.push({ wiki, wikiName: "", path });
    }
  }
  return out;
}

/** 中文、日文、韓文的字（一個字就認得出來）。 */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** 圖示上的字：跳過開頭的符號與 emoji，中文取一個字，英文、數字取兩個。 */
export function shortcutInitial(name: string): string {
  const chars = [...name].filter((c) => /[\p{L}\p{N}]/u.test(c));
  if (!chars.length) return "?";
  if (CJK.test(chars[0])) return chars[0];
  const two = chars.slice(0, 2);
  if (two.length > 1 && CJK.test(two[1])) two.pop();
  return two[0].toUpperCase() + (two[1] ?? "");
}

/** Azure DevOps 常見工作項目類型的顏色（色相，接近 ADO 網頁上的顏色）。 */
const KIND_HUES: Record<string, number> = {
  Epic: 28,
  Feature: 280,
  "User Story": 200,
  "Product Backlog Item": 200,
  Requirement: 200,
  Bug: 355,
  Task: 45,
  Issue: 320,
  Impediment: 320,
};

/** 工作項目圖示的色相：常見類型用固定的顏色，其他依類型名稱。 */
export function workItemHue(kind: string): number {
  return KIND_HUES[kind] ?? shortcutHue(kind);
}

/** 依頁面決定圖示的色相（0–359），同一頁每次都一樣。 */
export function shortcutHue(key: string): number {
  let h = 0;
  for (const c of key) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return h % 360;
}
