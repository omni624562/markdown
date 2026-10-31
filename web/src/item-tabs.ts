/**
 * 工作項目、Wiki 頁面等唯讀內容的分頁（和文件的分頁排在同一列）。
 * 這裡只有資料的處理（開在哪個分頁、關掉後切到哪裡、存下與讀回），畫面在 app/item-tabs.ts。
 */

import { type Shortcut, toShortcut } from "./wiki-shortcuts.ts";

/** 開啟一項內容時放在哪裡：`same` 已經開著、`preview` 換掉預覽分頁、`new` 新開一個分頁。 */
export type ItemPlace = { kind: "same" | "preview"; index: number } | { kind: "new" };

/**
 * 決定開在哪個分頁：已經開著就切過去；否則換掉預覽分頁（點清單上的另一項時不會開出一排分頁）；
 * `keep` 是要留著的（例如雙擊清單上的項目），或沒有預覽分頁時新開一個。
 */
export function placeItem(tabs: readonly { key: string; preview: boolean }[], key: string, keep: boolean): ItemPlace {
  const same = tabs.findIndex((t) => t.key === key);
  if (same >= 0) return { kind: "same", index: same };
  const preview = keep ? -1 : tabs.findIndex((t) => t.preview);
  return preview >= 0 ? { kind: "preview", index: preview } : { kind: "new" };
}

/** 關掉 `closing` 之後切到哪一個分頁：右邊那一個，最右邊時改左邊；沒有其他分頁時回傳 null。 */
export function neighborAfterClose(ids: readonly string[], closing: string): string | null {
  const i = ids.indexOf(closing);
  if (i < 0) return null;
  return ids[i + 1] ?? ids[i - 1] ?? null;
}

/** 排分頁需要的資料：項目分頁接在哪個文件分頁後面（`after`，null 是排在一般分頁的最前面）、有沒有固定。 */
export interface ItemPlacing {
  id: string;
  after: string | null;
  pinned: boolean;
}

/**
 * 分頁列上的順序：固定的文件、固定的項目，接著是一般分頁——每個文件後面跟著接在它後面的項目分頁。
 * 接在固定文件後面的排到一般分頁最前面；接的文件不在了（例如切換到別的專案）的排到最後面。
 */
export function arrangeTabs(docs: readonly { id: string; pinned?: boolean }[], items: readonly ItemPlacing[]): string[] {
  const pinnedDocs = new Set(docs.filter((d) => d.pinned).map((d) => d.id));
  const known = new Set(docs.map((d) => d.id));
  const anchor = (i: ItemPlacing): string | null | undefined =>
    i.after === null || pinnedDocs.has(i.after) ? null : known.has(i.after) ? i.after : undefined;
  const loose = items.filter((i) => !i.pinned);
  const group = (a: string | null | undefined) => loose.filter((i) => anchor(i) === a).map((i) => i.id);
  return [
    ...docs.filter((d) => d.pinned).map((d) => d.id),
    ...items.filter((i) => i.pinned).map((i) => i.id),
    ...group(null),
    ...docs.filter((d) => !d.pinned).flatMap((d) => [d.id, ...group(d.id)]),
    ...group(undefined),
  ];
}

/**
 * 新的項目分頁放在目前分頁的右邊：回傳接在哪個文件後面，與插在項目清單的哪個位置。
 * `current` 是目前的分頁（文件或項目的 id）。
 */
export function placeNewItem(
  docs: readonly { id: string; pinned?: boolean }[],
  items: readonly ItemPlacing[],
  current: string,
): { after: string | null; index: number } {
  const item = items.findIndex((i) => i.id === current);
  if (item >= 0) {
    const cur = items[item];
    // 固定的項目在最前面一區：新的放在一般分頁最前面。
    if (cur.pinned) return { after: null, index: firstOf(items, null) };
    return { after: cur.after, index: item + 1 };
  }
  const doc = docs.find((d) => d.id === current);
  const after = doc && !doc.pinned ? doc.id : null;
  return { after, index: firstOf(items, after) };
}

/** 接在 `after` 後面的第一個項目的位置（沒有時放最後面）。 */
function firstOf(items: readonly ItemPlacing[], after: string | null): number {
  const i = items.findIndex((x) => !x.pinned && x.after === after);
  return i < 0 ? items.length : i;
}

/** 存下來、下次開啟時還原的分頁（只有工作項目與 Wiki 頁面，其他的不知道怎麼重新開啟）。 */
export interface SavedItemTab {
  key: string;
  name: string;
  /** 滑鼠提示，例如「Task 123：標題」。 */
  title: string;
  /** 來源（`ado`、`wiki`），決定圖示。 */
  origin: "ado" | "wiki";
  preview: boolean;
  ref: Shortcut;
  /** 接在哪個文件分頁後面（null 是一般分頁的最前面）。 */
  after: string | null;
  pinned: boolean;
}

/** 存下來的分頁最多幾個。 */
export const SAVED_ITEM_TABS_LIMIT = 30;

/** 讀回存下的分頁；格式不對的略過。 */
export function parseSavedItemTabs(raw: string | null): SavedItemTab[] {
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: SavedItemTab[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const ref = toShortcut(o.ref);
    if (!ref || typeof o.key !== "string" || typeof o.name !== "string" || (o.origin !== "ado" && o.origin !== "wiki")) continue;
    if (out.some((t) => t.key === o.key)) continue;
    const pinned = o.pinned === true;
    out.push({
      key: o.key,
      name: o.name,
      title: typeof o.title === "string" ? o.title : o.name,
      origin: o.origin,
      // 固定的分頁不是預覽分頁。
      preview: o.preview === true && !pinned,
      ref,
      after: typeof o.after === "string" ? o.after : null,
      pinned,
    });
  }
  // 預覽分頁最多一個（多的當成一般分頁）。
  let seen = false;
  for (const t of out) {
    if (t.preview && seen) t.preview = false;
    seen ||= t.preview;
  }
  return out.slice(0, SAVED_ITEM_TABS_LIMIT);
}
