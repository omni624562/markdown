/**
 * 資料夾文件索引：記住資料夾中每份 Markdown 文件的內容與解析結果，只重讀有改過的檔案。
 * 已開啟的分頁以編輯器中的內容為準（包含還沒存檔的變更）。
 */
import type { DocText } from "./desktop.ts";
import { type DocInfo, parseDoc } from "./doc-index.ts";

export interface IndexedDoc {
  /** 檔案路徑；還沒存成檔案的分頁是 null。 */
  path: string | null;
  /** 顯示用的名稱（資料夾中的相對路徑，或分頁名稱）。 */
  rel: string;
  text: string;
  info: DocInfo;
  /** 對應的分頁 id（有開啟時）。 */
  tabId?: string;
}

export interface OpenDoc {
  id: string;
  path: string | null;
  name: string;
  text: string;
}

interface Entry {
  rel: string;
  mtime: number;
  text: string;
  info?: DocInfo;
}

export class WorkspaceIndex {
  #root: string | null = null;
  #files = new Map<string, Entry>();
  /** 已開啟分頁的解析結果（內容沒變就沿用）。 */
  #open = new Map<string, { text: string; info: DocInfo }>();
  #pending: Promise<void> | null = null;
  #scan: (known: Record<string, number>, root: string) => Promise<DocText[]>;

  constructor(scan: (known: Record<string, number>, root: string) => Promise<DocText[]>) {
    this.#scan = scan;
  }

  /** 重新讀取資料夾（`root` 為 null 時清空）；同時呼叫多次只會讀一次。 */
  refresh(root: string | null): Promise<void> {
    if (root !== this.#root) {
      this.#root = root;
      this.#files.clear();
      this.#pending = null;
    }
    if (!root) return Promise.resolve();
    this.#pending ??= (async () => {
      try {
        const known = Object.fromEntries([...this.#files].map(([p, e]) => [p, e.mtime]));
        const docs = await this.#scan(known, root);
        if (this.#root !== root) return;
        const next = new Map<string, Entry>();
        for (const d of docs) {
          const old = this.#files.get(d.path);
          if (d.text != null) next.set(d.path, { rel: d.rel, mtime: d.mtime, text: d.text });
          else if (old) next.set(d.path, { ...old, rel: d.rel });
        }
        this.#files = next;
      } finally {
        this.#pending = null;
      }
    })();
    return this.#pending;
  }

  /** 檔案已經寫入新的內容（例如在待辦總覽勾選）：下次重新整理前先用這份內容。 */
  remember(path: string, text: string): void {
    const e = this.#files.get(path);
    if (e) this.#files.set(path, { rel: e.rel, mtime: -1, text });
  }

  /** 所有文件：資料夾中的檔案，加上已開啟的分頁（以分頁內容為準）。 */
  docs(open: readonly OpenDoc[]): IndexedDoc[] {
    const out: IndexedDoc[] = [];
    const byPath = new Map(open.filter((o) => o.path).map((o) => [o.path!, o]));
    for (const [path, e] of this.#files) {
      const tab = byPath.get(path);
      if (tab) continue;
      e.info ??= parseDoc(e.text);
      out.push({ path, rel: e.rel, text: e.text, info: e.info });
    }
    const keep = new Set<string>();
    for (const o of open) {
      const key = o.path ?? `tab:${o.id}`;
      keep.add(key);
      let cached = this.#open.get(key);
      if (!cached || cached.text !== o.text) {
        cached = { text: o.text, info: parseDoc(o.text) };
        this.#open.set(key, cached);
      }
      const rel = (o.path && this.#files.get(o.path)?.rel) || o.name;
      out.push({ path: o.path, rel, text: o.text, info: cached.info, tabId: o.id });
    }
    for (const key of this.#open.keys()) if (!keep.has(key)) this.#open.delete(key);
    return out.sort((a, b) => a.rel.localeCompare(b.rel, "zh-Hant", { numeric: true }));
  }
}
