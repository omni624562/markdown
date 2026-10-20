/**
 * Git 整合（桌面版）：檔案面板上方的狀態列、檔案樹的變更標記、提交對話框、自動同步。
 * 找不到 git 或資料夾不是 Git 儲存庫時整個隱藏。
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

export class GitPanel {
  #d: Desktop;
  #settings: SettingsStore;
  #tree: FileTree;
  #bar: HTMLElement;
  #root: () => string | null;
  #status: GitStatus | null = null;
  #busy = false;
  #refreshTimer = 0;
  #syncTimer = 0;
  /** 自動同步出錯後，這次開啟期間先暫停。 */
  #syncPaused = false;
  #dialog: HTMLDialogElement;

  constructor(bar: HTMLElement, d: Desktop, settings: SettingsStore, tree: FileTree, root: () => string | null) {
    this.#bar = bar;
    this.#d = d;
    this.#settings = settings;
    this.#tree = tree;
    this.#root = root;
    this.#dialog = this.#buildDialog();
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
    if (!this.#root()) {
      this.#status = null;
      this.#render();
      return;
    }
    try {
      this.#status = await this.#d.gitStatus();
    } catch {
      this.#status = null;
    }
    const marks = new Map<string, string>();
    for (const c of this.#status?.changes ?? []) marks.set(c.path, MARK[c.status]);
    this.#tree.setStatus(marks);
    this.#render();
    this.#scheduleSync();
  }

  #render(): void {
    const s = this.#status;
    this.#bar.hidden = !s?.repo;
    if (!s?.repo) return;
    const b = s.branch;
    const info = document.createElement("span");
    info.className = "git-info";
    info.title = b?.upstream ? `追蹤 ${b.upstream}` : "這個分支還沒有設定遠端";
    info.append(icon("git-branch"), b?.name ?? "（未知分支）");
    if (b?.ahead) info.append(Object.assign(document.createElement("small"), { textContent: `↑${b.ahead}`, title: `${b.ahead} 個提交還沒推送` }));
    if (b?.behind) info.append(Object.assign(document.createElement("small"), { textContent: `↓${b.behind}`, title: `遠端有 ${b.behind} 個新提交` }));
    const count = document.createElement("span");
    count.className = "git-count";
    count.textContent = s.changes.length ? `${s.changes.length} 個變更` : "沒有變更";
    if (s.changes.some((c) => c.status === "conflicted")) count.textContent += "（有衝突）";
    const button = (label: string, iconName: string, run: () => Promise<void>) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "btn icon-only";
      el.title = label;
      el.setAttribute("aria-label", label);
      el.disabled = this.#busy;
      el.append(icon(iconName));
      el.addEventListener("click", () => void run());
      return el;
    };
    this.#bar.replaceChildren(
      info,
      count,
      button("提交…", "git-commit-horizontal", () => this.openCommit()),
      button("拉取", "arrow-down-to-line", () => this.pull()),
      button("推送", "arrow-up-from-line", () => this.push()),
    );
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

  async openCommit(): Promise<void> {
    await this.refresh();
    const changes = this.#status?.changes ?? [];
    if (!changes.length) {
      toast("沒有需要提交的變更。");
      return;
    }
    const root = this.#root() ?? "";
    const rel = (p: string) => (p.startsWith(root) ? p.slice(root.length + 1) : p);
    const name = (p: string) => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
    const message = this.#dialog.querySelector("textarea")!;
    message.value = "";
    message.placeholder = defaultMessage(changes, name);
    this.#dialog.querySelector(".git-files")!.replaceChildren(
      ...changes.map((c) => {
        const li = document.createElement("li");
        li.append(Object.assign(document.createElement("b"), { textContent: MARK[c.status], title: LABEL[c.status] }), rel(c.path));
        li.dataset.status = c.status;
        return li;
      }),
    );
    this.#dialog.showModal();
    message.focus();
  }

  async #commit(push: boolean): Promise<void> {
    const textarea = this.#dialog.querySelector("textarea")!;
    const message = textarea.value.trim() || textarea.placeholder;
    this.#dialog.close();
    const ok = await this.#run("提交失敗", async () => {
      const summary = await this.#d.gitCommit(message);
      return `已提交：${summary}`;
    });
    if (ok && push) await this.push();
  }

  #buildDialog(): HTMLDialogElement {
    const d = document.createElement("dialog");
    d.className = "choice git-dialog";
    d.setAttribute("aria-labelledby", "git-dialog-title");
    d.innerHTML = `
      <h2 id="git-dialog-title">提交變更</h2>
      <label for="git-message">說明</label>
      <textarea id="git-message" rows="3"></textarea>
      <ul class="git-files" aria-label="要提交的檔案"></ul>
      <div class="choice-actions">
        <button type="button" class="btn" data-act="cancel">取消</button>
        <button type="button" class="btn" data-act="commit">提交</button>
        <button type="button" class="btn btn-primary" data-act="push">提交並推送</button>
      </div>`;
    d.querySelector("[data-act=cancel]")!.addEventListener("click", () => d.close());
    d.querySelector("[data-act=commit]")!.addEventListener("click", () => void this.#commit(false));
    d.querySelector("[data-act=push]")!.addEventListener("click", () => void this.#commit(true));
    d.querySelector("textarea")!.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault();
        void this.#commit(false);
      }
    });
    document.body.append(d);
    return d;
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
