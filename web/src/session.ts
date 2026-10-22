/**
 * 分頁的保存與還原：每個分頁的基本資料存在 `tabs`，內容草稿各自存在 `draft:<id>`。
 * 重新開啟時依此還原分頁，未存檔的內容也不會遺失。
 */
import { type DocKind, isKind } from "./kinds.ts";
import * as storage from "./storage.ts";

export interface DocMeta {
  id: string;
  name: string;
  kind: DocKind;
  /** 桌面版：檔案在磁碟上的路徑。 */
  path: string | null;
  /** 最後一次開檔／存檔時內容的雜湊；目前內容與它不同就代表有未存檔的變更。 */
  baseline: string | null;
  /** 內容是否對應到一個實際存過或開啟過的檔案。 */
  fileBacked: boolean;
  /** 固定的分頁：排在最左邊，「關閉其他分頁」不會關掉它。 */
  pinned?: boolean;
}

export interface Session {
  docs: DocMeta[];
  activeId: string;
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function validMeta(m: unknown): m is DocMeta {
  if (!m || typeof m !== "object") return false;
  const d = m as Record<string, unknown>;
  return typeof d.id === "string" && typeof d.name === "string" && isKind(d.kind);
}

/** 讀取保存的分頁；第一次使用新版時，把舊版「單一文件」的資料轉成一個分頁。 */
export function loadSession(): Session | null {
  const raw = storage.load("tabs");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { docs?: unknown[]; activeId?: string };
      const docs = (parsed.docs ?? []).filter(validMeta).map((d) => ({
        ...d,
        path: typeof d.path === "string" ? d.path : null,
        baseline: typeof d.baseline === "string" && d.baseline ? d.baseline : null,
        fileBacked: d.fileBacked === true,
        pinned: d.pinned === true,
      }));
      if (docs.length) {
        const activeId = docs.some((d) => d.id === parsed.activeId) ? parsed.activeId! : docs[0].id;
        return { docs, activeId };
      }
    } catch {
      // 損毀時當作沒有保存的分頁。
    }
  }
  const oldDoc = storage.load("doc");
  if (oldDoc === null) return null;
  const kind = storage.load("kind");
  const id = newId();
  saveDraft(id, oldDoc);
  return {
    activeId: id,
    docs: [
      {
        id,
        name: storage.load("name") ?? "未命名.md",
        kind: isKind(kind) ? kind : "markdown",
        path: null,
        baseline: storage.load("baseline") || null,
        fileBacked: storage.load("file-backed") === "1",
      },
    ],
  };
}

export function saveSession(session: Session): void {
  storage.save("tabs", JSON.stringify(session));
}

export function loadDraft(id: string): string | null {
  return storage.load(`draft:${id}`);
}

export function saveDraft(id: string, text: string): boolean {
  return storage.save(`draft:${id}`, text);
}

export function dropDraft(id: string): void {
  storage.remove(`draft:${id}`);
}
