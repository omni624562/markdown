/**
 * Git 整合（桌面版）：側邊欄的「原始碼控制」面板、檔案樹的變更標記、自動同步。
 * Git 內建在程式裡（不需要安裝）；資料夾還不是 Git 儲存庫時，面板改成引導：
 * 用 GitHub 登入、從 GitHub 開啟儲存庫、把資料夾上傳到 GitHub。
 */
import type { Desktop, GitChange, GitStatus } from "./desktop.ts";
import type { GitHub } from "./github-ui.ts";
import type { SettingsStore } from "./settings.ts";
import type { FileTree } from "./ui/filetree.ts";
import { icon } from "./ui/icons.ts";
import { toast } from "./ui/toast.ts";

const MARK: Record<GitChange["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
};

const LABEL: Record<GitChange["status"], string> = {
  modified: "修改",
  added: "新增",
  deleted: "刪除",
  renamed: "改名",
  untracked: "新檔案",
  conflicted: "衝突",
};

/** 預設的提交說明。 */
export function defaultMessage(changes: GitChange[], name: (path: string) => string): string {
  if (changes.length === 1) return `${LABEL[changes[0].status]} ${name(changes[0].path)}`;
  return `更新 ${changes.length} 個檔案`;
}

export function syncMessage(date = new Date()): string {
  const f = new Intl.DateTimeFormat("zh-TW", { dateStyle: "short", timeStyle: "short", hour12: false });
  return `自動同步 ${f.format(date)}`;
}

const baseName = (p: string) => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);

export interface GitPanelHooks {
  /** 目前的工作區根目錄。 */
  root(): string | null;
  /** 點變更清單中的檔案。 */
  open(path: string): void;
  /** 儲存庫狀態改變（更新活動列圖示的變更數）。沒有開啟資料夾時是 null。 */
  changed(status: GitStatus | null): void;
}

export class GitPanel {
  #d: Desktop;
  #settings: SettingsStore;
  #tree: FileTree;
  #host: HTMLElement;
  #hooks: GitPanelHooks;
  #github: GitHub;
  #status: GitStatus | null = null;
  #busy = false;
  #refreshTimer = 0;
  #syncTimer = 0;
  /** 自動同步出錯後，這次開啟期間先暫停。 */
  #syncPaused = false;
  #message: HTMLTextAreaElement;

  constructor(host: HTMLElement, d: Desktop, settings: SettingsStore, tree: FileTree, github: GitHub, hooks: GitPanelHooks) {
    this.#host = host;
    this.#github = github;
    this.#d = d;
    this.#settings = settings;
    this.#tree = tree;
    this.#hooks = hooks;
    this.#message = document.createElement("textarea");
    this.#message.className = "git-message";
    this.#message.rows = 3;
    this.#message.setAttribute("aria-label", "提交說明");
    this.#message.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault();
        void this.commit(false);
      }
    });
    settings.subscribe((_, changed) => {
      if (changed.includes("gitAutoSync") || changed.includes("gitSyncMinutes")) {
        this.#syncPaused = false;
        this.#scheduleSync();
      }
    });
    window.addEventListener("focus", () => this.refreshSoon());
    setInterval(() => this.refreshSoon(), 60_000);
  }

  get status(): GitStatus | null {
    return this.#status;
  }

  /** 檔案有變動時呼叫；稍候再重新讀取狀態。 */
  refreshSoon(delay = 1200): void {
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = window.setTimeout(() => void this.refresh(), delay);
  }

  async refresh(): Promise<void> {
    if (!this.#hooks.root()) {
      this.#status = null;
    } else {
      try {
        this.#status = await this.#d.gitStatus();
      } catch {
        this.#status = null;
      }
    }
    const marks = new Map<string, string>();
    for (const c of this.#status?.changes ?? []) marks.set(c.path, MARK[c.status]);
    this.#tree.setStatus(marks);
    this.#render();
    this.#hooks.changed(this.#status);
    this.#scheduleSync();
  }

  /** 把焦點放到提交說明（指令「Git：提交變更」）。 */
  focusMessage(): void {
    this.#message.focus();
  }

  #render(): void {
    const s = this.#status;
    if (!s?.repo) {
      this.#renderSetup();
      return;
    }
    const b = s.branch;
    const changes = s.changes;

    // 分支與同步按鈕
    const branch = document.createElement("div");
    branch.className = "git-branch";
    const info = document.createElement("span");
    info.className = "git-info";
    info.title = b?.upstream ? `追蹤 ${b.upstream}` : "這個分支還沒有設定遠端";
    info.append(icon("git-branch"), Object.assign(document.createElement("strong"), { textContent: b?.name ?? "（未知分支）" }));
    if (b?.ahead) info.append(Object.assign(document.createElement("small"), { textContent: `↑${b.ahead}`, title: `${b.ahead} 個提交還沒推送` }));
    if (b?.behind) info.append(Object.assign(document.createElement("small"), { textContent: `↓${b.behind}`, title: `遠端有 ${b.behind} 個新提交` }));
    const sync = document.createElement("div");
    sync.className = "git-sync";
    sync.append(
      this.#button("拉取", "arrow-down-to-line", () => this.pull()),
      this.#button("推送", "arrow-up-from-line", () => this.push()),
    );
    branch.append(info, sync);

    // 提交
    const root = this.#hooks.root() ?? "";
    this.#message.placeholder = changes.length
      ? `提交說明（留空就用「${defaultMessage(changes, baseName)}」）`
      : "沒有需要提交的變更";
    this.#message.disabled = this.#busy || !changes.length;
    const actions = document.createElement("div");
    actions.className = "git-actions";
    const commit = this.#button("提交", "git-commit-horizontal", () => this.commit(false));
    const commitPush = this.#button("提交並推送", "arrow-up-from-line", () => this.commit(true));
    commitPush.classList.add("btn-primary");
    for (const el of [commit, commitPush]) el.disabled = this.#busy || !changes.length;
    commit.title = "提交（Ctrl+Enter）";
    actions.append(commit, commitPush);

    // 變更清單
    const head = document.createElement("h3");
    head.className = "git-changes-head";
    head.textContent = changes.length ? `變更（${changes.length}）` : "沒有變更";
    if (changes.some((c) => c.status === "conflicted")) head.textContent += "・有衝突";
    const list = document.createElement("ul");
    list.className = "git-files";
    list.append(
      ...changes.map((c) => {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.status = c.status;
        const rel = c.path.startsWith(root) ? c.path.slice(root.length + 1) : c.path;
        const dir = rel.includes("/") || rel.includes("\\") ? rel.slice(0, rel.length - baseName(rel).length - 1) : "";
        btn.title = `${LABEL[c.status]}：${rel}`;
        btn.append(
          Object.assign(document.createElement("span"), { className: "git-file-name", textContent: baseName(rel) }),
          Object.assign(document.createElement("span"), { className: "git-file-dir", textContent: dir }),
          Object.assign(document.createElement("b"), { textContent: MARK[c.status], title: LABEL[c.status] }),
        );
        btn.disabled = c.status === "deleted";
        btn.addEventListener("click", () => this.#hooks.open(c.path));
        li.append(btn);
        return li;
      }),
    );

    const hint = this.#syncHint(s);
    this.#host.replaceChildren(...(hint ? [hint] : []), branch, this.#message, actions, head, list);
  }

  /** 還沒有開啟資料夾，或資料夾還不是 Git 儲存庫：引導用 GitHub 同步。 */
  #renderSetup(): void {
    const root = this.#hooks.root();
    const box = document.createElement("div");
    box.className = "git-setup";
    const title = document.createElement("strong");
    const text = document.createElement("p");
    const actions = document.createElement("div");
    actions.className = "git-setup-actions";
    const open = this.#button("從 GitHub 開啟儲存庫", "git-branch", () => this.#github.openRepo());
    if (root) {
      title.textContent = "這個資料夾還沒有同步到 GitHub";
      text.textContent = "上傳到 GitHub 之後，可以在其他電腦下載同一個資料夾，每次的修改都會留下紀錄，也可以自動同步。不需要安裝 Git。";
      const publish = this.#button("上傳到 GitHub", "arrow-up-from-line", () => this.#github.publish());
      publish.classList.add("btn-primary");
      actions.append(publish, open);
    } else {
      title.textContent = "用 GitHub 同步你的筆記";
      text.textContent = "從 GitHub 下載儲存庫到電腦，編輯後一鍵同步；或先開啟資料夾，再上傳到 GitHub。不需要安裝 Git。";
      open.classList.add("btn-primary");
      actions.append(open);
    }
    box.append(title, text, actions, this.#accountLine());
    this.#host.replaceChildren(box);
  }

  /** 目前登入的 GitHub 帳號（或登入按鈕）。 */
  #accountLine(): HTMLElement {
    const line = document.createElement("div");
    line.className = "git-account";
    const a = this.#github.account;
    if (a) {
      line.append(Object.assign(document.createElement("span"), { textContent: `已登入 GitHub：${a.login}` }));
    } else {
      line.append(
        Object.assign(document.createElement("span"), { textContent: "還沒有登入 GitHub" }),
        this.#button("用 GitHub 登入", "shield-check", async () => {
          await this.#github.login();
          this.#render();
        }),
      );
    }
    return line;
  }

  /** 已經是儲存庫，但還不能同步時的提示（沒有遠端、還沒登入 GitHub）。 */
  #syncHint(s: GitStatus): HTMLElement | null {
    if (!s.remote) {
      const box = document.createElement("div");
      box.className = "git-hint";
      box.append(
        Object.assign(document.createElement("span"), { textContent: "這個儲存庫還沒有連到 GitHub。" }),
        this.#button("上傳到 GitHub", "arrow-up-from-line", () => this.#github.publish()),
      );
      return box;
    }
    if (/^https:\/\/github\.com\//i.test(s.remote) && !this.#github.account) {
      const box = document.createElement("div");
      box.className = "git-hint";
      box.append(
        Object.assign(document.createElement("span"), { textContent: "登入 GitHub 才能拉取與推送。" }),
        this.#button("用 GitHub 登入", "shield-check", async () => {
          await this.#github.login();
          this.#render();
        }),
      );
      return box;
    }
    return null;
  }

  #button(label: string, iconName: string, run: () => Promise<void>): HTMLButtonElement {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "btn";
    el.disabled = this.#busy;
    el.append(icon(iconName), Object.assign(document.createElement("span"), { textContent: label }));
    el.addEventListener("click", () => void run());
    return el;
  }

  async #run(label: string, task: () => Promise<string>, quiet = false): Promise<boolean> {
    if (this.#busy) return false;
    this.#busy = true;
    this.#render();
    try {
      const message = await task();
      if (!quiet) toast(message, { tone: "success" });
      return true;
    } catch (e) {
      toast(`${label}：${e instanceof Error ? e.message : e}`, { tone: "error", duration: 12000 });
      return false;
    } finally {
      this.#busy = false;
      await this.refresh();
    }
  }

  pull(): Promise<void> {
    return this.#run("Git", () => this.#d.gitPull()).then(() => {});
  }

  push(): Promise<void> {
    return this.#run("Git", () => this.#d.gitPush()).then(() => {});
  }

  async commit(push: boolean): Promise<void> {
    const changes = this.#status?.changes ?? [];
    if (!changes.length) {
      toast("沒有需要提交的變更。");
      return;
    }
    const message = this.#message.value.trim() || defaultMessage(changes, baseName);
    const ok = await this.#run("提交失敗", async () => {
      const summary = await this.#d.gitCommit(message);
      return `已提交：${summary}`;
    });
    if (!ok) return;
    this.#message.value = "";
    if (push) await this.push();
  }

  // ---- 自動同步 -----------------------------------------------------------

  #scheduleSync(): void {
    clearTimeout(this.#syncTimer);
    const s = this.#settings.value;
    if (!s.gitAutoSync || this.#syncPaused || !this.#status?.repo) return;
    this.#syncTimer = window.setTimeout(() => void this.#sync(), s.gitSyncMinutes * 60_000);
  }

  /** 提交 → 拉取 → 推送。任何一步出錯就暫停自動同步，不會自動處理衝突。 */
  async #sync(): Promise<void> {
    if (this.#busy || !this.#status?.repo) return this.#scheduleSync();
    const ok = await this.#run(
      "自動同步失敗，已暫停",
      async () => {
        if (this.#status?.changes.length) await this.#d.gitCommit(syncMessage());
        if (this.#status?.branch?.upstream) {
          await this.#d.gitPull();
          await this.#d.gitPush();
        }
        return "已自動同步";
      },
      true,
    );
    if (!ok) this.#syncPaused = true;
    this.#scheduleSync();
  }
}
