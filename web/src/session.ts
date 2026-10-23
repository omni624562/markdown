/**
 * 分頁的保存與還原：每個分頁的基本資料存在 `tabs`（各專案存在 `tabs@資料夾路徑`），
 * 內容草稿各自存在 `draft:<id>`。重新開啟時依此還原分頁，未存檔的內容也不會遺失。
 */
import { type DocKind, isKind } from "./kinds.ts";
import { t } from "./i18n.ts";
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

/** 分頁存在哪個鍵：沒有開啟資料夾時的分頁存在 `tabs`，各專案存在 `tabs@資料夾路徑`。 */
export function sessionKey(scope: string | null): string {
  return scope ? `tabs@${scope}` : "tabs";
}

function parseSession(raw: string | null): Session | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { docs?: unknown[]; activeId?: string };
    const docs = (parsed.docs ?? []).filter(validMeta).map((d) => ({
      ...d,
      path: typeof d.path === "string" ? d.path : null,
      baseline: typeof d.baseline === "string" && d.baseline ? d.baseline : null,
      fileBacked: d.fileBacked === true,
      pinned: d.pinned === true,
    }));
    if (!docs.length) return null;
    const activeId = docs.some((d) => d.id === parsed.activeId) ? parsed.activeId! : docs[0].id;
    return { docs, activeId };
  } catch {
    // 損毀時當作沒有保存的分頁。
    return null;
  }
}

/** 只讀取專案保存的分頁（不接手共用的分頁，也不改任何資料）。 */
export function peekSession(scope: string): Session | null {
  return parseSession(storage.load(sessionKey(scope)));
}

/**
 * 讀取保存的分頁；第一次使用新版時，把舊版「單一文件」的資料轉成一個分頁。
 * 專案還沒有自己的分頁時，接手 `tabs`（舊版所有分頁共用的清單，或開資料夾前開著的分頁）。
 */
export function loadSession(scope: string | null = null): Session | null {
  let raw = storage.load(sessionKey(scope));
  if (raw === null && scope) {
    raw = storage.load("tabs");
    if (raw !== null) {
      storage.save(sessionKey(scope), raw);
      storage.remove("tabs");
    }
  }
  const session = parseSession(raw);
  if (session) return session;
  if (scope) return null;
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
        name: storage.load("name") ?? t("未命名.md"),
        kind: isKind(kind) ? kind : "markdown",
        path: null,
        baseline: storage.load("baseline") || null,
        fileBacked: storage.load("file-backed") === "1",
      },
    ],
  };
}

export function saveSession(session: Session, scope: string | null = null): void {
  storage.save(sessionKey(scope), JSON.stringify(session));
}

/** 專案的檔案樹展開到哪裡。 */
export interface ProjectView {
  expanded: string[];
}

/** 最多記住幾個展開的資料夾。 */
const MAX_EXPANDED = 300;

export function loadProjectView(scope: string): ProjectView {
  try {
    const v = JSON.parse(storage.load(`view@${scope}`) ?? "{}") as Partial<ProjectView>;
    return { expanded: Array.isArray(v.expanded) ? v.expanded.filter((x): x is string => typeof x === "string") : [] };
  } catch {
    return { expanded: [] };
  }
}

export function saveProjectView(scope: string, view: ProjectView): void {
  storage.save(`view@${scope}`, JSON.stringify({ expanded: view.expanded.slice(0, MAX_EXPANDED) }));
}

export function loadDraft(id: string): string | null {
  return storage.load(`draft:${id}`);
}

export function saveDraft(id: string, text: string): boolean {
  return storage.save(`draft:${id}`, text);
}

/**
 * 沒有任何分頁清單（`tabs`、`tabs@…`）用到的草稿 id：分頁關掉、專案移除後留下的。
 * 有分頁清單讀不懂時一律不清（寧可留著，也不要誤刪別人的草稿）。
 */
export function orphanDraftIds(sessions: (string | null)[], draftIds: string[]): string[] {
  const used = new Set<string>();
  for (const raw of sessions) {
    if (!raw) continue;
    let parsed: { docs?: { id?: unknown }[] };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      return [];
    }
    if (!parsed || !Array.isArray(parsed.docs)) return [];
    for (const d of parsed.docs) if (typeof d?.id === "string") used.add(d.id);
  }
  return draftIds.filter((id) => !used.has(id));
}

/** 清掉沒有分頁用到的草稿，回傳清掉幾個。 */
export function dropOrphanDrafts(): number {
  const sessions = storage
    .keys("tabs")
    .filter((k) => k === "tabs" || k.startsWith("tabs@"))
    .map((k) => storage.load(k));
  const drafts = storage.keys("draft:").map((k) => k.slice("draft:".length));
  const orphans = orphanDraftIds(sessions, drafts);
  for (const id of orphans) dropDraft(id);
  return orphans.length;
}

export function dropDraft(id: string): void {
  storage.remove(`draft:${id}`);
}
