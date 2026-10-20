/**
 * Git 整合（桌面版）：側邊欄的「原始碼控制」面板、檔案樹的變更標記、自動同步。
 * 找不到 git 或資料夾不是 Git 儲存庫時，面板和活動列的圖示都會隱藏。
 */
import type { Desktop, GitChange, GitStatus } from "./desktop.ts";
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
  /** 儲存庫狀態改變（顯示或隱藏活動列圖示、更新變更數）。 */
  changed(status: GitStatus | null): void;
}

export class GitPanel {
  #d: Desktop;
  #settings: SettingsStore;
  #tree: FileTree;
  #host: HTMLElement;
  #hooks: GitPanelHooks;
  #status: GitStatus | null = null;
  #busy = false;
  #refreshTimer = 0;
  #syncTimer = 0;
  /** 自動同步出錯後，這次開啟期間先暫停。 */
  #syncPaused = false;
  #message: HTMLTextAreaElement;

  constructor(host: HTMLElement, d: Desktop, settings: SettingsStore, tree: FileTree, hooks: GitPanelHooks) {
    this.#host = host;
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
    this.#hooks.changed(this.#status?.repo ? this.#status : null);
    this.#scheduleSync();
  }

  /** 把焦點放到提交說明（指令「Git：提交變更」）。 */
  focusMessage(): void {
    this.#message.focus();
  }

  #render(): void {
    const s = this.#status;
    if (!s?.repo) {
      this.#host.replaceChildren();
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

    this.#host.replaceChildren(branch, this.#message, actions, head, list);
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
