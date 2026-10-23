/**
 * AI 協作（桌面版，預設關閉）：
 * - 編輯器 MCP 伺服器：同步目前的文件與選取範圍給 Claude Code／Codex，並處理它們提出的修改。
 * - 選取段落快捷動作：把選取的文字交給 `claude -p`／`codex exec` 處理，結果用差異檢視讓使用者決定。
 * - AI 要求在終端機執行指令：每次都先請使用者同意（或在這次開啟期間一律允許）。
 *
 * AI 的修改一律經過差異檢視，不會直接寫入檔案；使用者接受後仍需自己存檔。
 */
import { applyEdits, buildPrompt, cleanResult } from "./ai-text.ts";
import type { AiCommand, AiProposal, AiRunEvent, Desktop, EditorSnapshot } from "./desktop.ts";
import type { Editor } from "./editor.ts";
import { t } from "./i18n.ts";
import type { QuickAction, Settings, SettingsStore } from "./settings.ts";
import { icon } from "./ui/icons.ts";
import { choose } from "./ui/choice.ts";
import type { Review } from "./ui/review.ts";
import { toast } from "./ui/toast.ts";

export interface AiHost {
  editor: Editor;
  review: Review;
  /** 目前編輯器的狀態（給 MCP 用）。 */
  snapshot(): EditorSnapshot;
  /** 切換到（必要時開啟）提議要修改的文件；`null` 表示目前的文件。 */
  showDocument(path: string | null): Promise<void>;
}

const TOOL_LABEL = { claude: "Claude Code", codex: "Codex" } as const;

interface Run {
  id: number;
  name: string;
  from: number;
  to: number;
  original: string;
  text: string;
}

export class AiController {
  #d: Desktop;
  #settings: SettingsStore;
  #host: AiHost;
  #bar: HTMLElement;
  #mcpRunning = false;
  #syncTimer = 0;
  #queue: AiProposal[] = [];
  #handling = false;
  #run: Run | null = null;
  #nextRun = 1;
  /** 使用者選了「這次開啟期間都直接執行」。重新開啟編輯器後恢復詢問。 */
  #allowCommands = false;
  /** 還在等使用者決定的指令（AI 不再等待時關閉對話框）。 */
  #asking = new Map<number, AbortController>();

  constructor(d: Desktop, settings: SettingsStore, host: AiHost, bar: HTMLElement) {
    this.#d = d;
    this.#settings = settings;
    this.#host = host;
    this.#bar = bar;
    bar.hidden = true;
    void d.onAiProposal((p) => {
      this.#queue.push(p);
      void this.#nextProposal();
    });
    void d.onAiRun((e) => this.#onRun(e));
    void d.onAiCommand((c) => void this.#onCommand(c));
    void d.onAiCommandExpired((id) => this.#asking.get(id)?.abort());
    settings.subscribe((s, changed) => {
      if (changed.some((k) => k === "aiEnabled" || k === "mcpServer")) void this.#applyMcp(s);
    });
    void this.#applyMcp(settings.value);
  }

  get enabled(): boolean {
    return this.#settings.value.aiEnabled;
  }

  /** 文件、選取範圍或分頁有變動時呼叫；稍候再同步給 MCP 伺服器。 */
  scheduleSync(): void {
    if (!this.#mcpRunning) return;
    clearTimeout(this.#syncTimer);
    this.#syncTimer = window.setTimeout(() => {
      void this.#d.mcpSync(this.#host.snapshot()).catch((e) => console.error("同步編輯器狀態失敗", e)); // i18n-ignore（開發者主控台）
    }, 250);
  }

  /** 設定面板「複製註冊指令」用。 */
  async registration(): Promise<{ claudeAdd: string; codexAdd: string }> {
    const s = this.#settings.value;
    if (!s.aiEnabled || !s.mcpServer) throw new Error(t("請先開啟「啟用 AI 協作」與「讓 AI 讀取目前的文件」"));
    return this.#d.mcpStart();
  }

  async #applyMcp(s: Readonly<Settings>): Promise<void> {
    const want = s.aiEnabled && s.mcpServer;
    if (want === this.#mcpRunning) return;
    try {
      if (want) {
        await this.#d.mcpStart();
        this.#mcpRunning = true;
        this.scheduleSync();
      } else {
        this.#mcpRunning = false;
        await this.#d.mcpStop();
      }
    } catch (e) {
      toast(t("無法啟動編輯器的 MCP 伺服器：{error}", { error: e instanceof Error ? e.message : String(e) }), { tone: "error" });
    }
  }

  // ---- AI 透過 MCP 提出的修改 ------------------------------------------------

  async #nextProposal(): Promise<void> {
    if (this.#handling) return;
    const p = this.#queue.shift();
    if (!p) return;
    this.#handling = true;
    try {
      await this.#handle(p);
    } finally {
      this.#handling = false;
      void this.#nextProposal();
    }
  }

  #respond(id: number, ok: boolean, message: string): void {
    void this.#d.mcpRespond(id, { ok, message }).catch((e) => console.error(e));
  }

  /** 顯示一個提議，等使用者處理完（或改做別的事）再回覆給 AI。 */
  async #handle(p: AiProposal): Promise<void> {
    const { editor, review } = this.#host;
    try {
      await this.#host.showDocument(p.path);
    } catch (e) {
      // 回覆給 AI 的訊息（不是介面），維持中文。
      this.#respond(p.id, false, `無法開啟文件：${e instanceof Error ? e.message : e}`); // i18n-ignore
      return;
    }
    const before = editor.text;
    let proposed: string;
    try {
      if (p.kind === "selection") {
        const { from, to } = editor.view.state.selection.main;
        proposed = before.slice(0, from) + p.replacement.replace(/\r\n/g, "\n") + before.slice(to);
      } else {
        proposed = applyEdits(before, p.edits);
      }
    } catch (e) {
      this.#respond(p.id, false, e instanceof Error ? e.message : String(e));
      return;
    }
    if (proposed === before) {
      this.#respond(p.id, true, "提議的內容和目前的文件相同，沒有需要修改的地方。"); // i18n-ignore（回覆給 AI）
      return;
    }
    await new Promise<void>((resolve) => {
      const started = review.start(proposed, {
        title: t("AI 提出的修改"),
        hint: p.summary || t("逐段選擇要不要採用；接受後記得存檔。"),
        acceptLabel: t("接受"),
        rejectLabel: t("拒絕"),
        onFinish: () => {
          const after = editor.text;
          // 下面三句是回覆給 AI 的訊息（不是介面）。
          // i18n-ignore
          if (after === proposed) this.#respond(p.id, true, "使用者接受了全部修改（已套用到編輯器，使用者稍後會自己存檔）。");
          else if (after === before) this.#respond(p.id, true, "使用者拒絕了這次修改，文件維持原樣。"); // i18n-ignore
          else this.#respond(p.id, true, "使用者接受了部分修改。最新內容可以用 get_active_document 查看。"); // i18n-ignore
          resolve();
        },
      });
      if (!started) {
        this.#respond(p.id, true, "提議的內容和目前的文件相同。"); // i18n-ignore（回覆給 AI）
        resolve();
      }
    });
  }

  // ---- AI 要求在終端機執行的指令 ----------------------------------------------

  async #onCommand(c: AiCommand): Promise<void> {
    const reply = async (ok: boolean, message: string) => {
      const waiting = await this.#d.mcpRespond(c.id, { ok, message }).catch(() => false);
      if (ok && !waiting) toast(t("AI 已經不再等待這個指令，所以沒有執行。"), { tone: "error" });
    };
    const s = this.#settings.value;
    if (!s.aiEnabled || !s.aiTerminal) {
      // 回覆給 AI 的訊息（不是介面）。
      await reply(false, "使用者沒有開放讓 AI 在終端機執行指令（設定 → AI 協作 →「讓 AI 在終端機執行指令」）。"); // i18n-ignore
      return;
    }
    if (this.#allowCommands) {
      await reply(true, "使用者已同意。"); // i18n-ignore（回覆給 AI）
      return;
    }
    const ctl = new AbortController();
    this.#asking.set(c.id, ctl);
    const choice = await choose(
      t("AI 要在終端機執行指令"),
      c.reason
        ? t("{reason}。執行位置：{cwd}。執行過程會顯示在下方的終端機。", { reason: c.reason, cwd: c.cwd })
        : t("執行位置：{cwd}。執行過程會顯示在下方的終端機。", { cwd: c.cwd }),
      [
        { id: "run", label: t("執行"), primary: true },
        { id: "always", label: t("這次開啟期間都直接執行") },
        { id: "deny", label: t("拒絕") },
      ],
      // 對話框可能在使用者打字時跳出來：預設聚焦「拒絕」，按 Enter 不會誤執行。
      { code: c.command, signal: ctl.signal, focus: "deny" },
    );
    this.#asking.delete(c.id);
    if (ctl.signal.aborted) {
      toast(t("AI 等太久已經放棄，指令沒有執行。"), { duration: 6000 });
      return;
    }
    if (choice === "run" || choice === "always") {
      if (choice === "always") this.#allowCommands = true;
      await reply(true, "使用者已同意。"); // i18n-ignore（回覆給 AI）
    } else {
      // 回覆給 AI 的訊息（不是介面）。
      await reply(false, "使用者拒絕執行這個指令。請不要再要求執行相同的指令，可以改問使用者想怎麼做。"); // i18n-ignore
    }
  }

  // ---- 選取段落快捷動作 ------------------------------------------------------

  get running(): boolean {
    return this.#run !== null;
  }

  /** 對目前的選取範圍執行快捷動作（或自訂指示）。 */
  async runAction(action: QuickAction): Promise<void> {
    const { editor, review } = this.#host;
    if (this.#run) {
      toast(t("上一個 AI 動作還在處理中。"));
      return;
    }
    const { from, to } = editor.view.state.selection.main;
    if (from === to) {
      toast(t("請先選取要處理的文字。"));
      return;
    }
    if (review.active) review.finish();
    const original = editor.view.state.sliceDoc(from, to);
    const run: Run = { id: this.#nextRun++, name: action.name, from, to, original, text: "" };
    this.#run = run;
    this.#renderBar();
    try {
      await this.#d.aiRun(run.id, this.#settings.value.aiTool, buildPrompt(action.prompt, original));
    } catch (e) {
      this.#run = null;
      this.#renderBar();
      toast(e instanceof Error ? e.message : String(e), { tone: "error", duration: 10000 });
    }
  }

  cancel(): void {
    if (!this.#run) return;
    void this.#d.aiCancel(this.#run.id);
    this.#run = null;
    this.#renderBar();
  }

  #onRun(e: AiRunEvent): void {
    const run = this.#run;
    if (!run || e.id !== run.id) return;
    if (e.kind === "delta") {
      run.text += e.text;
      this.#renderBar();
      return;
    }
    this.#run = null;
    this.#renderBar();
    if (e.kind === "error") {
      toast(t("AI 處理失敗：{error}", { error: e.message }), { tone: "error", duration: 12000 });
      return;
    }
    this.#apply(run, cleanResult(e.text || run.text, run.original), e.costUsd, e.tokens);
  }

  /** 把結果套用到原本選取的位置（使用者在等待期間可能改過文件，所以重新確認位置）。 */
  #apply(run: Run, result: string, costUsd: number | null, tokens: number | null): void {
    const { editor, review } = this.#host;
    const text = editor.text;
    let from = run.from;
    if (text.slice(run.from, run.to) !== run.original) {
      const at = text.indexOf(run.original);
      if (at < 0 || text.indexOf(run.original, at + 1) >= 0) {
        toast(t("原本選取的文字已經改變，無法套用 AI 的結果。已把結果複製到剪貼簿。"), { tone: "error", duration: 10000 });
        void navigator.clipboard.writeText(result);
        return;
      }
      from = at;
    }
    const proposed = text.slice(0, from) + result + text.slice(from + run.original.length);
    const usage =
      costUsd != null
        ? t("用量約 US${cost}", { cost: costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2) })
        : tokens
          ? t("用了 {n} 個 token", { n: tokens.toLocaleString() })
          : "";
    if (review.active) review.finish();
    const started = review.start(proposed, {
      title: t("AI：{name}", { name: run.name }),
      hint: [usage, t("逐段選擇要不要採用")].filter(Boolean).join(" · "),
      acceptLabel: t("採用"),
      rejectLabel: t("保留原文"),
    });
    if (!started) toast(t("AI 的結果和原文相同。"));
  }

  #renderBar(): void {
    const run = this.#run;
    this.#bar.hidden = !run;
    if (!run) return;
    const head = document.createElement("p");
    head.append(icon("sparkles"));
    head.append(Object.assign(document.createElement("strong"), { textContent: t("AI：{name}", { name: run.name }) }));
    head.append(
      Object.assign(document.createElement("span"), {
        textContent: t("{tool} 處理中…", { tool: TOOL_LABEL[this.#settings.value.aiTool] }),
      }),
    );
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "btn";
    stop.append(icon("circle-stop"), t("取消"));
    stop.addEventListener("click", () => this.cancel());
    const preview = document.createElement("div");
    preview.className = "ai-stream";
    preview.textContent = run.text.slice(-400) || t("等待回應…");
    this.#bar.replaceChildren(head, stop, preview);
  }
}
