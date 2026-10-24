/**
 * 用 GitHub 帳號同步（桌面版）：裝置碼登入、從 GitHub 開啟儲存庫、把資料夾上傳成新的儲存庫。
 * Git 本身內建在程式裡，使用者不需要安裝 Git 或輸入任何指令。
 */
import type { Desktop, Folder, GitHubAccount, GitHubRepo } from "./desktop.ts";
import { ago, repoNameFrom } from "./github-text.ts";
import { t } from "./i18n.ts";
import { askText, choose } from "./ui/choice.ts";
import { Picker } from "./ui/picker.ts";
import { toast } from "./ui/toast.ts";

export interface GitHubHooks {
  /** 目前開啟的資料夾。 */
  root(): Folder | null;
  /** 下載完成後開啟資料夾。 */
  openFolder(folder: Folder): Promise<void>;
  /** 登入狀態或儲存庫改變（更新設定頁與原始碼控制面板）。 */
  changed(): void;
}

export class GitHub {
  #d: Desktop;
  #hooks: GitHubHooks;
  #account: GitHubAccount | null = null;
  #loaded: Promise<void>;

  constructor(d: Desktop, hooks: GitHubHooks) {
    this.#d = d;
    this.#hooks = hooks;
    this.#loaded = d
      .githubAccount()
      .then((a) => void (this.#account = a))
      .catch(() => {});
  }

  get account(): GitHubAccount | null {
    return this.#account;
  }

  ready(): Promise<void> {
    return this.#loaded;
  }

  /** 裝置碼登入：顯示代碼，等使用者在瀏覽器授權。成功回傳帳號，取消或失敗回傳 null。 */
  async login(): Promise<GitHubAccount | null> {
    let code;
    try {
      code = await this.#d.githubLoginStart();
    } catch (e) {
      toast(t("無法登入 GitHub：{error}", { error: e instanceof Error ? e.message : String(e) }), { tone: "error", duration: 10000 });
      return null;
    }
    const dialog = codeDialog(code.userCode, code.verificationUri, (url) => void this.#d.openExternal(url));
    dialog.cancelled.then(() => void this.#d.githubLoginCancel());
    try {
      const account = await this.#d.githubLoginWait(code);
      this.#account = account;
      dialog.close();
      toast(t("已登入 GitHub：{login}", { login: account.login }), { tone: "success" });
      this.#hooks.changed();
      return account;
    } catch (e) {
      dialog.close();
      const message = e instanceof Error ? e.message : String(e);
      if (message !== t("已取消登入")) toast(message, { tone: "error", duration: 10000 });
      return null;
    }
  }

  async logout(): Promise<void> {
    const ok = await choose(t("登出 GitHub"), t("登出後就不能推送或拉取 GitHub 上的儲存庫，資料夾和檔案都會留在電腦上。"), [
      { id: "cancel", label: t("取消") },
      { id: "logout", label: t("登出"), danger: true },
    ]);
    if (ok !== "logout") return;
    await this.#d.githubLogout();
    this.#account = null;
    toast(t("已登出 GitHub"));
    this.#hooks.changed();
  }

  async #ensureLogin(): Promise<boolean> {
    await this.#loaded;
    return !!this.#account || !!(await this.login());
  }

  /** 從清單選一個儲存庫，下載到電腦並開啟。 */
  async openRepo(): Promise<void> {
    if (!(await this.#ensureLogin())) return;
    let repos: GitHubRepo[];
    try {
      repos = await this.#d.githubRepos();
    } catch (e) {
      toast(`${e instanceof Error ? e.message : e}`, { tone: "error", duration: 10000 });
      return;
    }
    const picker = new Picker<GitHubRepo>({
      label: t("從 GitHub 下載或開啟儲存庫"),
      placeholder: repos.length ? t("搜尋 {n} 個儲存庫…", { n: repos.length }) : t("你的 GitHub 帳號還沒有儲存庫"),
      empty: t("找不到符合的儲存庫"),
      query: (text) => {
        const q = text.trim().toLowerCase();
        return q ? repos.filter((r) => `${r.fullName} ${r.description ?? ""}`.toLowerCase().includes(q)) : repos;
      },
      render: (r) => ({
        title: r.fullName,
        detail: [r.private ? t("私人") : t("公開"), ago(r.updatedAt), r.description].filter(Boolean).join("・"),
        icon: r.private ? "shield-check" : "git-branch",
      }),
      pick: (r) => void this.#clone(r),
    });
    picker.open();
  }

  async #clone(repo: GitHubRepo): Promise<void> {
    const wait = toast(t("正在下載「{name}」…", { name: repo.fullName }), { duration: 600000 });
    try {
      const folder = await this.#d.githubClone(repo.fullName);
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
      toast(`${e instanceof Error ? e.message : e}`, { tone: "error", duration: 12000 });
    }
  }

  /** 把目前開啟的資料夾上傳成新的 GitHub 儲存庫。 */
  async publish(): Promise<void> {
    const root = this.#hooks.root();
    if (!root) {
      toast(t("請先開啟要上傳的資料夾。"));
      return;
    }
    if (!(await this.#ensureLogin())) return;
    const name = await askRepoName(repoNameFrom(root.name));
    if (!name) return;
    const visibility = await choose(
      t("誰可以看到這個儲存庫？"),
      t("會在你的 GitHub 帳號（{login}）建立「{name}」，並上傳「{folder}」資料夾的內容。", {
        login: this.#account?.login ?? "",
        name,
        folder: root.name,
      }),
      [
        { id: "cancel", label: t("取消") },
        { id: "public", label: t("公開（所有人都看得到）") },
        { id: "private", label: t("私人（只有你看得到）"), primary: true },
      ],
    );
    if (visibility !== "public" && visibility !== "private") return;
    const wait = toast(t("正在上傳到 GitHub…"), { duration: 600000 });
    try {
      const url = await this.#d.githubPublish(name, visibility === "private");
      wait.dismiss();
      toast(t("已上傳到 GitHub：{url}", { url: url.replace(/^https:\/\//, "") }), {
        tone: "success",
        duration: 12000,
        action: { label: t("在瀏覽器開啟"), run: () => void this.#d.openExternal(url) },
      });
      this.#hooks.changed();
    } catch (e) {
      wait.dismiss();
      toast(`${e instanceof Error ? e.message : e}`, { tone: "error", duration: 12000 });
    }
  }
}

/** 顯示登入代碼；按「複製代碼」「開啟 GitHub」不會關閉，按「取消」或 Esc 才關。 */
function codeDialog(code: string, url: string, open: (url: string) => void): { close(): void; cancelled: Promise<void> } {
  const dialog = document.createElement("dialog");
  dialog.className = "choice github-login";
  dialog.setAttribute("aria-labelledby", "github-login-title");
  const h = document.createElement("h2");
  h.id = "github-login-title";
  h.textContent = t("用 GitHub 登入");
  const p = document.createElement("p");
  p.textContent = t("已經在瀏覽器開啟 GitHub。請在網頁輸入下面的代碼，再按「Authorize」授權；完成後這個視窗會自動關閉。");
  const codeEl = document.createElement("div");
  codeEl.className = "github-code";
  codeEl.textContent = code;
  const status = document.createElement("p");
  status.className = "github-wait";
  status.textContent = t("等待你在瀏覽器授權…");
  const actions = document.createElement("div");
  actions.className = "choice-actions";
  const button = (label: string, run: () => void, primary = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `btn${primary ? " btn-primary" : ""}`;
    b.textContent = label;
    b.addEventListener("click", run);
    return b;
  };
  let byCode = false;
  let resolveCancel!: () => void;
  const cancelled = new Promise<void>((r) => (resolveCancel = r));
  const copy = button(t("複製代碼"), () => {
    void navigator.clipboard.writeText(code).then(() => (copy.textContent = t("已複製")));
  });
  actions.append(
    button(t("取消"), () => dialog.close()),
    button(t("開啟 GitHub"), () => open(url)),
    copy,
  );
  copy.classList.add("btn-primary");
  dialog.append(h, p, codeEl, status, actions);
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (!byCode) resolveCancel();
  });
  document.body.append(dialog);
  dialog.showModal();
  copy.focus();
  return {
    close() {
      byCode = true;
      if (dialog.open) dialog.close();
    },
    cancelled,
  };
}

async function askRepoName(initial: string): Promise<string | null> {
  for (let value = initial; ; ) {
    const name = await askText(
      t("上傳到 GitHub"),
      t("新的儲存庫名稱（只能用英文字母、數字、「-」「_」「.」）："),
      value,
      t("下一步"),
    );
    if (name === null) return null;
    const clean = repoNameFrom(name);
    if (clean === name) return name;
    value = clean;
    toast(t("儲存庫名稱改成「{name}」，確認後按「下一步」", { name: clean }));
  }
}
