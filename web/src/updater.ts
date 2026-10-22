/**
 * 自動更新（桌面版免安裝 exe）：每天檢查一次 GitHub 上的最新版，有新版時詢問使用者，
 * 下載並核對簽章與檢查碼後取代執行檔，重新啟動即完成更新。
 * 更新視窗會列出這一版改了什麼；重新啟動後第一次開啟時，再說明一次已經更新了哪些內容。
 */
import changelog from "../../CHANGELOG.md?raw";
import type { AppVersion, Desktop, UpdateManifest } from "./desktop.ts";
import { notesForVersion } from "./release-notes.ts";
import type { SettingsStore } from "./settings.ts";
import * as storage from "./storage.ts";
import { showRelease } from "./ui/release-dialog.ts";
import { toast } from "./ui/toast.ts";

const CHECK_INTERVAL = 20 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY = 8000;

/** 給人看的版本號（例如「1.2.0」）。 */
export function versionLabel(v: AppVersion): string {
  return v.version;
}

/** 版本號下面的說明：發佈日期；自己編譯的版本註明不會自動更新。 */
export function versionDetail(v: AppVersion): string {
  if (!v.build) return "自行編譯的版本（不會自動更新）";
  return v.date ? `${v.date} 發佈` : "正式版";
}

/** 滑鼠停在版本號上時的技術資訊（回報問題時用得到）。 */
export function versionTooltip(v: AppVersion): string {
  return v.build ? `第 ${v.build} 次建置${v.commit ? `・${v.commit}` : ""}` : "自行編譯";
}

export type UpdateState =
  | { kind: "idle" }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string };

export class Updater {
  #d: Desktop;
  #settings: SettingsStore;
  #status: HTMLElement;
  /** 重新啟動前要做的事（例如保存草稿）。 */
  #beforeRestart: () => void;
  #state: UpdateState = { kind: "idle" };
  #listeners = new Set<(s: UpdateState) => void>();

  constructor(d: Desktop, settings: SettingsStore, status: HTMLElement, beforeRestart: () => void) {
    this.#d = d;
    this.#settings = settings;
    this.#status = status;
    this.#beforeRestart = beforeRestart;
    void d.onUpdateProgress(({ downloaded, total }) => {
      if (this.#state.kind !== "downloading") return;
      this.#setState({ ...this.#state, percent: Math.floor((downloaded / total) * 100) });
    });
    this.#welcome().catch((e) => console.warn("無法顯示更新說明", e));
    setTimeout(() => void this.#autoCheck(), FIRST_CHECK_DELAY);
    // 長時間開著的話，每隔一段時間再檢查。
    setInterval(() => void this.#autoCheck(), 60 * 60 * 1000);
  }

  version(): Promise<AppVersion> {
    return this.#d.appVersion();
  }

  get state(): UpdateState {
    return this.#state;
  }

  /** 狀態改變時通知（設定頁的版本列用）。回傳取消訂閱的函式。 */
  subscribe(fn: (s: UpdateState) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #setState(s: UpdateState): void {
    this.#state = s;
    this.#status.hidden = s.kind === "idle";
    if (s.kind === "downloading") this.#status.textContent = `正在下載 ${s.version}　${s.percent}%`;
    else if (s.kind === "ready") this.#status.textContent = `${s.version} 已下載，重新啟動即可更新`;
    for (const fn of this.#listeners) fn(s);
  }

  /**
   * 更新後第一次開啟：說明這一版改了什麼（內容取自打包進程式的 CHANGELOG.md）。
   * 第一次使用、自行編譯的版本只記下版本，不顯示。
   */
  async #welcome(): Promise<void> {
    const current = await this.#d.appVersion();
    if (!current) return;
    // 1.2.0 以前沒有記版本；檢查過更新代表是從舊版更新上來的，不是第一次使用。
    const seen = storage.load("seen-version") ?? (storage.load("update-checked") ? "舊版" : null);
    storage.save("seen-version", current.version);
    if (!seen || seen === current.version || !current.build) return;
    const changes = notesForVersion(changelog, current.version);
    if (!changes) return;
    await showRelease({
      title: `已更新到 ${current.version}`,
      subtitle: "這一版改了這些：",
      changes,
      buttons: [{ id: "ok", label: "知道了", primary: true }],
    });
  }

  async #autoCheck(): Promise<void> {
    if (!this.#settings.value.autoUpdate || this.#state.kind !== "idle") return;
    const last = Number(storage.load("update-checked")) || 0;
    if (Date.now() - last < CHECK_INTERVAL) return;
    try {
      const { latest } = await this.#d.updateCheck();
      storage.save("update-checked", String(Date.now()));
      if (!latest || String(latest.build) === storage.load("update-skipped")) return;
      // 自動檢查不直接跳出視窗打斷工作，先用通知提醒。
      toast(`有新版本 ${latest.version}${latest.notes ? `：${latest.notes}` : ""}`, {
        duration: 30000,
        action: { label: "看看新功能", primary: true, run: () => void this.#offer(latest) },
      });
    } catch (e) {
      // 沒有網路時不打擾使用者，下次再試。
      console.warn("檢查更新失敗", e);
    }
  }

  /** 手動檢查（指令面板、設定）。 */
  async check(): Promise<void> {
    if (this.#state.kind === "ready") {
      this.#offerRestart();
      return;
    }
    if (this.#state.kind === "downloading") {
      toast(`正在下載 ${this.#state.version}（${this.#state.percent}%）…`);
      return;
    }
    try {
      const { current, latest } = await this.#d.updateCheck();
      storage.save("update-checked", String(Date.now()));
      if (!current.updatable) {
        toast("這個版本是自行編譯的，不支援自動更新。", { duration: 6000 });
      } else if (latest) {
        storage.remove("update-skipped");
        await this.#offer(latest);
      } else {
        toast(`已經是最新版本（${versionLabel(current)}）。`, { tone: "success" });
      }
    } catch (e) {
      toast(`無法檢查更新：${e instanceof Error ? e.message : e}`, { tone: "error", duration: 8000 });
    }
  }

  /** 列出新版改了什麼，詢問要不要更新。 */
  async #offer(m: UpdateManifest): Promise<void> {
    const size = `${(m.size / 1024 / 1024).toFixed(1)} MB`;
    const choice = await showRelease({
      title: `有新版本 ${m.version}`,
      subtitle: [m.date && `${m.date} 發佈`, `下載 ${size}`, "更新時未存檔的內容會保留"].filter(Boolean).join("・"),
      changes: m.changes,
      summary: m.notes,
      buttons: [
        { id: "skip", label: "略過這一版" },
        { id: "later", label: "稍後" },
        { id: "install", label: "下載並更新", primary: true },
      ],
    });
    if (choice === "install") await this.#install(m);
    // 略過的版本，自動檢查時不再提醒（手動檢查仍然會顯示）。
    else if (choice === "skip") storage.save("update-skipped", String(m.build));
  }

  async #install(m: UpdateManifest): Promise<void> {
    if (this.#state.kind !== "idle") return;
    this.#setState({ kind: "downloading", version: m.version, percent: 0 });
    try {
      await this.#d.updateInstall();
      this.#setState({ kind: "ready", version: m.version });
      this.#offerRestart();
    } catch (e) {
      this.#setState({ kind: "idle" });
      toast(`更新失敗：${e instanceof Error ? e.message : e}`, { tone: "error", duration: 12000 });
    }
  }

  #offerRestart(): void {
    if (this.#state.kind !== "ready") return;
    toast(`${this.#state.version} 已下載完成，重新啟動就會使用新版（未存檔的內容會保留）。`, {
      duration: 60000,
      action: { label: "立即重新啟動", primary: true, run: () => this.restart() },
    });
  }

  /** 重新啟動並套用已下載的新版。 */
  restart(): void {
    if (this.#state.kind !== "ready") return;
    this.#beforeRestart();
    void this.#d.updateRestart();
  }
}
