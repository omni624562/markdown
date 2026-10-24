/**
 * Azure DevOps（公司自架的 Azure DevOps Server／TFS 或雲端版，桌面版）：
 * 用個人存取權杖連線、從 ADO 開啟儲存庫或專案 Wiki。工作項目在側邊欄（ui/workitems-panel.ts）。
 */
import type { AdoAccount, AdoRepo, Desktop, Folder } from "./desktop.ts";
import { isInsecureUrl } from "./ado-text.ts";
import { t } from "./i18n.ts";
import { choose } from "./ui/choice.ts";
import { Picker } from "./ui/picker.ts";
import { toast } from "./ui/toast.ts";

export interface AdoHooks {
  /** 下載完成後開啟資料夾。 */
  openFolder(folder: Folder): Promise<void>;
  /** 連線狀態改變（更新設定頁、工作項目面板）。 */
  changed(): void;
  /** 還沒連線時，打開設定的 Azure DevOps／TFS 頁讓使用者輸入網址與權杖。 */
  openSettings(): void;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class Ado {
  #d: Desktop;
  #hooks: AdoHooks;
  #account: AdoAccount | null = null;
  #loaded: Promise<void>;

  constructor(d: Desktop, hooks: AdoHooks) {
    this.#d = d;
    this.#hooks = hooks;
    this.#loaded = d
      .adoAccount()
      .then((a) => void (this.#account = a))
      .catch(() => {});
  }

  get account(): AdoAccount | null {
    return this.#account;
  }

  ready(): Promise<void> {
    return this.#loaded;
  }

  /** 用網址與個人存取權杖連線。成功回傳 true。 */
  async connect(url: string, pat: string): Promise<boolean> {
    if (!url.trim()) {
      toast(t("請輸入 Azure DevOps 的網址"), { tone: "error" });
      return false;
    }
    if (isInsecureUrl(url)) {
      const ok = await choose(
        t("連線沒有加密"),
        t("這個網址是 http://，個人存取權杖會用沒有加密的連線傳送，同一個網路上的人可能看得到。建議改用 https:// 的網址。"),
        [
          { id: "cancel", label: t("取消"), primary: true },
          { id: "go", label: t("仍要連線"), danger: true },
        ],
      );
      if (ok !== "go") return false;
    }
    const wait = toast(t("正在連線到 Azure DevOps…"), { duration: 60000 });
    try {
      this.#account = await this.#d.adoConnect(url, pat);
      wait.dismiss();
      toast(t("已連線到 Azure DevOps：{name}", { name: this.#account.name }), { tone: "success" });
      this.#hooks.changed();
      return true;
    } catch (e) {
      wait.dismiss();
      toast(message(e), { tone: "error", duration: 12000 });
      return false;
    }
  }

  async disconnect(): Promise<void> {
    const ok = await choose(
      t("中斷 Azure DevOps 連線"),
      t("會從這台電腦刪除個人存取權杖。資料夾和檔案都會留在電腦上；之後要推送或拉取 Azure DevOps 的儲存庫，需要重新連線。"),
      [
        { id: "cancel", label: t("取消") },
        { id: "go", label: t("中斷連線"), danger: true },
      ],
    );
    if (ok !== "go") return;
    await this.#d.adoDisconnect();
    this.#account = null;
    toast(t("已中斷 Azure DevOps 連線"));
    this.#hooks.changed();
  }

  async #ensure(): Promise<boolean> {
    await this.#loaded;
    if (this.#account) return true;
    toast(t("請先在設定的 Azure DevOps／TFS 頁輸入伺服器網址與個人存取權杖"));
    this.#hooks.openSettings();
    return false;
  }

  /** 從清單選一個儲存庫或專案 Wiki，下載到電腦並開啟。 */
  async openRepo(): Promise<void> {
    if (!(await this.#ensure())) return;
    let repos: AdoRepo[];
    const wait = toast(t("正在讀取儲存庫清單…"), { duration: 60000 });
    try {
      repos = await this.#d.adoRepos();
    } catch (e) {
      toast(message(e), { tone: "error", duration: 12000 });
      return;
    } finally {
      wait.dismiss();
    }
    const picker = new Picker<AdoRepo>({
      label: t("從 Azure DevOps／TFS 下載或開啟儲存庫"),
      placeholder: repos.length ? t("搜尋 {n} 個儲存庫與 Wiki…", { n: repos.length }) : t("這個集合還沒有儲存庫"),
      empty: t("找不到符合的儲存庫"),
      query: (text) => {
        const q = text.trim().toLowerCase();
        return q ? repos.filter((r) => `${r.project} ${r.name}`.toLowerCase().includes(q)) : repos;
      },
      render: (r) => ({
        title: `${r.project} / ${r.name}`,
        detail: r.wiki ? t("專案 Wiki") : t("Git 儲存庫"),
        icon: r.wiki ? "book-open-text" : "git-branch",
      }),
      pick: (r) => void this.#clone(r),
    });
    picker.open();
  }

  async #clone(repo: AdoRepo): Promise<void> {
    const wait = toast(t("正在下載「{name}」…", { name: repo.name }), { duration: 600000 });
    try {
      const folder = await this.#d.adoClone(repo.cloneUrl, repo.name);
      wait.dismiss();
      if (!folder) return;
      await this.#hooks.openFolder(folder);
      toast(
        folder.existing
          ? t("「{name}」之前已經下載過，已直接開啟", { name: folder.name })
          : t("已下載並開啟「{name}」，之後在「原始碼控制」就能同步", { name: folder.name }),
        { tone: "success", duration: 8000 },
      );
      this.#hooks.changed();
    } catch (e) {
      wait.dismiss();
      toast(message(e), { tone: "error", duration: 12000 });
    }
  }
}
