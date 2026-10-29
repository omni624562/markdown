/**
 * 左側圖示列上的 Wiki 頁面捷徑：常看的頁面放到圖示列，點一下開啟。
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

/** 圖示列最多放幾個 Wiki 捷徑。 */
export const SHORTCUT_LIMIT = 12;

/** 拖曳 Wiki 頁面時帶的資料型別（放到圖示列上變成捷徑）。 */
export const WIKI_PAGE_DRAG_TYPE = "application/x-omarker-wiki-page";

function isShortcut(v: unknown): v is WikiShortcut {
  const s = v as WikiShortcut;
  return !!s && typeof s.wiki === "string" && typeof s.path === "string" && s.path.startsWith("/") && typeof (s.wikiName ?? "") === "string";
}

/** 讀取存下的捷徑；格式不對的略過。 */
export function parseShortcuts(raw: string | null): WikiShortcut[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(isShortcut).map((s) => ({ wiki: s.wiki, wikiName: s.wikiName ?? "", path: s.path })).slice(0, SHORTCUT_LIMIT);
  } catch {
    return [];
  }
}

/** 讀取拖曳帶過來的頁面；不是 Wiki 頁面時回傳 null。 */
export function parseDraggedPage(raw: string): WikiShortcut | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return isShortcut(v) ? { wiki: v.wiki, wikiName: v.wikiName ?? "", path: v.path } : null;
  } catch {
    return null;
  }
}

export function sameShortcut(a: WikiShortcut, b: WikiShortcut): boolean {
  return a.wiki === b.wiki && a.path === b.path;
}

/**
 * 把頁面放到第 `index` 個位置（沒給放最後面）；已經有的移過去。
 * 滿了回傳 null（已經有的不算新增，不會滿）。
 */
export function placeShortcut(list: WikiShortcut[], item: WikiShortcut, index = list.length): WikiShortcut[] | null {
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

/** 依頁面決定圖示的色相（0–359），同一頁每次都一樣。 */
export function shortcutHue(key: string): number {
  let h = 0;
  for (const c of key) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return h % 360;
}
