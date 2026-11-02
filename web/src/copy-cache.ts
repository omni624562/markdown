/**
 * 清單的本機副本：先顯示上次存下的結果，背景再向伺服器讀新的（讀到就換上去）。
 * 不碰畫面，方便測試；存取副本的方式由呼叫端提供（桌面版存在本機的離線資料夾）。
 */

export interface CopyStore {
  get(key: string): Promise<string | null>;
  put(key: string, raw: string): Promise<void>;
}

/** 拿到的是副本時，它是什麼時候存的、背景更新到哪了。 */
export interface Freshness {
  /** 副本存下的時間（毫秒）；舊格式的副本不知道時間，是 0。 */
  savedAt: number;
  /** `updating`：背景正在讀新的；`failed`：這次讀不到，顯示的是副本。 */
  state: "updating" | "failed";
  error?: string;
}

const tags = new WeakMap<object, Freshness>();

/** 這份資料是副本嗎？是的話回傳存下的時間與狀態；剛從伺服器讀到的是 `null`。 */
export function freshnessOf(value: unknown): Freshness | null {
  return value !== null && typeof value === "object" ? (tags.get(value) ?? null) : null;
}

/** 從副本算出來的新資料（篩選、轉換後的陣列）沿用副本的標記。 */
export function keepFreshness<T>(from: unknown, to: T): T {
  const f = freshnessOf(from);
  if (f) tag(to, f);
  return to;
}

function tag(value: unknown, f: Freshness): void {
  if (value !== null && typeof value === "object") tags.set(value, f);
}

export function encodeCopy(value: unknown, savedAt: number): string {
  return JSON.stringify({ $copy: 1, savedAt, value });
}

/** 讀出副本；舊格式（直接存值）也認得。壞掉的回傳 `null`。 */
export function decodeCopy(raw: string | null): { value: unknown; savedAt: number } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v) && (v as { $copy?: unknown }).$copy === 1) {
      const c = v as { savedAt?: unknown; value?: unknown };
      return { value: c.value, savedAt: typeof c.savedAt === "number" ? c.savedAt : 0 };
    }
    return { value: v, savedAt: 0 };
  } catch {
    return null;
  }
}

export interface CopyOptions {
  /**
   * 有副本時先回傳副本，背景再讀；讀完（成功或失敗）呼叫這個，`changed` 是內容和副本不一樣。
   * 呼叫端通常是重新整理畫面：這時再讀一次會直接拿到剛讀到的結果（或失敗後的副本），不會再連一次。
   */
  onUpdate?(changed: boolean): void;
  /** 這次讀不到、改用副本時呼叫（例如提示一次「離線中」）。 */
  onOffline?(error: unknown): void;
}

export class CopyCache {
  /** 這次執行剛讀到的結果（短時間內重讀直接用，不再連線）。 */
  #memo = new Map<string, { at: number; value: unknown }>();
  #inflight = new Map<string, Promise<unknown>>();

  #store: CopyStore;
  #now: () => number;
  /** 讀到的結果在這段時間內直接沿用（毫秒）。 */
  #reuse: number;

  constructor(store: CopyStore, now: () => number = Date.now, reuse = 30_000) {
    this.#store = store;
    this.#now = now;
    this.#reuse = reuse;
  }

  /** 忘掉剛讀到的結果：下次一定向伺服器讀（按「重新整理」、網路恢復時）。 */
  forget(prefix = ""): void {
    for (const key of [...this.#memo.keys()]) if (key.startsWith(prefix)) this.#memo.delete(key);
  }

  async get<T>(key: string, fetch: () => Promise<T>, opts: CopyOptions = {}): Promise<T> {
    const memo = this.#memo.get(key);
    if (memo && this.#now() - memo.at < this.#reuse) return memo.value as T;
    if (opts.onUpdate) {
      const copy = decodeCopy(await this.#store.get(key).catch(() => null));
      if (copy && copy.value !== null && typeof copy.value === "object") {
        const shown = copy.value as T;
        const before = JSON.stringify(copy.value);
        tag(shown, { savedAt: copy.savedAt, state: "updating" });
        this.#live(key, fetch).then(
          (value) => opts.onUpdate!(JSON.stringify(value) !== before),
          (e: unknown) => {
            tag(shown, { savedAt: copy.savedAt, state: "failed", error: message(e) });
            this.#memo.set(key, { at: this.#now(), value: shown });
            opts.onOffline?.(e);
            opts.onUpdate!(false);
          },
        );
        return shown;
      }
    }
    try {
      return await this.#live(key, fetch);
    } catch (e) {
      const copy = decodeCopy(await this.#store.get(key).catch(() => null));
      if (!copy) throw e;
      tag(copy.value, { savedAt: copy.savedAt, state: "failed", error: message(e) });
      opts.onOffline?.(e);
      return copy.value as T;
    }
  }

  /** 向伺服器讀（同一個 key 同時只讀一次），讀到就記下並存副本。 */
  #live<T>(key: string, fetch: () => Promise<T>): Promise<T> {
    const running = this.#inflight.get(key);
    if (running) return running as Promise<T>;
    const p = fetch()
      .then((value) => {
        const at = this.#now();
        this.#memo.set(key, { at, value });
        void this.#store.put(key, encodeCopy(value, at)).catch(() => {});
        return value;
      })
      .finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, p);
    return p;
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
