/**
 * AI 協作與終端機（桌面版）：偵測 AI 工具、把選取的段落交給 AI。
 */
import { fileReference } from "../ai-text.ts";
import { AiController } from "../ai.ts";
import { CLAUDE_WORKFLOW } from "../ci-workflow.ts";
import { fuzzyScore } from "../commands.ts";
import { desktop, isRemote, type EditorSnapshot } from "../desktop.ts";
import { t } from "../i18n.ts";
import type { QuickAction } from "../settings.ts";
import * as storage from "../storage.ts";
import { TerminalProxy } from "../terminal-proxy.ts";
import { choose } from "../ui/choice.ts";
import { Picker } from "../ui/picker.ts";
import { toast } from "../ui/toast.ts";
import { Updater } from "../updater.ts";
import { reportError } from "./git-actions.ts";
import { gitPanel } from "./work-item-updates.ts";
import { app } from "./context.ts";


/** 已安裝的 Claude Code／Codex（找不到時是 null）。 */
export let aiFound: { claude: string | null; codex: string | null } = { claude: null, codex: null };

/**
 * 終端機只在開啟 AI 時顯示已安裝的 Claude Code／Codex 按鈕。
 * 第一次偵測到有安裝、但還沒開啟 AI 協作時，提示一次可以開啟。
 */
async function refreshAiTools(): Promise<void> {
  if (!desktop || !app.terminal) return;
  const none = { claude: null, codex: null };
  aiFound = await desktop.aiTools().catch(() => none);
  app.terminal.setAvailable(app.settings.value.aiEnabled ? aiFound : none);
  if (app.settings.value.aiEnabled || !(aiFound.claude || aiFound.codex) || storage.load("ai-hint")) return;
  storage.save("ai-hint", "shown");
  const tool = aiFound.claude ? "claude" : "codex";
  toast(
    t("偵測到 {tool}。開啟 AI 協作後，可以在下方的終端機使用它讀取、修改目前的文件。", { tool: tool === "claude" ? "Claude Code" : "Codex" }),
    { duration: 20000, action: { label: t("開啟 AI 協作"), run: () => app.settings.update({ aiEnabled: true, aiTool: tool }) } },
  );
}

/** 有沒有可以使用的終端機 AI（已開啟 AI 協作，而且有安裝 Claude Code 或 Codex）。 */
export const terminalAiReady = () => !!app.terminal && !!app.ai?.enabled && !!(aiFound.claude || aiFound.codex);

/** 把選取範圍（或整份文件）的參照 `@檔案#L行號` 貼到終端機中的 Claude Code／Codex。 */
export async function sendSelectionToAi(): Promise<void> {
  if (!app.terminal) return;
  const state = app.editor.view.state;
  const { from, to } = state.selection.main;
  let path = app.fileHandle?.path ?? null;
  // 遠端資料夾的檔案本機的 AI 讀不到，改成直接貼上文字。
  if (path && isRemote(path)) path = null;
  if (path && app.active.dirty) {
    // AI 讀的是磁碟上的檔案，先存檔行號才會對。
    await app.save(false);
    if (app.active.dirty) return;
  }
  let text: string;
  if (path) {
    const root = app.workspaceRoot && !isRemote(app.workspaceRoot.path) ? app.workspaceRoot.path : null;
    const first = state.doc.lineAt(from).number;
    // 選取範圍結束在下一行的開頭時，不算那一行。
    const end = to > from && state.doc.lineAt(to).from === to ? to - 1 : to;
    text = `${fileReference(path, root, from === to ? null : [first, state.doc.lineAt(end).number])} `;
  } else if (from !== to) {
    text = `${state.sliceDoc(from, to)}\n\n`;
  } else {
    toast(t("請先存檔，或選取要傳送的文字。"));
    return;
  }
  const preferred = app.settings.value.aiTool === "codex" ? (aiFound.codex ? "codex" : "claude") : aiFound.claude ? "claude" : "codex";
  app.terminal.sendToAi(text, preferred);
}

/** 在工作區（Git 儲存庫）加入 Claude Code 的 GitHub Actions 工作流程。 */
export async function addClaudeWorkflow(): Promise<void> {
  if (!desktop) return;
  const ok = await choose(
    t("加入 Claude Code 自動校對"),
    t("會在這個資料夾建立 .github/workflows/claude.yml。推送到 GitHub 之後：開 PR 修改文件時，Claude 會用台灣繁體中文校對並留言；在 issue 或 PR 留言寫「@claude 請幫我……」，Claude 會照著做。需要在 GitHub 設定一次權杖（建立後會說明）。"),
    [
      { id: "create", label: t("建立"), primary: true },
      { id: "cancel", label: t("取消") },
    ],
  );
  if (ok !== "create") return;
  await desktop.createWorkflow("claude.yml", CLAUDE_WORKFLOW);
  gitPanel?.refreshSoon(200);
  const next = await choose(
    t("已建立 .github/workflows/claude.yml"),
    t("接著：① 提交並推送；② 在 GitHub 儲存庫的 Settings → Secrets and variables → Actions 新增 CLAUDE_CODE_OAUTH_TOKEN（在終端機執行 claude setup-token 取得）。也可以在 Claude Code 裡執行 /install-github-app，它會自動設定。"),
    [
      ...(app.terminal && aiFound.claude ? [{ id: "token", label: t("在終端機執行 claude setup-token"), primary: true }] : []),
      { id: "done", label: t("知道了") },
    ],
  );
  if (next === "token") app.terminal?.runSetupToken();
}

/** 上次同步給 MCP 的文件內容（CodeMirror 的文件物件，內容不變時是同一個）。 */
let syncedDoc: unknown = null;

function editorSnapshot(full: boolean): EditorSnapshot {
  const { from, to } = app.editor.view.state.selection.main;
  const doc = app.editor.view.state.doc;
  // 內容沒變（例如只移動游標）：不必再把整份文件轉成字串送過去。
  const same = !full && doc === syncedDoc;
  syncedDoc = doc;
  return {
    active: {
      path: app.fileHandle?.path ?? null,
      name: app.fileName,
      text: same ? "" : doc.toString(),
      sameText: same,
      dirty: app.active.dirty,
      selection:
        from === to
          ? null
          : { text: doc.sliceString(from, to), fromLine: doc.lineAt(from).number, toLine: doc.lineAt(to).number },
    },
    open: app.docs.map((d) => ({ path: d.path, name: d.name, dirty: d.dirty })),
  };
}

export // 在 init 時建立。
let aiPicker: Picker<QuickAction & { custom?: boolean | undefined; }>;

export function initAiTerminal(): void {
  if (desktop) {
    app.terminal = new TerminalProxy(
      app.$("#terminal-panel"),
      desktop,
      () => app.editor.view.requestMeasure(),
      () => Number(app.settings.value.uiScale) / 100 || 1,
      (id) => {
        if (app.TERMINAL_KEYS.has(id)) app.commands.get(id)?.run();
      },
    );
    app.ai = new AiController(
      desktop,
      app.settings,
      {
        editor: app.editor,
        review: app.review,
        snapshot: editorSnapshot,
        async showDocument(path) {
          if (path && path !== app.fileHandle?.path) await app.openPath(path);
        },
      },
      app.$("#ai-bar"),
    );
    void refreshAiTools();
    app.$("[data-command='toggle-terminal']").hidden = false;
    app.updater = new Updater(desktop, app.settings, app.$("#status-update"), () => {
      app.flushDraft();
      app.persistSession();
    });
    app.settings.subscribe((_, changed) => {
      if (changed.includes("aiEnabled")) void refreshAiTools();
    });
  }
  aiPicker = new Picker<QuickAction & { custom?: boolean }>({
    label: t("AI 快捷動作"),
    placeholder: t("選擇動作，或直接輸入要 AI 怎麼處理選取的文字"),
    empty: t("沒有符合的動作；按 Enter 會把輸入的文字當成指示"),
    query(q) {
      const actions = app.settings.value.quickActions
        .map((a) => ({ a, score: fuzzyScore(q, a.name) }))
        .filter((x) => x.score > 0)
        .sort((x, y) => y.score - x.score)
        .map((x) => x.a);
      const text = q.trim();
      return text && !actions.some((a) => a.name === text)
        ? [...actions, { name: t("自訂：{text}", { text }), prompt: text, custom: true }]
        : actions;
    },
    render: (a) => ({ title: a.name, detail: a.custom ? t("自訂指示") : undefined, icon: "sparkles" }),
    pick: (a) => void app.ai?.runAction(a).catch(reportError),
  });
}
