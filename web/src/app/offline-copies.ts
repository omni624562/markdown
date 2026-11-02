/**
 * 離線副本：看過的工作項目、Wiki 頁面與圖片存一份在本機，連不上時拿來顯示。
 */
import { desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { workItemMarkdown } from "../issue-doc.ts";
import { parseKept, type KeptPage, type OfflineRef, addImage, keep } from "../offline.ts";
import * as storage from "../storage.ts";
import type { IssueOffline } from "../ui/issue-view.ts";
import { Picker } from "../ui/picker.ts";
import { toast } from "../ui/toast.ts";
import { wikiMarkdown } from "../wiki-text.ts";
import { CopyCache } from "../copy-cache.ts";
export { type Freshness, freshnessOf, keepFreshness } from "../copy-cache.ts";
import { app } from "./context.ts";

/** 「保留離線」的頁面（不會自動刪掉，連線時在背景更新）。 */
export let keptPages = parseKept(storage.load("offline-kept"));
function saveKept(list: KeptPage[]): void {
  keptPages = list;
  storage.save("offline-kept", JSON.stringify(list));
}
const isKept = (key: string) => keptPages.some((p) => p.key === key);
/** 開過的頁面怎麼重新讀取（檢視的 key → 資料），可以保留離線的才有。 */
export const offlineRefs = new Map<string, OfflineRef>();
/** 這次執行已經存過的圖片（同一張不重複寫入）。 */
const savedImages = new Set<string>();

/** 讀圖片並存一份離線副本；讀不到時改用副本。 */
export async function offlineImage(key: string, fetch: () => Promise<string>): Promise<string> {
  const page = app.issueKey;
  try {
    const url = await fetch();
    const kept = !!page && isKept(page);
    if (desktop && !savedImages.has(key)) {
      savedImages.add(key);
      void desktop.offlinePut(key, url, kept).catch(() => savedImages.delete(key));
    }
    if (kept) saveKept(addImage(keptPages, page, key));
    return url;
  } catch (e) {
    const copy = await desktop?.offlineGet(key).catch(() => null);
    if (copy && /^data:image\/(?!svg)/i.test(copy)) return copy;
    throw e;
  }
}

/** 清單的副本（Wiki、頁面樹、工作項目、工作板）：存在本機的離線資料夾。 */
const copies = new CopyCache({
  get: async (key) => (desktop ? desktop.offlineGet(`list:${key}`) : null),
  put: async (key, raw) => void (await desktop?.offlinePut(`list:${key}`, raw, false)),
});

let offlineNoticeAt = 0;
function offlineNotice(): void {
  if (Date.now() - offlineNoticeAt < 60_000) return;
  offlineNoticeAt = Date.now();
  toast(t("連不上伺服器，先顯示上次存下的離線副本"));
}

/**
 * 讀清單並存一份副本；連不上時改用副本，並提示一次。
 * 給了 `onUpdate` 時，有副本就先回傳副本（不用等伺服器），背景讀完再呼叫它（通常是重新整理畫面，
 * 這時再呼叫一次會直接拿到剛讀到的結果）。是不是副本、什麼時候存的，用 `freshnessOf` 看。
 * `quiet`：改用副本時不提示（背景檢查用）。
 */
export function withOfflineCopy<T>(key: string, fetch: () => Promise<T>, onUpdate?: (changed: boolean) => void, quiet = false): Promise<T> {
  return copies.get(key, fetch, { onUpdate, onOffline: quiet ? undefined : offlineNotice });
}

/** 忘掉剛讀到的清單：下次一定向伺服器讀（按「重新整理」、網路恢復時）。 */
export function forgetListCopies(prefix = ""): void {
  copies.forget(prefix);
}

function pageCopy(markdown: string, savedAt = Date.now()): string {
  return JSON.stringify({ markdown, savedAt });
}

/** 背景更新「保留離線」的頁面（啟動後、網路恢復時；最多每 30 分鐘一次）。 */
let keptRefreshed = 0;
export async function refreshKeptPages(): Promise<void> {
  if (!desktop || !app.ado?.account || !keptPages.length || Date.now() - keptRefreshed < 30 * 60_000) return;
  keptRefreshed = Date.now();
  for (const page of [...keptPages]) {
    try {
      const ref = page.ref;
      const markdown =
        ref.type === "ado"
          ? workItemMarkdown(await desktop.adoWorkItem(ref.item.id))
          : wikiMarkdown((await desktop.adoWikiPage(ref.wiki, ref.path)).content);
      if (!isKept(page.key)) continue;
      await desktop.offlinePut(`page:${page.key}`, pageCopy(markdown), true);
      saveKept(keptPages.map((p) => (p.key === page.key ? { ...p, savedAt: Date.now() } : p)));
    } catch {
      // 連不上（或頁面已刪除）：下次再試。
      keptRefreshed = Math.min(keptRefreshed, Date.now() - 25 * 60_000);
      return;
    }
  }
}

export // 在 init 時建立。
let issueOffline: IssueOffline | undefined;

/** 列出「保留離線」的頁面，選一頁開啟（離線時顯示存下的內容）。 */
export // 在 init 時建立。
let keptPicker: Picker<KeptPage>;

export function initOfflineCopies(): void {
  issueOffline = desktop
    ? {
        save(source, markdown) {
          const kept = isKept(source.key);
          void desktop!.offlinePut(`page:${source.key}`, pageCopy(markdown), kept).catch(() => {});
          if (kept) saveKept(keptPages.map((p) => (p.key === source.key ? { ...p, savedAt: Date.now() } : p)));
        },
        async load(source) {
          const raw = await desktop!.offlineGet(`page:${source.key}`);
          if (!raw) return null;
          try {
            const v = JSON.parse(raw) as { markdown?: unknown; savedAt?: unknown };
            return typeof v.markdown === "string" ? { markdown: v.markdown, savedAt: typeof v.savedAt === "number" ? v.savedAt : 0 } : null;
          } catch {
            return null;
          }
        },
        kept: (source) => (isKept(source.key) ? true : offlineRefs.has(source.key) ? false : null),
        toggle(source, markdown) {
          const old = keptPages.find((p) => p.key === source.key);
          if (old) {
            saveKept(keptPages.filter((p) => p.key !== source.key));
            for (const key of [`page:${source.key}`, ...old.images]) void desktop!.offlineRelease(key).catch(() => {});
            toast(t("已取消保留離線"));
            return;
          }
          const ref = offlineRefs.get(source.key);
          if (!ref) return;
          // 畫面上已經讀到的圖片一起保留。
          const images: string[] = [];
          for (const img of document.querySelectorAll<HTMLImageElement>(".issue-pane:not(.history-pane) img[data-offline-key]")) {
            const key = img.dataset.offlineKey!;
            if (!img.src.startsWith("data:")) continue;
            images.push(key);
            savedImages.add(key);
            void desktop!.offlinePut(key, img.src, true).catch(() => {});
          }
          saveKept(keep(keptPages, { key: source.key, title: source.title, label: source.label, ref, images, savedAt: Date.now() }));
          void desktop!.offlinePut(`page:${source.key}`, pageCopy(markdown), true).catch(app.reportError);
          toast(t("已保留離線：沒有網路時也能開啟（指令面板的「保留離線的頁面」）"));
        },
      }
    : undefined;
  keptPicker = new Picker<KeptPage>({
    label: t("保留離線的頁面"),
    placeholder: t("輸入標題"),
    empty: t("還沒有保留離線的頁面。在工作項目或 Wiki 頁面的分頁上按右鍵，選「保留離線」。"),
    query(q) {
      const needle = q.trim().toLowerCase();
      return needle ? keptPages.filter((p) => `${p.label} ${p.title}`.toLowerCase().includes(needle)) : keptPages;
    },
    render: (p) => ({
      title: p.title,
      detail: p.savedAt ? t("{label}・{time} 更新", { label: p.label, time: new Date(p.savedAt).toLocaleString() }) : p.label,
      icon: p.ref.type === "ado" ? "square-kanban" : "book-open-text",
    }),
    pick(p) {
      if (p.ref.type === "ado") app.showWorkItem(p.ref.item);
      else app.showWikiPage(p.ref.wiki, p.ref.path);
    },
  });
}
