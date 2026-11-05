/**
 * 終端機 webview 的進入點（桌面版，`terminal.html`）。
 *
 * 這個頁面只顯示終端機，不顯示任何文件內容；只有這裡能呼叫 `term_*` 指令。
 * 原生端送來的資料（輸出、AI 要執行的指令、主畫面的要求）只經過這個頁面交給 `term_ready` 的通道（Channel），
 * 不走 Tauri 的全域事件：主畫面收不到，也不能假冒。主畫面的要求（顯示、開新分頁、貼到 AI 的輸入列等）
 * 經過 Rust 檢查後以 `term-request` 送來。
 */
// 主題的 color-scheme（data-theme）寫在 document.css，和主畫面一樣先載入。
import "../../crates/md-core/src/document.css";
import "./styles.css";
import "./palettes.css";
import { currentLang, loadLocale, t } from "./i18n.ts";
import { DEFAULT_PALETTE, applyPalette, isPalette, parseAccent } from "./palette.ts";
import type { MenuEntry } from "./ui/menu.ts";
import type { AiCommand } from "./ui/command-consent.ts";
import type { TerminalPanel, TermProgram } from "./ui/terminal-panel.ts";

type Request =
  | { kind: "show" }
  | { kind: "start"; program: TermProgram }
  | { kind: "sendToAi"; text: string; preferred: TermProgram }
  | { kind: "setupToken" }
  | { kind: "cometSetup" }
  | { kind: "available"; claude: boolean; codex: boolean }
  | { kind: "style"; theme: string | null; fontSize: number; palette?: string | null; accent?: string | null }
  | { kind: "focus" };

type Notice = { kind: "show" } | { kind: "hide" } | { kind: "command"; id: string } | { kind: "focus" };

/** 原生端從通道送來的一則訊息（Rust 的 `view::Message`）。 */
interface TermMessage {
  event: string;
  payload: unknown;
}

const tauri = window.__TAURI__;
if (!tauri) throw new Error("terminal.html only runs in the desktop app");
const { core } = tauri;
const notify = (notice: Notice) => void core.invoke("term_notify", { notice }).catch(() => {});

void start();

async function start(): Promise<void> {
  // 先載入介面語言：面板的文字（分頁名稱等）在載入模組時就會用到。
  await loadLocale();
  const [{ TerminalPanel }, { setupMenu }, { CommandConsent }] = await Promise.all([
    import("./ui/terminal-panel.ts"),
    import("./ui/menu.ts"),
    import("./ui/command-consent.ts"),
  ]);

  /** 在指定位置開一個選單（右鍵選單）。 */
  const openMenu = (at: DOMRect, entries: MenuEntry[], closed: () => void): void => {
    for (const id of ["term-menu-anchor", "term-menu-anchor-popover"]) document.getElementById(id)?.remove();
    const anchor = document.createElement("button");
    anchor.type = "button";
    anchor.id = "term-menu-anchor";
    anchor.className = "insert-anchor";
    anchor.tabIndex = -1;
    document.body.append(anchor);
    const menu = setupMenu(anchor, null, entries);
    menu.addEventListener("toggle", (e) => {
      if ((e as ToggleEvent).newState === "closed") closed();
    });
    Object.assign(anchor.style, { left: `${at.left}px`, top: `${at.top}px`, width: `${at.width}px`, height: `${at.height}px` });
    anchor.click();
  };

  const el = document.getElementById("terminal-panel")!;
  el.setAttribute("aria-label", t("終端機"));
  document.documentElement.lang = currentLang() === "en" ? "en" : "zh-Hant-TW";
  const panel = new TerminalPanel(
    el,
    {
      termOpen: (program, cols, rows) => core.invoke<number>("term_open", { program, cols, rows }),
      termWrite: (id, data) => core.invoke<void>("term_write", { id, data }),
      termResize: (id, cols, rows) => core.invoke<void>("term_resize", { id, cols, rows }),
      termClose: (id) => core.invoke<void>("term_close", { id }),
      openExternal: (url) => core.invoke<void>("open_external", { url }),
    },
    {
      requestShow: () => notify({ kind: "show" }),
      requestHide: () => notify({ kind: "hide" }),
      focusView: () => notify({ kind: "focus" }),
      openMenu,
    },
  );

  // AI 要求執行指令時的同意提示：只在這個 webview 顯示，回覆也只接受這裡送出的。
  const consent = new CommandConsent(
    el,
    (id, ok, message, always) => core.invoke<boolean>("mcp_respond", { id, decision: { ok, message, always } }),
    () => notify({ kind: "focus" }),
  );

  const handle = ({ event: name, payload }: TermMessage): void => {
    if (name === "term-output") panel.output(payload as { id: number; data: string });
    else if (name === "term-attached") panel.attached(payload as { id: number; label: string });
    else if (name === "term-exit") panel.exited(payload as { id: number; code: number | null });
    else if (name === "term-request") request(panel, payload as Request);
    else if (name === "ai-command") void consent.ask(payload as AiCommand);
    else if (name === "ai-command-expired") consent.expired(payload as number);
  };
  // 原生端先補送排隊中的訊息，再依序送之後的；輸出比分頁先到時由面板先暫存，分頁建立後再補上。
  const channel = new core.Channel<TermMessage>();
  channel.onmessage = handle;
  await core.invoke("term_ready", { channel });
}

function request(panel: TerminalPanel, r: Request): void {
  switch (r.kind) {
    case "show":
      void panel.show();
      break;
    case "start":
      void panel.start(r.program);
      break;
    case "sendToAi":
      void panel.sendToAi(r.text, r.preferred);
      break;
    case "setupToken":
      void panel.runInShell("claude setup-token");
      break;
    case "cometSetup":
      // `comet` 還不在 PATH 裡（第一次執行 comet setup 才會加）時，原生端回傳固定安裝位置的完整路徑。
      void core
        .invoke<string>("comet_setup_line")
        .catch(() => "comet setup")
        .then((line) => panel.runInShell(line));
      break;
    case "available":
      panel.setAvailable({ claude: r.claude ? "claude" : null, codex: r.codex ? "codex" : null });
      break;
    case "style": {
      const root = document.documentElement;
      if (r.theme) root.dataset.theme = r.theme;
      else delete root.dataset.theme;
      applyPalette(root, isPalette(r.palette) ? r.palette : DEFAULT_PALETTE, parseAccent(r.accent));
      root.style.setProperty("--editor-font-size", `${r.fontSize}px`);
      panel.applyTheme();
      panel.applyFont();
      break;
    }
    case "focus":
      panel.focus();
      break;
  }
}

// 終端機裡只保留兩個全域快速鍵，交給主畫面處理；其他按鍵都給終端機。
window.addEventListener(
  "keydown",
  (e) => {
    if (e.isComposing || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    let id: string | null = null;
    if (e.code === "Backquote" && !e.shiftKey) id = "toggle-terminal";
    else if (e.shiftKey && e.key.toLowerCase() === "p") id = "palette";
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    notify({ kind: "command", id });
  },
  true,
);
