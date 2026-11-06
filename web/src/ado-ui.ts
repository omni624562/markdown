/**
 * Azure DevOps（公司自架的 Azure DevOps Server／TFS 或雲端版，桌面版）：
 * 用個人存取權杖連線、從 ADO 開啟儲存庫或專案 Wiki、把本機資料夾上傳成 ADO 的儲存庫。
 * 工作項目在側邊欄（ui/workitems-panel.ts）。
 */
import type { AdoAccount, AdoRepo, Desktop, Folder } from "./desktop.ts";
import { adoRepoNameFrom, isInsecureUrl } from "./ado-text.ts";
import { t } from "./i18n.ts";
import { askText, choose } from "./ui/choice.ts";
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

/** 從清單選一項；關掉清單沒選時是 null。 */
function pickOne<T>(options: Omit<ConstructorParameters<typeof Picker<T>>[0], "pick" | "closed">): Promise<T | null> {
  return new Promise((resolve) => {
    let picked: T | null = null;
    new Picker<T>({ ...options, pick: (item) => (picked = item), closed: () => resolve(picked) }).open();
  });
}

/** 新的儲存庫名稱：預設是資料夾名稱，不能用的符號換掉後再請使用者確認一次。 */
async function askAdoRepoName(initial: string): Promise<string | null> {
  for (let value = initial; ; ) {
    const name = await askText(
      t("上傳到 Azure DevOps"),
      t("新的儲存庫名稱（可以用中文和空白，不能有 \\ / : * ? \" < > | 等符號）："),
      value,
      t("下一步"),
    );
    if (name === null) return null;
    const clean = adoRepoNameFrom(name);
    if (clean === name.trim()) return clean;
    value = clean;
    toast(t("儲存庫名稱改成「{name}」，確認後按「下一步」", { name: clean }));
  }
}

export class Ado {
  #d: Desktop;
  #hooks: AdoHooks;
  #account: AdoAccount | null = null;
  #loaded: Promise<void>;
  #ready = false;

  constructor(d: Desktop, hooks: AdoHooks) {
    this.#d = d;
    this.#hooks = hooks;
    this.#loaded = d
      .adoAccount()
      .then((a) => void (this.#account = a))
      .catch(() => {})
      .finally(() => (this.#ready = true));
  }

  get account(): AdoAccount | null {
    return this.#account;
  }

  ready(): Promise<void> {
    return this.#loaded;
  }

  /** 帳號讀到了沒（讀到之前還不知道有沒有連線）。 */
  get loaded(): boolean {
    return this.#ready;
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
      const account = await this.#d.adoConnect(url, pat);
      wait.dismiss();
      // 換伺服器時在系統的確認對話框選了「否」：保留原本的連線。
      if (!account) return false;
      this.#account = account;
      toast(t("已連線到 Azure DevOps：{name}", { name: account.name }), { tone: "success" });
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
    toast(t("請先在設定的 Azure DevOps 頁輸入伺服器網址與個人存取權杖"));
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
      label: t("Azure DevOps：下載儲存庫"),
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

  /**
   * 把目前開啟的本機資料夾（名稱是 `folder`）上傳到 Azure DevOps：選專案，再選建立新的儲存庫，
   * 或上傳到那個專案裡已經存在的空儲存庫。成功時回傳 true（呼叫端更新原始碼控制面板）。
   */
  async publish(folder: string): Promise<boolean> {
    if (!folder) {
      toast(t("請先開啟要上傳的資料夾。"));
      return false;
    }
    if (!(await this.#ensure())) return false;
    const wait = toast(t("正在讀取 Azure DevOps 專案…"), { duration: 60000 });
    let projects: string[];
    let repos: Promise<AdoRepo[]>;
    try {
      // 儲存庫清單同時讀，選好專案時通常已經讀完。
      repos = this.#d.adoRepos().catch(() => [] as AdoRepo[]);
      projects = (await this.#d.adoWorkItemFilters()).projects;
    } catch (e) {
      toast(message(e), { tone: "error", duration: 12000 });
      return false;
    } finally {
      wait.dismiss();
    }
    if (!projects.length) {
      toast(t("看不到任何 Azure DevOps 專案，請確認個人存取權杖有讀取專案的權限"), { tone: "error", duration: 12000 });
      return false;
    }
    const project =
      projects.length === 1
        ? projects[0]
        : await pickOne<string>({
            label: t("上傳到 Azure DevOps"),
            placeholder: t("要放在哪個 Azure DevOps 專案？搜尋 {n} 個專案…", { n: projects.length }),
            empty: t("找不到符合的專案"),
            query: (text) => {
              const q = text.trim().toLowerCase();
              return q ? projects.filter((p) => p.toLowerCase().includes(q)) : projects;
            },
            render: (p) => ({ title: p, icon: "briefcase-business" }),
          });
    if (!project) return false;
    const empty = (await repos).filter((r) => r.project === project && !r.wiki && r.empty);
    const where = await choose(
      t("上傳到 Azure DevOps"),
      t("會把「{folder}」資料夾的檔案和版本紀錄放到 Azure DevOps 專案「{project}」。要建立新的儲存庫，還是用已經存在的空儲存庫？", {
        folder,
        project,
      }),
      [
        { id: "cancel", label: t("取消") },
        ...(empty.length ? [{ id: "existing", label: t("用已經存在的空儲存庫…") }] : []),
        { id: "new", label: t("建立新的儲存庫"), primary: true },
      ],
    );
    let name: string | null = null;
    if (where === "new") name = await askAdoRepoName(adoRepoNameFrom(folder));
    else if (where === "existing") {
      const repo = await pickOne<AdoRepo>({
        label: t("上傳到 Azure DevOps"),
        placeholder: t("選一個空的儲存庫（{project}）", { project }),
        empty: t("找不到符合的儲存庫"),
        query: (text) => {
          const q = text.trim().toLowerCase();
          return q ? empty.filter((r) => r.name.toLowerCase().includes(q)) : empty;
        },
        render: (r) => ({ title: r.name, detail: t("空的儲存庫"), icon: "git-branch" }),
      });
      name = repo?.name ?? null;
    }
    if (!name) return false;
    const uploading = toast(t("正在上傳到 Azure DevOps…"), { duration: 600000 });
    try {
      const url = await this.#d.adoPublish(project, name, where === "existing");
      uploading.dismiss();
      // 在系統的確認對話框選了「否」：什麼都沒做。
      if (!url) return false;
      toast(t("已上傳到 Azure DevOps：{project} / {name}", { project, name }), {
        tone: "success",
        duration: 12000,
        action: { label: t("在瀏覽器開啟"), run: () => void this.#d.openExternal(url) },
      });
      this.#hooks.changed();
      return true;
    } catch (e) {
      uploading.dismiss();
      toast(message(e), { tone: "error", duration: 12000 });
      return false;
    }
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
