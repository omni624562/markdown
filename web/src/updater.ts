/**
 * 自動更新（桌面版免安裝 exe）：每天檢查一次 GitHub 上的最新版，有新版時詢問使用者，
 * 下載並核對檢查碼後取代執行檔，重新啟動即完成更新。
 */
import type { AppVersion, Desktop, UpdateManifest } from "./desktop.ts";
import type { SettingsStore } from "./settings.ts";
import * as storage from "./storage.ts";
import { toast } from "./ui/toast.ts";

const CHECK_INTERVAL = 20 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY = 8000;

export function versionLabel(v: AppVersion): string {
  return v.build ? `${v.version}（第 ${v.build} 版${v.commit ? `，${v.commit}` : ""}）` : `${v.version}（自行編譯）`;
}

export class Updater {
  #d: Desktop;
  #settings: SettingsStore;
  #status: HTMLElement;
  /** 重新啟動前要做的事（例如保存草稿）。 */
  #beforeRestart: () => void;
  #busy = false;
  #ready = false;

  constructor(d: Desktop, settings: SettingsStore, status: HTMLElement, beforeRestart: () => void) {
    this.#d = d;
    this.#settings = settings;
    this.#status = status;
    this.#beforeRestart = beforeRestart;
    void d.onUpdateProgress(({ downloaded, total }) => {
      this.#status.hidden = false;
      this.#status.textContent = `正在下載更新 ${Math.floor((downloaded / total) * 100)}%`;
    });
    setTimeout(() => void this.#autoCheck(), FIRST_CHECK_DELAY);
    // 長時間開著的話，每隔一段時間再檢查。
    setInterval(() => void this.#autoCheck(), 60 * 60 * 1000);
  }

  version(): Promise<AppVersion> {
    return this.#d.appVersion();
  }

  async #autoCheck(): Promise<void> {
    if (!this.#settings.value.autoUpdate || this.#busy || this.#ready) return;
    const last = Number(storage.load("update-checked")) || 0;
    if (Date.now() - last < CHECK_INTERVAL) return;
    try {
      const { latest } = await this.#d.updateCheck();
      storage.save("update-checked", String(Date.now()));
      if (latest && String(latest.build) !== storage.load("update-skipped")) this.#offer(latest);
    } catch (e) {
      // 沒有網路時不打擾使用者，下次再試。
      console.warn("檢查更新失敗", e);
    }
  }

  /** 手動檢查（指令面板、設定）。 */
  async check(): Promise<void> {
    if (this.#ready) {
      this.#offerRestart();
      return;
    }
    try {
      const { current, latest } = await this.#d.updateCheck();
      storage.save("update-checked", String(Date.now()));
      if (!current.updatable) {
        toast("這個版本是自行編譯的，不支援自動更新。", { duration: 6000 });
      } else if (latest) {
        storage.remove("update-skipped");
        this.#offer(latest);
      } else {
        toast(`已經是最新版本（${versionLabel(current)}）。`, { tone: "success" });
      }
    } catch (e) {
      toast(`無法檢查更新：${e instanceof Error ? e.message : e}`, { tone: "error", duration: 8000 });
    }
  }

  #offer(m: UpdateManifest): void {
    const size = `${(m.size / 1024 / 1024).toFixed(1)} MB`;
    toast(`有新版本 ${m.version}（第 ${m.build} 版，${size}）${m.notes ? `：${m.notes}` : ""}`, {
      duration: 30000,
      action: { label: "下載並更新", run: () => void this.#install() },
    });
    // 使用者沒按的話，這個版本今天不再提示。
    storage.save("update-skipped", String(m.build));
  }

  async #install(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    this.#status.hidden = false;
    this.#status.textContent = "正在下載更新…";
    try {
      await this.#d.updateInstall();
      this.#ready = true;
      this.#status.textContent = "更新已就緒，重新啟動後生效";
      this.#offerRestart();
    } catch (e) {
      this.#status.hidden = true;
      toast(`更新失敗：${e instanceof Error ? e.message : e}`, { tone: "error", duration: 12000 });
    } finally {
      this.#busy = false;
    }
  }

  #offerRestart(): void {
    toast("新版已下載完成。重新啟動後就會使用新版（未存檔的內容會保留）。", {
      duration: 60000,
      action: {
        label: "立即重新啟動",
        run: () => {
          this.#beforeRestart();
          void this.#d.updateRestart();
        },
      },
    });
  }
}
