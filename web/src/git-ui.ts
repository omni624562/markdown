/**
 * Git 整合（桌面版）：側邊欄的「原始碼控制」面板、檔案樹的變更標記、自動同步。
 * Git 內建在程式裡（不需要安裝）；資料夾還不是 Git 儲存庫時，面板改成引導：
 * 用 GitHub 登入、從 GitHub 開啟儲存庫、把資料夾上傳到 GitHub。
 */
import type { Desktop, GitChange, GitConflict, GitStatus } from "./desktop.ts";
import type { GitHub } from "./github-ui.ts";
import type { SettingsStore } from "./settings.ts";
import type { FileTree } from "./ui/filetree.ts";
import { currentLang, t } from "./i18n.ts";
import { icon } from "./ui/icons.ts";
import { choose } from "./ui/choice.ts";
import { toast } from "./ui/toast.ts";

const MARK: Record<GitChange["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
};

/** 變更清單上的說明（滑鼠提示）。 */
const LABEL: Record<GitChange["status"], (path: string) => string> = {
  modified: (path) => t("修改：{path}", { path }),
  added: (path) => t("新增：{path}", { path }),
  deleted: (path) => t("刪除：{path}", { path }),
  renamed: (path) => t("改名：{path}", { path }),
  untracked: (path) => t("新檔案：{path}", { path }),
  conflicted: (path) => t("衝突：{path}", { path }),
};

/** 只有一個檔案時的預設提交說明。 */
const SUMMARY: Record<GitChange["status"], (name: string) => string> = {
  modified: (name) => t("修改 {name}", { name }),
  added: (name) => t("新增 {name}", { name }),
  deleted: (name) => t("刪除 {name}", { name }),
  renamed: (name) => t("改名 {name}", { name }),
  untracked: (name) => t("新檔案 {name}", { name }),
  conflicted: (name) => t("衝突 {name}", { name }),
};

/** 預設的提交說明。 */
export function defaultMessage(changes: GitChange[], name: (path: string) => string): string {
  if (changes.length === 1) return SUMMARY[changes[0].status](name(changes[0].path));
  return t("更新 {n} 個檔案", { n: changes.length });
}

export function syncMessage(date = new Date()): string {
  const locale = currentLang() === "en" ? "en-US" : "zh-TW";
  const f = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short", hour12: false });
  return t("自動同步 {time}", { time: f.format(date) });
}

const baseName = (p: string) => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);

export interface GitPanelHooks {
  /** 目前的工作區根目錄。 */
  root(): string | null;
  /** 點變更清單中的檔案。 */
  open(path: string): void;
  /** 開啟衝突的檔案並逐段比較（`theirs` 是都採用遠端時的內容）。 */
  resolve(path: string, theirs: string): void;
  /** 切換或建立分支。 */
  switchBranch(): void;
  /** 建立 Pull Request。 */
  createPr(): void;
  /** 開啟 Git 歷史。 */
  history(): void;
  /** 從 Azure DevOps／TFS 下載儲存庫（有這個功能時）。 */
  openAdo: (() => void) | null;
  /** 儲存庫狀態改變（更新活動列圖示的變更數）。沒有開啟資料夾時是 null。 */
  changed(status: GitStatus | null): void;
}

/** 視窗在前面時，多久向遠端檢查一次有沒有新的提交。 */
const FETCH_INTERVAL = 5 * 60_000;

/** 按鈕上的數字（差幾個提交）。 */
function count(n: number): HTMLElement {
  return Object.assign(document.createElement("span"), { className: "git-count", textContent: String(n) });
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
  /** 上次向遠端檢查（抓取）的時間；0 表示還沒檢查。 */
  #lastFetch = 0;
  #fetching = false;
  /** 上次檢查遠端失敗的原因（例如沒有登入）。 */
  #fetchError: string | null = null;
  #message: HTMLTextAreaElement;
  /** 這次合併中，每個衝突檔案「都採用遠端」的內容（重新開啟程式後就沒有了）。 */
  #theirs = new Map<string, string>();

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
    this.#message.setAttribute("aria-label", t("提交說明"));
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
    // 視窗沒在前面時不用輪詢；切回來時 focus 事件會更新。
    setInterval(() => {
      if (!document.hidden) this.refreshSoon();
    }, 60_000);
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
    if (Date.now() - this.#lastFetch > FETCH_INTERVAL) void this.#fetchRemote();
  }

  /**
   * 在背景向遠端檢查有沒有新的提交（只抓取，不合併、不動檔案），拉取按鈕才知道差幾個版本。
   * 視窗在前面時每幾分鐘一次；沒有登入等原因失敗時不跳出錯誤，只顯示在按鈕的說明裡。
   */
  async #fetchRemote(manual = false): Promise<void> {
    if (this.#fetching || this.#busy || !this.#status?.branch?.upstream || this.#status.merging) return;
    this.#fetching = true;
    this.#lastFetch = Date.now();
    if (manual) this.#render();
    try {
      await this.#d.gitFetch(!manual);
      this.#fetchError = null;
    } catch (e) {
      this.#fetchError = e instanceof Error ? e.message : String(e);
    } finally {
      this.#fetching = false;
    }
    await this.refresh();
    if (!manual) return;
    // 按「立刻檢查」時把結果說出來（背景檢查只更新按鈕上的數字）。
    const b = this.#status?.branch;
    if (this.#fetchError) toast(t("無法檢查遠端：{error}", { error: this.#fetchError }), { tone: "error", duration: 12000 });
    else if (!b?.ahead && !b?.behind) toast(t("已經和遠端一致"), { tone: "success" });
    else {
      const parts = [
        ...(b.behind ? [t("遠端有 {n} 個新提交", { n: b.behind })] : []),
        ...(b.ahead ? [t("{n} 個提交還沒推送", { n: b.ahead })] : []),
      ];
      toast(parts.join(t("，")));
    }
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
    const info = document.createElement("button");
    info.type = "button";
    info.className = "git-info";
    info.title = b?.upstream
      ? t("追蹤 {upstream}；按一下切換或建立分支", { upstream: b.upstream })
      : t("這個分支還沒有設定遠端；按一下切換或建立分支");
    info.disabled = this.#busy || s.merging;
    info.addEventListener("click", () => this.#hooks.switchBranch());
    info.append(icon("git-branch"), Object.assign(document.createElement("strong"), { textContent: b?.name ?? t("（未知分支）") }));
    const sync = document.createElement("div");
    sync.className = "git-sync";
    const pr = this.#button("", "git-pull-request", async () => this.#hooks.createPr());
    pr.title = t("建立 Pull Request");
    pr.setAttribute("aria-label", t("建立 Pull Request"));
    const history = this.#button("", "git-graph", async () => this.#hooks.history());
    history.title = t("Git 歷史（線圖）");
    history.setAttribute("aria-label", t("Git 歷史（線圖）"));
    // 立刻向遠端檢查，比對本機和遠端差幾個提交（不合併、不動檔案）。
    const check = this.#button("", "refresh-cw", () => this.#fetchRemote(true));
    check.title = t("立刻檢查遠端（比對本機和遠端差幾個提交）");
    check.setAttribute("aria-label", t("立刻檢查遠端"));
    check.disabled ||= this.#fetching || !b?.upstream || s.merging;
    check.classList.toggle("spinning", this.#fetching);
    // 拉取、推送按鈕上顯示和遠端差幾個提交。
    const pull = this.#button(t("拉取"), "arrow-down-to-line", () => this.pull());
    const push = this.#button(t("推送"), "arrow-up-from-line", () => this.push());
    if (b?.upstream) {
      if (b.behind) pull.append(count(b.behind));
      if (b.ahead) push.append(count(b.ahead));
      const checked = this.#fetchError
        ? t("無法檢查遠端：{error}", { error: this.#fetchError })
        : this.#lastFetch
          ? t("上次檢查遠端：{time}", { time: new Date(this.#lastFetch).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })
          : t("還沒檢查遠端");
      const incoming = b.behind ? t("遠端有 {n} 個新提交", { n: b.behind }) : t("沒有新的遠端提交");
      pull.title = `${incoming}\n${checked}`;
      push.title = b.ahead ? t("{n} 個提交還沒推送", { n: b.ahead }) : t("沒有要推送的提交");
    }
    sync.append(history, check, pull, push, ...(s.remote ? [pr] : []));
    branch.append(info, sync);

    // 提交
    const root = this.#hooks.root() ?? "";
    this.#message.placeholder = changes.length
      ? t("提交說明（留空就用「{message}」）", { message: defaultMessage(changes, baseName) })
      : t("沒有需要提交的變更");
    this.#message.disabled = this.#busy || !changes.length || s.merging;
    const actions = document.createElement("div");
    actions.className = "git-actions";
    const commit = this.#button(t("提交"), "git-commit-horizontal", () => this.commit(false));
    const commitPush = this.#button(t("提交並推送"), "arrow-up-from-line", () => this.commit(true));
    commitPush.classList.add("btn-primary");
    for (const el of [commit, commitPush]) el.disabled = this.#busy || !changes.length || s.merging;
    commit.title = t("提交（Ctrl+Enter）");
    actions.append(commit, commitPush);

    // 變更清單
    const head = document.createElement("h3");
    head.className = "git-changes-head";
    head.textContent = changes.length ? t("變更（{n}）", { n: changes.length }) : t("沒有變更");
    if (changes.some((c) => c.status === "conflicted")) head.textContent += t("・有衝突");
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
        btn.title = LABEL[c.status](rel);
        btn.append(
          Object.assign(document.createElement("span"), { className: "git-file-name", textContent: baseName(rel) }),
          Object.assign(document.createElement("span"), { className: "git-file-dir", textContent: dir }),
          Object.assign(document.createElement("b"), { textContent: MARK[c.status], title: LABEL[c.status](rel) }),
        );
        btn.disabled = c.status === "deleted";
        btn.addEventListener("click", () => {
          const theirs = this.#theirs.get(c.path);
          if (c.status === "conflicted" && theirs !== undefined) this.#hooks.resolve(c.path, theirs);
          else this.#hooks.open(c.path);
        });
        li.append(btn);
        return li;
      }),
    );

    const hint = s.merging ? this.#mergeBox(changes) : this.#syncHint(s);
    this.#host.replaceChildren(...(hint ? [hint] : []), branch, this.#message, actions, head, list);
  }

  /** 正在合併：說明怎麼處理，並提供「完成合併」「放棄合併」。 */
  #mergeBox(changes: GitChange[]): HTMLElement {
    const box = document.createElement("div");
    box.className = "git-hint git-merge";
    const left = changes.filter((c) => c.status === "conflicted").length;
    box.append(
      Object.assign(document.createElement("strong"), { textContent: t("正在合併遠端的變更") }),
      Object.assign(document.createElement("span"), {
        textContent: left
          ? t("下面標「!」的 {n} 個檔案兩邊改到同一個地方。點檔案逐段選「採用遠端」或「保留本機」，存檔後按「完成合併」。", { n: left })
          : t("處理完了，按「完成合併」建立合併提交。"),
      }),
    );
    const finish = this.#button(t("完成合併"), "git-merge", () => this.finishMerge());
    finish.classList.add("btn-primary");
    const abort = this.#button(t("放棄合併"), "x", () => this.abortMerge());
    const row = document.createElement("div");
    row.className = "git-merge-actions";
    row.append(finish, abort);
    box.append(row);
    return box;
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
    const open = this.#button(t("從 GitHub 開啟儲存庫"), "github", () => this.#github.openRepo());
    if (root) {
      title.textContent = t("這個資料夾還沒有同步到 GitHub");
      text.textContent = t("上傳到 GitHub 之後，可以在其他電腦下載同一個資料夾，每次的修改都會留下紀錄，也可以自動同步。不需要安裝 Git。");
      const publish = this.#button(t("上傳到 GitHub"), "arrow-up-from-line", () => this.#github.publish());
      publish.classList.add("btn-primary");
      actions.append(publish, open);
    } else {
      title.textContent = t("用 GitHub 同步你的筆記");
      text.textContent = t("從 GitHub 下載儲存庫到電腦，編輯後一鍵同步；或先開啟資料夾，再上傳到 GitHub。不需要安裝 Git。");
      open.classList.add("btn-primary");
      actions.append(open);
    }
    const ado = this.#hooks.openAdo;
    if (ado) actions.append(this.#button(t("從 Azure DevOps／TFS 下載"), "briefcase-business", async () => ado()));
    box.append(title, text, actions, this.#accountLine());
    this.#host.replaceChildren(box);
  }

  /** 目前登入的 GitHub 帳號（或登入按鈕）。 */
  #accountLine(): HTMLElement {
    const line = document.createElement("div");
    line.className = "git-account";
    const a = this.#github.account;
    if (a) {
      line.append(Object.assign(document.createElement("span"), { textContent: t("已登入 GitHub：{login}", { login: a.login }) }));
    } else {
      line.append(
        Object.assign(document.createElement("span"), { textContent: t("還沒有登入 GitHub") }),
        this.#button(t("用 GitHub 登入"), "shield-check", async () => {
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
        Object.assign(document.createElement("span"), { textContent: t("這個儲存庫還沒有連到 GitHub。") }),
        this.#button(t("上傳到 GitHub"), "arrow-up-from-line", () => this.#github.publish()),
      );
      return box;
    }
    if (/^https:\/\/github\.com\//i.test(s.remote) && !this.#github.account) {
      const box = document.createElement("div");
      box.className = "git-hint";
      box.append(
        Object.assign(document.createElement("span"), { textContent: t("登入 GitHub 才能拉取與推送。") }),
        this.#button(t("用 GitHub 登入"), "shield-check", async () => {
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
      toast(t("{label}：{error}", { label, error: e instanceof Error ? e.message : String(e) }), { tone: "error", duration: 12000 });
      return false;
    } finally {
      this.#busy = false;
      await this.refresh();
    }
  }

  async pull(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    this.#render();
    try {
      toast(await this.#d.gitPull(), { tone: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 兩邊改到同一個地方：讓使用者選擇逐段處理。
      if (message.includes(t("逐段處理"))) {
        toast(message, {
          tone: "error",
          duration: 20000,
          action: { label: t("逐段處理"), run: () => void this.startMerge() },
        });
      } else {
        toast(t("Git：{message}", { message }), { tone: "error", duration: 12000 });
      }
    } finally {
      this.#busy = false;
      await this.refresh();
    }
  }

  /** 開始合併：沒有衝突的部分直接合併，有衝突的檔案逐段處理。 */
  async startMerge(): Promise<void> {
    let conflicts: Awaited<ReturnType<Desktop["gitMergeStart"]>> = [];
    const ok = await this.#run(
      t("合併失敗"),
      async () => {
        conflicts = await this.#d.gitMergeStart();
        return "";
      },
      true,
    );
    if (ok) this.resolveConflicts(conflicts);
  }

  /** 合併後有衝突的檔案：逐段處理（從 Git 歷史合併分支時也用這裡）。 */
  resolveConflicts(conflicts: GitConflict[]): void {
    this.#theirs.clear();
    for (const c of conflicts) if (c.theirs !== null) this.#theirs.set(c.path, c.theirs);
    const notes = conflicts.filter((c) => c.note).map((c) => t("{name}：{note}", { name: baseName(c.path), note: c.note ?? "" }));
    if (notes.length) toast(notes.join(t("；")), { duration: 12000 });
    const first = conflicts.find((c) => c.theirs !== null);
    if (first) this.#hooks.resolve(first.path, first.theirs!);
    else toast(t("沒有需要逐段處理的檔案，按「完成合併」就好。"));
  }

  finishMerge(): Promise<void> {
    return this.#run(t("完成合併失敗"), async () => {
      const message = await this.#d.gitMergeFinish();
      this.#theirs.clear();
      return message;
    }).then(() => {});
  }

  async abortMerge(): Promise<void> {
    const ok = await choose(
      t("放棄合併"),
      t("會回到拉取前的狀態，剛才逐段處理的內容會被丟掉。遠端的變更之後還可以再拉取一次。"),
      [
        { id: "cancel", label: t("取消") },
        { id: "abort", label: t("放棄合併"), danger: true },
      ],
    );
    if (ok !== "abort") return;
    await this.#run(t("放棄合併失敗"), async () => {
      const message = await this.#d.gitMergeAbort();
      this.#theirs.clear();
      return message;
    });
  }

  push(): Promise<void> {
    return this.#run("Git", () => this.#d.gitPush()).then(() => {});
  }

  async commit(push: boolean): Promise<void> {
    const changes = this.#status?.changes ?? [];
    if (!changes.length) {
      toast(t("沒有需要提交的變更。"));
      return;
    }
    const message = this.#message.value.trim() || defaultMessage(changes, baseName);
    const ok = await this.#run(t("提交失敗"), async () => {
      const summary = await this.#d.gitCommit(message);
      return t("已提交：{summary}", { summary });
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
      t("自動同步失敗，已暫停"),
      async () => {
        if (this.#status?.changes.length) await this.#d.gitCommit(syncMessage());
        if (this.#status?.branch?.upstream) {
          await this.#d.gitPull();
          await this.#d.gitPush();
        }
        return t("已自動同步");
      },
      true,
    );
    if (!ok) this.#syncPaused = true;
    this.#scheduleSync();
  }
}
