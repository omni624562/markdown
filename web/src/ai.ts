/**
 * AI 協作（桌面版，預設關閉）：
 * - 編輯器 MCP 伺服器：同步目前的文件與選取範圍給 Claude Code／Codex，並處理它們提出的修改。
 * - 選取段落快捷動作：把選取的文字交給 `claude -p`／`codex exec` 處理，結果用差異檢視讓使用者決定。
 *
 * AI 的修改一律經過差異檢視，不會直接寫入檔案；使用者接受後仍需自己存檔。
 */
import { applyEdits, buildPrompt, cleanResult } from "./ai-text.ts";
import type { AiProposal, AiRunEvent, Desktop, EditorSnapshot } from "./desktop.ts";
import type { Editor } from "./editor.ts";
import type { QuickAction, Settings, SettingsStore } from "./settings.ts";
import { icon } from "./ui/icons.ts";
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
      void this.#d.mcpSync(this.#host.snapshot()).catch((e) => console.error("同步編輯器狀態失敗", e));
    }, 250);
  }

  /** 設定面板「複製註冊指令」用。 */
  async registration(): Promise<{ claudeAdd: string; codexAdd: string }> {
    const s = this.#settings.value;
    if (!s.aiEnabled || !s.mcpServer) throw new Error("請先開啟「啟用 AI 協作」與「讓 AI 讀取目前的文件」");
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
      toast(`無法啟動編輯器的 MCP 伺服器：${e instanceof Error ? e.message : e}`, { tone: "error" });
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
      this.#respond(p.id, false, `無法開啟文件：${e instanceof Error ? e.message : e}`);
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
      this.#respond(p.id, true, "提議的內容和目前的文件相同，沒有需要修改的地方。");
      return;
    }
    await new Promise<void>((resolve) => {
      const started = review.start(proposed, {
        title: "AI 提出的修改",
        hint: p.summary || "逐段選擇要不要採用；接受後記得存檔。",
        acceptLabel: "接受",
        rejectLabel: "拒絕",
        onFinish: () => {
          const after = editor.text;
          if (after === proposed) this.#respond(p.id, true, "使用者接受了全部修改（已套用到編輯器，使用者稍後會自己存檔）。");
          else if (after === before) this.#respond(p.id, true, "使用者拒絕了這次修改，文件維持原樣。");
          else this.#respond(p.id, true, "使用者接受了部分修改。最新內容可以用 get_active_document 查看。");
          resolve();
        },
      });
      if (!started) {
        this.#respond(p.id, true, "提議的內容和目前的文件相同。");
        resolve();
      }
    });
  }

  // ---- 選取段落快捷動作 ------------------------------------------------------

  get running(): boolean {
    return this.#run !== null;
  }

  /** 對目前的選取範圍執行快捷動作（或自訂指示）。 */
  async runAction(action: QuickAction): Promise<void> {
    const { editor, review } = this.#host;
    if (this.#run) {
      toast("上一個 AI 動作還在處理中。");
      return;
    }
    const { from, to } = editor.view.state.selection.main;
    if (from === to) {
      toast("請先選取要處理的文字。");
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
      toast(`AI 處理失敗：${e.message}`, { tone: "error", duration: 12000 });
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
        toast("原本選取的文字已經改變，無法套用 AI 的結果。已把結果複製到剪貼簿。", { tone: "error", duration: 10000 });
        void navigator.clipboard.writeText(result);
        return;
      }
      from = at;
    }
    const proposed = text.slice(0, from) + result + text.slice(from + run.original.length);
    const usage =
      costUsd != null ? `用量約 US$${costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2)}` : tokens ? `用了 ${tokens.toLocaleString()} 個 token` : "";
    if (review.active) review.finish();
    const started = review.start(proposed, {
      title: `AI：${run.name}`,
      hint: [usage, "逐段選擇要不要採用"].filter(Boolean).join(" · "),
      acceptLabel: "採用",
      rejectLabel: "保留原文",
    });
    if (!started) toast("AI 的結果和原文相同。");
  }

  #renderBar(): void {
    const run = this.#run;
    this.#bar.hidden = !run;
    if (!run) return;
    const head = document.createElement("p");
    head.append(icon("sparkles"));
    head.append(Object.assign(document.createElement("strong"), { textContent: `AI：${run.name}` }));
    head.append(
      Object.assign(document.createElement("span"), {
        textContent: `${TOOL_LABEL[this.#settings.value.aiTool]} 處理中…`,
      }),
    );
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "btn";
    stop.append(icon("circle-stop"), "取消");
    stop.addEventListener("click", () => this.cancel());
    const preview = document.createElement("div");
    preview.className = "ai-stream";
    preview.textContent = run.text.slice(-400) || "等待回應…";
    this.#bar.replaceChildren(head, stop, preview);
  }
}
