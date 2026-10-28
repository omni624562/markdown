/** 「保留離線」的頁面清單（存在 localStorage，不碰畫面，方便測試）。 */
import type { AdoWiki, AdoWorkItem } from "./desktop.ts";

/** 重新讀取這一頁需要的資料（背景更新、從清單開啟時用）。 */
export type OfflineRef = { type: "ado"; item: AdoWorkItem } | { type: "wiki"; wiki: AdoWiki; path: string };

export interface KeptPage {
  /** 和工作項目檢視的 key 相同（`ado:123`、`wiki:{id}:{path}`）。 */
  key: string;
  title: string;
  label: string;
  ref: OfflineRef;
  /** 這一頁的圖片存在離線副本裡的鍵（取消保留時一起放掉）。 */
  images: string[];
  /** 上次存下內容的時間（毫秒）。 */
  savedAt: number;
}

/** 最多保留幾頁。 */
export const KEPT_LIMIT = 200;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function validRef(v: unknown): v is OfflineRef {
  if (!isObject(v)) return false;
  if (v.type === "ado") return isObject(v.item) && typeof v.item.id === "number" && typeof v.item.title === "string";
  if (v.type === "wiki") return isObject(v.wiki) && typeof v.wiki.id === "string" && typeof v.path === "string";
  return false;
}

/** 讀回存起來的清單；格式不對的項目略過。 */
export function parseKept(raw: string | null): KeptPage[] {
  let v: unknown;
  try {
    v = JSON.parse(raw ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: KeptPage[] = [];
  for (const p of v) {
    if (!isObject(p) || typeof p.key !== "string" || seen.has(p.key) || !validRef(p.ref)) continue;
    seen.add(p.key);
    out.push({
      key: p.key,
      title: typeof p.title === "string" ? p.title : p.key,
      label: typeof p.label === "string" ? p.label : "",
      ref: p.ref,
      images: Array.isArray(p.images) ? p.images.filter((i): i is string => typeof i === "string") : [],
      savedAt: typeof p.savedAt === "number" ? p.savedAt : 0,
    });
  }
  return out.slice(0, KEPT_LIMIT);
}

/** 加入或更新一頁（放在最前面）。 */
export function keep(list: readonly KeptPage[], page: KeptPage): KeptPage[] {
  const old = list.find((p) => p.key === page.key);
  const images = old ? [...new Set([...old.images, ...page.images])] : page.images;
  return [{ ...page, images }, ...list.filter((p) => p.key !== page.key)].slice(0, KEPT_LIMIT);
}

/** 記下這一頁用到的圖片；不在清單裡就不變。 */
export function addImage(list: readonly KeptPage[], key: string, image: string): KeptPage[] {
  return list.map((p) => (p.key === key && !p.images.includes(image) ? { ...p, images: [...p.images, image] } : p));
}
