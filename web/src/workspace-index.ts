/**
 * 資料夾文件索引：記住資料夾中每份 Markdown 文件的解析結果（待辦、標籤、連結），只重讀有改過的檔案。
 * 資料夾中的文件由桌面版後端解析，只傳結果過來；需要內容時（勾選待辦、更新連結）再用 `text()` 讀。
 * 已開啟的分頁以編輯器中的內容為準（包含還沒存檔的變更）。
 */
import type { DocText } from "./desktop.ts";
import type { DocInfo } from "./doc-index.ts";
import { collator } from "./collator.ts";
import { t } from "./i18n.ts";

export interface IndexedDoc {
  /** 檔案路徑；還沒存成檔案的分頁是 null。 */
  path: string | null;
  /** 顯示用的名稱（資料夾中的相對路徑，或分頁名稱）。 */
  rel: string;
  /** 已開啟的分頁才有內容；資料夾中的檔案要用 `WorkspaceIndex.text()` 讀。 */
  text: string | null;
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
  info: DocInfo;
}

type Scan = (known: Record<string, number>, root: string) => Promise<DocText[]>;
type Read = (paths: string[]) => Promise<(string | null)[]>;
/** 解析一份文件（WebAssembly 版的 `parseDoc`，和後端同一份程式）。 */
type Parse = (text: string) => DocInfo;

export class WorkspaceIndex {
  #root: string | null = null;
  #files = new Map<string, Entry>();
  /** 已開啟分頁的解析結果（內容沒變就沿用）。 */
  #open = new Map<string, { text: string; info: DocInfo }>();
  #pending: Promise<void> | null = null;
  #scan: Scan;
  #read: Read;
  #parse: Parse;

  constructor(scan: Scan, read: Read, parse: Parse) {
    this.#scan = scan;
    this.#read = read;
    this.#parse = parse;
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
          if (d.info) next.set(d.path, { rel: d.rel, mtime: d.mtime, info: d.info });
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
    if (e) this.#files.set(path, { rel: e.rel, mtime: -1, info: this.#parse(text) });
  }

  /** 文件的內容：已開啟的分頁直接用，資料夾中的檔案從磁碟讀。 */
  async text(doc: IndexedDoc): Promise<string> {
    return (await this.texts([doc]))[0];
  }

  /** 一次讀好幾份（只呼叫後端一次）；讀不到時丟出錯誤。 */
  async texts(docs: readonly IndexedDoc[]): Promise<string[]> {
    const paths = docs.flatMap((d) => (d.text === null && d.path ? [d.path] : []));
    const read = paths.length ? await this.#read(paths) : [];
    let i = 0;
    return docs.map((d) => {
      if (d.text !== null) return d.text;
      const text = d.path ? read[i++] : null;
      if (text == null) throw new Error(t("無法讀取「{name}」", { name: d.rel }));
      return text;
    });
  }

  /** 所有文件：資料夾中的檔案，加上已開啟的分頁（以分頁內容為準）。 */
  docs(open: readonly OpenDoc[]): IndexedDoc[] {
    const out: IndexedDoc[] = [];
    const byPath = new Map(open.filter((o) => o.path).map((o) => [o.path!, o]));
    for (const [path, e] of this.#files) {
      const tab = byPath.get(path);
      if (tab) continue;
      out.push({ path, rel: e.rel, text: null, info: e.info });
    }
    const keep = new Set<string>();
    for (const o of open) {
      const key = o.path ?? `tab:${o.id}`;
      keep.add(key);
      let cached = this.#open.get(key);
      if (!cached || cached.text !== o.text) {
        cached = { text: o.text, info: this.#parse(o.text) };
        this.#open.set(key, cached);
      }
      const rel = (o.path && this.#files.get(o.path)?.rel) || o.name;
      out.push({ path: o.path, rel, text: o.text, info: cached.info, tabId: o.id });
    }
    for (const key of this.#open.keys()) if (!keep.has(key)) this.#open.delete(key);
    return out.sort((a, b) => collator.compare(a.rel, b.rel));
  }
}
