/**
 * Azure DevOps 連不連得上：連線檢查（`ado_ping`，幾秒內就有結果）判斷是離線時，
 * 其他 Azure DevOps 指令直接失敗，不再一個一個等連線逾時（15～60 秒）；畫面改用離線副本。
 * 離線狀態放太久時，下一個指令先重新檢查一次。不碰畫面，方便測試。
 */

/** 不受離線影響的指令：連線檢查、帳號設定、本機的離線副本。 */
const ALWAYS = new Set(["ado_ping", "ado_account", "ado_connect", "ado_disconnect", "ado_check"]);

/** 判斷為離線之後，這麼久沒再檢查就先重新檢查（毫秒）。 */
const RECHECK_AFTER = 15_000;

export class OfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineError";
  }
}

export class AdoOnline {
  #offline = false;
  #at = 0;
  #listeners = new Set<(offline: boolean) => void>();
  #recheck: (() => Promise<boolean>) | null = null;
  #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  get offline(): boolean {
    return this.#offline;
  }

  /** 連線檢查的結果（`true` 是連不上）。狀態改變時通知。 */
  set(offline: boolean): void {
    this.#at = this.#now();
    if (offline === this.#offline) return;
    this.#offline = offline;
    for (const fn of this.#listeners) fn(offline);
  }

  /** 狀態改變時呼叫（例如恢復連線時重新讀取畫面上的副本）。 */
  listen(fn: (offline: boolean) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** 重新檢查連線的方法（回傳是否離線）。 */
  setRecheck(fn: () => Promise<boolean>): void {
    this.#recheck = fn;
  }

  /**
   * 呼叫 Azure DevOps 指令之前：離線時直接丟出 `OfflineError`（`message` 是給使用者看的說明）；
   * 判斷為離線已經有一陣子了，先重新檢查一次。其他指令不受影響。
   */
  async check(cmd: string, message: string): Promise<void> {
    if (!cmd.startsWith("ado_") || ALWAYS.has(cmd) || !this.#offline) return;
    if (this.#recheck && this.#now() - this.#at > RECHECK_AFTER) {
      const offline = await this.#recheck().catch(() => true);
      this.set(offline);
      if (!offline) return;
    }
    throw new OfflineError(message);
  }
}

/** 整個程式共用的一份。 */
export const adoOnline = new AdoOnline();
