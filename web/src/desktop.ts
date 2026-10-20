/**
 * 桌面版（Tauri）專用的橋接：原生對話框、資料夾工作區、檔案監看、全文搜尋、圖片存檔、AI 協作。
 * 在一般瀏覽器裡 `desktop` 為 null，其餘程式碼照常走網頁 API。
 */

interface TauriCore {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  convertFileSrc(path: string, protocol?: string): string;
}

interface TauriEvent {
  listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>;
}

declare global {
  interface Window {
    __TAURI__?: { core: TauriCore; event: TauriEvent };
  }
}

export interface DesktopFile {
  path: string;
  name: string;
  text: string;
  /** 檔案不是 UTF-8、改用 Big5 解讀時為 "big5"。 */
  encoding: "utf-8" | "big5";
}

export interface SaveRequest {
  path: string | null;
  suggestedName: string;
  text: string;
  filterName: string;
  extensions: string[];
  /** 使用者已確認要覆蓋被別的程式改過的檔案。 */
  force?: boolean;
}

export type DesktopSaveOutcome =
  | { status: "saved"; path: string; name: string }
  | { status: "conflict"; path: string; name: string; diskText: string }
  | { status: "cancelled" };

export interface Folder {
  path: string;
  name: string;
}

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface FileItem {
  path: string;
  /** 相對於工作區、以 / 分隔的路徑。 */
  rel: string;
}

export interface LineMatch {
  line: number;
  text: string;
  /** 符合範圍（UTF-16），相對於 `text`。 */
  ranges: [number, number][];
  column: number;
}

export interface SearchResult {
  files: { path: string; rel: string; matches: LineMatch[] }[];
  total: number;
  truncated: boolean;
}

export type StartupTarget = ({ kind: "file" } & DesktopFile) | ({ kind: "folder" } & Folder);

export interface Recent {
  folders: string[];
  files: string[];
}

export type AiTool = "claude" | "codex";
export type TermProgram = "shell" | AiTool;

export interface McpInfo {
  url: string;
  claudeAdd: string;
  codexAdd: string;
}

/** 給 MCP 伺服器的編輯器狀態。 */
export interface EditorSnapshot {
  active: {
    path: string | null;
    name: string;
    text: string;
    dirty: boolean;
    selection: { text: string; fromLine: number; toLine: number } | null;
  } | null;
  open: { path: string | null; name: string; dirty: boolean }[];
}

/** AI 透過 MCP 提出的修改。 */
export interface AiProposal {
  id: number;
  path: string | null;
  kind: "edits" | "selection";
  edits: { old_text: string; new_text: string }[];
  replacement: string;
  summary: string;
}

export interface AppVersion {
  version: string;
  /** CI 建置流水號；自己編譯的版本沒有。 */
  build: number | null;
  commit: string | null;
  updatable: boolean;
}

export interface UpdateManifest {
  build: number;
  version: string;
  commit: string;
  date: string;
  notes: string;
  url: string;
  sha256: string;
  size: number;
}

export interface GitChange {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
}

export interface GitStatus {
  /** 電腦上有沒有安裝 git。 */
  available: boolean;
  /** 開啟的資料夾是不是 Git 儲存庫。 */
  repo: boolean;
  branch: { name: string; upstream: string | null; ahead: number; behind: number } | null;
  changes: GitChange[];
}

export interface FileVersion {
  /** 保存時間（Unix 毫秒）。 */
  id: number;
  /** `save`：存檔的內容；`disk`：存檔前磁碟上的內容（例如被其他程式改過）。 */
  kind: "save" | "disk";
  size: number;
}

export type AiRunEvent =
  | { kind: "delta"; id: number; text: string }
  | { kind: "done"; id: number; text: string; costUsd: number | null; tokens: number | null }
  | { kind: "error"; id: number; message: string };

function bridge(core: TauriCore, event: TauriEvent) {
  return {
    startupTarget: () => core.invoke<StartupTarget | null>("startup_target"),
    openFile: () => core.invoke<DesktopFile | null>("open_file"),
    reopenFile: (path: string) => core.invoke<DesktopFile>("reopen_file", { path }),
    saveFile: (req: SaveRequest) => core.invoke<DesktopSaveOutcome>("save_file", { ...req }),
    setTitle: (title: string) => core.invoke<void>("set_title", { title }),
    /** 檔案所在的資料夾現在連得到嗎（網路磁碟斷線後偵測恢復用）。 */
    probePath: (path: string) => core.invoke<boolean>("probe_path", { path }),
    loadSettings: () => core.invoke<string | null>("load_settings"),
    saveSettings: (json: string) => core.invoke<void>("save_settings", { json }),

    openFolder: () => core.invoke<Folder | null>("open_folder"),
    reopenFolder: (path: string) => core.invoke<Folder>("reopen_folder", { path }),
    currentFolder: () => core.invoke<Folder | null>("current_folder"),
    recent: () => core.invoke<Recent>("recent"),
    listDir: (path: string) => core.invoke<Entry[]>("list_dir", { path }),
    listFiles: () => core.invoke<FileItem[]>("list_files"),
    createEntry: (parent: string, name: string, isDir: boolean) =>
      core.invoke<string>("create_entry", { parent, name, isDir }),
    renameEntry: (path: string, newName: string) => core.invoke<string>("rename_entry", { path, newName }),
    trashEntry: (path: string) => core.invoke<void>("trash_entry", { path }),
    revealEntry: (path: string) => core.invoke<void>("reveal_entry", { path }),
    search: (query: string, caseSensitive: boolean, regex: boolean) =>
      core.invoke<SearchResult>("search", { query, caseSensitive, regex }),
    saveImage: (docPath: string, dataBase64: string, ext: string) =>
      core.invoke<string>("save_image", { docPath, dataBase64, ext }),

    aiTools: () => core.invoke<{ claude: string | null; codex: string | null }>("ai_tools"),
    termOpen: (program: TermProgram, cols: number, rows: number) =>
      core.invoke<number>("term_open", { program, cols, rows }),
    termWrite: (id: number, data: string) => core.invoke<void>("term_write", { id, data }),
    termResize: (id: number, cols: number, rows: number) => core.invoke<void>("term_resize", { id, cols, rows }),
    termClose: (id: number) => core.invoke<void>("term_close", { id }),
    mcpStart: () => core.invoke<McpInfo>("mcp_start"),
    mcpStop: () => core.invoke<void>("mcp_stop"),
    mcpSync: (snapshot: EditorSnapshot) => core.invoke<void>("mcp_sync", { snapshot }),
    mcpRespond: (id: number, decision: { ok: boolean; message: string }) =>
      core.invoke<void>("mcp_respond", { id, decision }),
    aiRun: (id: number, tool: AiTool, prompt: string) => core.invoke<void>("ai_run", { id, tool, prompt }),
    aiCancel: (id: number) => core.invoke<void>("ai_cancel", { id }),

    gitStatus: () => core.invoke<GitStatus>("git_status"),
    gitCommit: (message: string) => core.invoke<string>("git_commit", { message }),
    gitPull: () => core.invoke<string>("git_pull"),
    gitPush: () => core.invoke<string>("git_push"),
    historyList: (path: string) => core.invoke<FileVersion[]>("history_list", { path }),
    historyRead: (path: string, id: number) => core.invoke<string>("history_read", { path, id }),
    appVersion: () => core.invoke<AppVersion>("app_version"),
    updateCheck: () => core.invoke<{ current: AppVersion; latest: UpdateManifest | null }>("update_check"),
    updateInstall: () => core.invoke<void>("update_install"),
    updateRestart: () => core.invoke<void>("update_restart"),
    onUpdateProgress: (fn: (p: { downloaded: number; total: number }) => void) =>
      event.listen<{ downloaded: number; total: number }>("update-progress", (e) => fn(e.payload)),

    /** 本機檔案在預覽中可以使用的網址。 */
    fileUrl: (path: string) => core.convertFileSrc(path),
    onFileChanged: (fn: (p: { path: string; text: string }) => void) =>
      event.listen<{ path: string; text: string }>("file-changed", (e) => fn(e.payload)),
    onFileRemoved: (fn: (p: { path: string }) => void) =>
      event.listen<{ path: string }>("file-removed", (e) => fn(e.payload)),
    onTreeChanged: (fn: (p: { dirs: string[] }) => void) =>
      event.listen<{ dirs: string[] }>("tree-changed", (e) => fn(e.payload)),
    onTermOutput: (fn: (p: { id: number; data: string }) => void) =>
      event.listen<{ id: number; data: string }>("term-output", (e) => fn(e.payload)),
    onTermExit: (fn: (p: { id: number; code: number | null }) => void) =>
      event.listen<{ id: number; code: number | null }>("term-exit", (e) => fn(e.payload)),
    onAiProposal: (fn: (p: AiProposal) => void) => event.listen<AiProposal>("ai-proposal", (e) => fn(e.payload)),
    onAiRun: (fn: (p: AiRunEvent) => void) => event.listen<AiRunEvent>("ai-run", (e) => fn(e.payload)),
  };
}

export type Desktop = ReturnType<typeof bridge>;

export const desktop: Desktop | null =
  typeof window !== "undefined" && window.__TAURI__ ? bridge(window.__TAURI__.core, window.__TAURI__.event) : null;
