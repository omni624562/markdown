/**
 * 桌面版（Tauri）專用的橋接：原生對話框、資料夾工作區、檔案監看、全文搜尋、圖片存檔、AI 協作。
 * 在一般瀏覽器裡 `desktop` 為 null，其餘程式碼照常走網頁 API。
 */
import type { DocInfo } from "./doc-index.ts";
import { t } from "./i18n.ts";

interface TauriCore {
  /** `args` 是位元組時當成請求本文直接傳送（大檔案不用轉成 base64），其他資料放在標頭。 */
  invoke<T>(cmd: string, args?: Record<string, unknown> | Uint8Array, options?: { headers: Record<string, string> }): Promise<T>;
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

/** 下載儲存庫的結果。 */
export interface Cloned extends Folder {
  /** 之前已經下載到這個位置，這次只是開啟。 */
  existing: boolean;
}

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  /** 滑鼠停留時顯示的資訊（遠端檔案的大小、權限、修改時間）。 */
  detail?: string;
}

/** 匯入 Word：選到的檔案與要轉存的 Markdown 檔位置。 */
export interface DocxImport {
  name: string;
  mdPath: string;
  /** Word 檔的內容（原始位元組，不經過 base64）。 */
  data: ArrayBuffer;
}

/** 資料夾中一份 Markdown 文件的內容（`text` 省略代表和上次讀到的一樣）。 */
export interface DocText {
  path: string;
  rel: string;
  mtime: number;
  /** 解析結果；和上次讀到的修改時間一樣時省略。 */
  info?: DocInfo | null;
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

/** 專案：開過的資料夾，加上自訂名稱、顏色、群組與釘選。 */
export interface Project {
  path: string;
  /** 顯示用的名稱：自訂名稱，沒有就是資料夾名稱。 */
  label: string;
  name: string | null;
  color: string | null;
  group: string | null;
  pinned: boolean;
  /** 上次開啟的時間（Unix 毫秒）；0 代表不知道。 */
  lastOpened: number;
}

export interface ProjectChange {
  name: string | null;
  color: string | null;
  group: string | null;
  pinned: boolean;
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
    /** 內容和上次同步時相同（`text` 是空的，原生端沿用上次的內容）。 */
    sameText?: boolean;
    dirty: boolean;
    selection: { text: string; fromLine: number; toLine: number } | null;
  } | null;
  open: { path: string | null; name: string; dirty: boolean }[];
}

/** AI 透過 MCP 提出的修改。 */
export interface ReplaceResult {
  files: number;
  replacements: number;
  skipped: string[];
  failed: string[];
}

/** AI 要求在終端機執行的指令，等使用者同意。 */
export interface AiCommand {
  id: number;
  command: string;
  reason: string;
  cwd: string;
}

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
  /** 建置日期（CI 建置時才有）。 */
  date?: string | null;
  updatable: boolean;
}

export interface UpdateManifest {
  build: number;
  version: string;
  commit: string;
  date: string;
  notes: string;
  /** CHANGELOG.md 中這一版的完整說明（Markdown；舊的更新資訊沒有）。 */
  changes?: string;
  url: string;
  sha256: string;
  size: number;
}

export interface GitChange {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
}

export interface GitStatus {
  /** 內建 Git，一律可以使用。 */
  available: boolean;
  /** 開啟的資料夾是不是 Git 儲存庫。 */
  repo: boolean;
  /** 內建 Git 不執行外部程式，一律為 true（保留給舊介面）。 */
  trusted: boolean;
  branch: { name: string; upstream: string | null; ahead: number; behind: number } | null;
  changes: GitChange[];
  /** 遠端（origin）的網址。 */
  remote: string | null;
  /** 正在逐段處理合併衝突（還沒按「完成合併」）。 */
  merging: boolean;
}

export interface GitBranches {
  current: string | null;
  local: string[];
  /** 只在遠端上、本機還沒有的分支。 */
  remote: string[];
}

/** 合併衝突的檔案：磁碟上是「都採用本機」的內容，`theirs` 是「都採用遠端」的內容。 */
export interface GitConflict {
  path: string;
  theirs: string | null;
  /** 不能逐段處理時的說明（例如一邊刪除了檔案）。 */
  note: string | null;
}

export interface GitHubAccount {
  login: string;
  id: number;
  name: string | null;
}

/** 裝置碼登入：在 GitHub 網頁輸入 `userCode`。 */
export interface GitHubDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export interface GitHubRepo {
  fullName: string;
  name: string;
  private: boolean;
  description: string | null;
  updatedAt: string | null;
  cloneUrl: string;
}

/** Azure DevOps 的連線（雲端版或公司自架的 Azure DevOps Server）。 */
export interface AdoAccount {
  /** 集合或組織的網址。 */
  url: string;
  /** 登入者的顯示名稱。 */
  name: string;
  account?: string | null;
}

export interface AdoRepo {
  name: string;
  project: string;
  cloneUrl: string;
  webUrl: string | null;
  /** 專案 Wiki。 */
  wiki: boolean;
}

export interface AdoWorkItem {
  id: number;
  title: string;
  state: string;
  /** 類型，例如 Bug、Task、User Story。 */
  kind: string;
  project: string;
  assignedTo: string | null;
  changed: string | null;
  webUrl: string;
}

export interface AdoWorkItemDetail extends AdoWorkItem {
  createdBy: string | null;
  /** 區域、反覆項目（例如「產品\\前端」）。 */
  area: string | null;
  iteration: string | null;
  priority: number | null;
  tags: string[];
  /** 說明（HTML）。 */
  description: string | null;
  /** 驗收條件或重現步驟（HTML）。 */
  details: string | null;
  /** 留言（舊到新，內容是 HTML）。 */
  comments: { author: string; created: string | null; text: string }[];
}

/** 工作項目清單的篩選條件。 */
export interface AdoWorkItemFilter {
  /** 依指派給誰或建立者篩選人。 */
  role: "assigned" | "created";
  /** `@me`（我）、空字串（不限）或名字（部分符合即可）。 */
  person: string;
  state: "open" | "closed" | "all";
  kind: string | null;
  project: string | null;
  /** 區域路徑（包含底下的區域）。 */
  area: string | null;
}

/** 改過某個檔案的提交。 */
export interface FileCommit {
  id: string;
  short: string;
  summary: string;
  author: string;
  /** Unix 秒。 */
  time: number;
}

export interface GitRef {
  name: string;
  /** head：目前所在的分支。 */
  kind: "head" | "branch" | "remote" | "tag";
}

export interface LogCommit {
  id: string;
  parents: string[];
  summary: string;
  author: string;
  email: string;
  /** Unix 秒。 */
  time: number;
  refs: GitRef[];
  /** 只在本機、還沒推送。 */
  unpushed: boolean;
  /** 遠端有、本機還沒拉取。 */
  unpulled: boolean;
}

export interface LogPage {
  commits: LogCommit[];
  more: boolean;
  head: string | null;
}

export interface ChangedFile {
  /** 儲存庫裡的相對路徑（用 / 分隔）。 */
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface ChangeList {
  files: ChangedFile[];
  truncated: boolean;
}

export interface CommitDetail {
  id: string;
  parents: string[];
  message: string;
  author: string;
  email: string;
  time: number;
  committer: string;
  commitTime: number;
  changes: ChangeList;
}

export interface FilePair {
  before: string | null;
  after: string | null;
  note: string | null;
}

/** 會改變目前位置的操作：`before`／`after` 用來「復原」。 */
export interface GitOpResult {
  message: string;
  before: string | null;
  after: string | null;
}

export interface MergeOutcome {
  message: string;
  before: string | null;
  conflicts: GitConflict[];
}

export interface StatCommit {
  author: string;
  time: number;
  /** 時區（分鐘）。 */
  offset: number;
}

export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  labels: string[];
  author: string;
  comments: number;
  updated: string | null;
  webUrl: string;
}

export interface GitHubIssueDetail extends GitHubIssue {
  assignees: string[];
  /** 內容（Markdown）。 */
  body: string;
  commentList: { author: string; created: string | null; body: string }[];
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

/** 遠端檔案的路徑開頭：WebDAV 是 `webdav://<連線代號>/路徑`，SSH 是 `ssh://<連線代號>/路徑`。 */
const REMOTE_SCHEMES = ["webdav://", "ssh://"] as const;

export function isRemote(path: string | null | undefined): path is string {
  return !!path && REMOTE_SCHEMES.some((s) => path.startsWith(s));
}

/** 遠端路徑的連線代號（不是遠端路徑時回傳 null）。 */
export function remoteId(path: string | null | undefined): string | null {
  if (!isRemote(path)) return null;
  return path.slice(path.indexOf("://") + 3).split("/")[0] || null;
}

/** 連線的根目錄路徑（`webdav://代號` 或 `ssh://代號`）。 */
export function remoteRoot(c: Pick<DavConnection, "id" | "kind">): string {
  return `${c.kind === "ssh" ? "ssh" : "webdav"}://${c.id}`;
}

const davUrls = new Map<string, string>();

/** 給人看的路徑：遠端檔案換成「伺服器網址/路徑」，不顯示內部的連線代號。 */
export function displayPath(path: string): string {
  const id = remoteId(path);
  if (!id) return path;
  const base = davUrls.get(id);
  if (!base) return path;
  const rest = path.slice(path.indexOf("://") + 3).split("/").slice(1);
  return [base.replace(/\/+$/, ""), ...rest].join("/");
}

/** 已儲存的遠端連線（WebDAV 或 SSH；密碼不會傳到前端）。 */
export interface DavConnection {
  id: string;
  kind: "webdav" | "ssh";
  name: string;
  url: string;
  username: string;
  hasPassword: boolean;
}

/** 連線到 SSH 主機的設定。 */
export interface SshConnectRequest {
  host: string;
  port: number | null;
  username: string;
  /** 密碼或金鑰的密語；空白就只用金鑰登入。 */
  password: string;
  keyPath: string;
  /** 跳板主機（`帳號@主機:連接埠`），不需要時是空字串。 */
  jump: string;
  root: string;
  remember: boolean;
  /** 使用者確認過的主機金鑰指紋。 */
  trust?: string;
}

/** 最近一次儲存設定（AI 相關的指令要等它完成）。 */
let settingsSaved: Promise<unknown> = Promise.resolve();
const afterSettings = <T>(run: () => Promise<T>): Promise<T> => settingsSaved.catch(() => {}).then(run);

function bridge(core: TauriCore, event: TauriEvent) {
  // 遠端（WebDAV、SSH）路徑改用 dav_* 指令；其他照舊。
  const route = <T>(path: string | null | undefined, local: () => Promise<T>, remote: () => Promise<T>) =>
    isRemote(path) ? remote() : local();
  const davConnections = () =>
    core.invoke<DavConnection[]>("dav_connections").then((list) => {
      for (const c of list) {
        let url = c.url;
        try {
          url = decodeURI(url);
        } catch {
          // 保留原樣
        }
        davUrls.set(c.id, url);
      }
      return list;
    });
  /** 遠端資料夾不支援的功能：`message` 是完整的說明。 */
  const unsupported = (message: string) => Promise.reject(new Error(message));
  return {
    startupTarget: () => core.invoke<StartupTarget | null>("startup_target"),
    openFile: () => core.invoke<DesktopFile | null>("open_file"),
    reopenFile: (path: string) =>
      route(
        path,
        () => core.invoke<DesktopFile>("reopen_file", { path }),
        () => core.invoke<DesktopFile>("dav_read", { path }),
      ),
    saveFile: (req: SaveRequest) =>
      route(
        req.path,
        () => core.invoke<DesktopSaveOutcome>("save_file", { ...req }),
        () => core.invoke<DesktopSaveOutcome>("dav_write", { path: req.path, text: req.text, force: req.force ?? false }),
      ),
    setTitle: (title: string) => core.invoke<void>("set_title", { title }),
    /** Windows 版用網頁的頂端列當標題列。 */
    customTitleBar: () => core.invoke<boolean>("custom_title_bar"),
    windowControl: (action: "minimize" | "toggle-maximize" | "close" | "drag" | "state") =>
      core.invoke<boolean>("window_control", { action }),
    /** 檔案所在的資料夾現在連得到嗎（網路磁碟斷線後偵測恢復用）。 */
    probePath: (path: string) =>
      route(
        path,
        () => core.invoke<boolean>("probe_path", { path }),
        () => core.invoke<boolean>("dav_probe", { path }),
      ),
    loadSettings: () => core.invoke<string | null>("load_settings"),
    /**
     * 儲存設定。從關閉改成「啟用 AI 協作」時原生端會再確認一次；使用者拒絕時回傳 false。
     * 需要 AI 的指令會等最近一次存檔完成（原生端以設定檔為準）。
     */
    saveSettings: (json: string) => (settingsSaved = core.invoke<boolean>("save_settings", { json })),

    openFolder: () => core.invoke<Folder | null>("open_folder"),
    /**
     * 遠端資料夾可以帶剛輸入的密碼，`remember` 決定要不要存進系統的認證管理員；
     * `trust` 是使用者確認過的 SSH 主機金鑰指紋。
     */
    /** 關閉目前的專案（本機或遠端資料夾）。 */
    closeFolder: () => core.invoke<void>("close_folder"),
    reopenFolder: (path: string, password?: string, remember?: boolean, trust?: string) =>
      route(
        path,
        () => core.invoke<Folder>("reopen_folder", { path }),
        () =>
          core.invoke<Folder>("dav_reconnect", {
            id: remoteId(path),
            password,
            remember: remember ?? false,
            trust,
          }),
      ),
    currentFolder: () => core.invoke<Folder | null>("current_folder"),
    recent: () => core.invoke<Recent>("recent"),
    /** 後端回給使用者的訊息用哪個語言。 */
    setLanguage: (lang: string) => core.invoke<void>("set_language", { lang }),
    projects: () => core.invoke<Project[]>("projects_list"),
    projectUpdate: (path: string, change: ProjectChange) => core.invoke<Project>("project_update", { path, change }),
    projectForget: (path: string) => core.invoke<void>("project_forget", { path }),
    /** 重新指定搬走的專案資料夾；取消時回傳 null。 */
    projectRelocate: (path: string) => core.invoke<Project | null>("project_relocate", { path }),
    projectReveal: (path: string) => core.invoke<void>("project_reveal", { path }),
    listDir: (path: string) =>
      route(
        path,
        () => core.invoke<Entry[]>("list_dir", { path }),
        () => core.invoke<Entry[]>("dav_list", { path }),
      ),
    /** 工作區內所有文件；`root` 是目前開啟的資料夾。 */
    listFiles: (root: string) =>
      route(
        root,
        () => core.invoke<FileItem[]>("list_files"),
        () => core.invoke<FileItem[]>("dav_list_files"),
      ),
    createEntry: (parent: string, name: string, isDir: boolean) =>
      route(
        parent,
        () => core.invoke<string>("create_entry", { parent, name, isDir }),
        () => core.invoke<string>("dav_create", { parent, name, isDir }),
      ),
    renameEntry: (path: string, newName: string) =>
      route(
        path,
        () => core.invoke<string>("rename_entry", { path, newName }),
        () => core.invoke<string>("dav_rename", { path, newName }),
      ),
    /** 從電腦上傳檔案到遠端資料夾；同名時自動加上編號，回傳上傳後的路徑。 */
    davUpload: (dir: string, name: string, data: ArrayBuffer) =>
      core.invoke<string>("dav_upload", new Uint8Array(data), {
        headers: { "x-dir": encodeURIComponent(dir), "x-name": encodeURIComponent(name) },
      }),
    /** 把遠端檔案下載到電腦（選存放位置）；取消時回傳 null。 */
    davDownload: (path: string) => core.invoke<string | null>("dav_download", { path }),
    /** 本機移到資源回收筒；遠端資料夾沒有資源回收筒，會直接刪除。 */
    trashEntry: (path: string) =>
      route(
        path,
        () => core.invoke<void>("trash_entry", { path }),
        () => core.invoke<void>("dav_delete", { path }),
      ),
    revealEntry: (path: string) =>
      route(path, () => core.invoke<void>("reveal_entry", { path }), () => unsupported(t("遠端資料夾不支援在檔案總管中顯示"))),
    /** 選擇 PDF 的存檔位置；取消時回傳 null。 */
    pickPdfPath: (suggestedName: string) => core.invoke<string | null>("pick_pdf_path", { suggestedName }),
    /** 把主視窗目前的內容（列印樣式）直接存成 PDF。 */
    printToPdf: (
      path: string,
      layout: { widthMm: number; heightMm: number; marginTopMm: number; marginBottomMm: number; marginSideMm: number },
    ) => core.invoke<void>("print_to_pdf", { path, layout }),
    /** 選擇 Word 檔並讀取；取消時回傳 null。 */
    importDocx: async (): Promise<DocxImport | null> => {
      const picked = await core.invoke<Omit<DocxImport, "data"> | null>("import_docx");
      if (!picked) return null;
      return { ...picked, data: await core.invoke<ArrayBuffer>("import_docx_data") };
    },
    /** 讀取資料夾中的 Markdown 文件（`known` 是上次讀到的修改時間，沒變的不重讀）。 */
    scanDocs: (known: Record<string, number>, root: string) =>
      route(
        root,
        () => core.invoke<DocText[]>("scan_docs", { known }),
        () => unsupported(t("遠端資料夾不支援待辦總覽、標籤與反向連結")),
      ),
    /** 讀取資料夾中幾份文件的內容；讀不到的是 null。 */
    readDocs: (paths: string[]) => core.invoke<(string | null)[]>("read_docs", { paths }),
    /** 改寫一份沒有開啟的文件；磁碟上的內容和 `expected` 不同時拒絕。 */
    updateDoc: (path: string, expected: string, text: string) =>
      route(
        path,
        () => core.invoke<void>("update_doc", { path, expected, text }),
        () => unsupported(t("遠端資料夾不支援直接修改沒有開啟的檔案")),
      ),
    /** 資料夾全文取代；`skip` 是有未存檔變更的已開啟檔案。 */
    replaceInFolder: (query: string, replacement: string, caseSensitive: boolean, regex: boolean, skip: string[], root: string) =>
      route(
        root,
        () => core.invoke<ReplaceResult>("replace_in_folder", { query, replacement, caseSensitive, regex, skip }),
        () => unsupported(t("遠端資料夾不支援全文取代")),
      ),
    search: (query: string, caseSensitive: boolean, regex: boolean, root: string) =>
      route(
        root,
        () => core.invoke<SearchResult>("search", { query, caseSensitive, regex }),
        () => unsupported(t("遠端資料夾不支援全文搜尋")),
      ),
    saveImage: (docPath: string, dataBase64: string, ext: string) =>
      route(
        docPath,
        () => core.invoke<string>("save_image", { docPath, dataBase64, ext }),
        () => core.invoke<string>("dav_save_image", { docPath, dataBase64, ext }),
      ),
    /** 讀取工作區內另一份文件的內容（自動完成標題用，不影響存檔衝突判斷）。 */
    peekText: (path: string) =>
      route(
        path,
        () => core.invoke<string>("peek_text", { path }),
        () => core.invoke<string>("dav_peek", { path }),
      ),
    /** 在預設瀏覽器開啟外部連結（http、https、mailto）。 */
    openExternal: (url: string) => core.invoke<void>("open_external", { url }),
    davConnections,
    davConnect: (url: string, username: string, password: string, remember: boolean, allowHttp: boolean) =>
      core
        .invoke<Folder>("dav_connect", { url, username, password, remember, allowHttp })
        .then(async (f) => (await davConnections().catch(() => []), f)),
    sshConnect: (req: SshConnectRequest) =>
      core
        .invoke<Folder>("ssh_connect", { ...req, keyPath: req.keyPath || null, password: req.password || null, jump: req.jump || null })
        .then(async (f) => (await davConnections().catch(() => []), f)),
    davForget: (id: string) => core.invoke<void>("dav_forget", { id }),
    /** 遠端圖片（預覽用），回傳 data: 網址。 */
    davImage: (path: string) => core.invoke<string>("dav_image", { path }),

    aiTools: () => core.invoke<{ claude: string | null; codex: string | null }>("ai_tools"),
    listFonts: () => core.invoke<{ name: string; label?: string; mono: boolean }[]>("list_fonts"),
    termOpen: (program: TermProgram, cols: number, rows: number) =>
      afterSettings(() => core.invoke<number>("term_open", { program, cols, rows })),
    termWrite: (id: number, data: string) => core.invoke<void>("term_write", { id, data }),
    termResize: (id: number, cols: number, rows: number) => core.invoke<void>("term_resize", { id, cols, rows }),
    termClose: (id: number) => core.invoke<void>("term_close", { id }),
    mcpStart: () => afterSettings(() => core.invoke<McpInfo>("mcp_start")),
    mcpStop: () => core.invoke<void>("mcp_stop"),
    mcpSync: (snapshot: EditorSnapshot) => core.invoke<void>("mcp_sync", { snapshot }),
    /** 回傳 false 表示 AI 已經不在等這個決定（逾時）。 */
    mcpRespond: (id: number, decision: { ok: boolean; message: string }) =>
      core.invoke<boolean>("mcp_respond", { id, decision }),
    /** 匯出二進位檔（例如 .docx）：顯示另存對話框後寫入，取消時回傳 null。 */
    exportBinary: (suggestedName: string, dataBase64: string, filterName: string, extensions: string[]) =>
      core.invoke<string | null>("export_binary", { suggestedName, dataBase64, filterName, extensions }),
    /** 在工作區的 .github/workflows/ 建立工作流程檔（不覆蓋）。 */
    createWorkflow: (name: string, text: string) => core.invoke<string>("create_workflow", { name, text }),
    aiRun: (id: number, tool: AiTool, prompt: string) =>
      afterSettings(() => core.invoke<void>("ai_run", { id, tool, prompt })),
    aiCancel: (id: number) => core.invoke<void>("ai_cancel", { id }),

    gitStatus: () => core.invoke<GitStatus>("git_status"),
    githubAccount: () => core.invoke<GitHubAccount | null>("github_account"),
    githubLoginStart: () => core.invoke<GitHubDeviceCode>("github_login_start"),
    githubLoginWait: (c: GitHubDeviceCode) =>
      core.invoke<GitHubAccount>("github_login_wait", { deviceCode: c.deviceCode, interval: c.interval, expiresIn: c.expiresIn }),
    githubLoginCancel: () => core.invoke<void>("github_login_cancel"),
    githubLogout: () => core.invoke<void>("github_logout"),
    githubRepos: () => core.invoke<GitHubRepo[]>("github_repos"),
    /** 選擇放在哪個資料夾後下載並開啟；取消時回傳 null。 */
    /** 下載儲存庫並開啟；選的位置已經是同一個儲存庫時直接開啟（`existing`）。取消時回傳 null。 */
    githubClone: (fullName: string) => core.invoke<Cloned | null>("github_clone", { fullName }),
    /** 把開啟的資料夾上傳成新的儲存庫，回傳儲存庫網址。 */
    githubPublish: (name: string, isPrivate: boolean) => core.invoke<string>("github_publish", { name, private: isPrivate }),
    gitFileHistory: (path: string) => core.invoke<FileCommit[]>("git_file_history", { path }),
    gitFileAt: (path: string, id: string) => core.invoke<string>("git_file_at", { path, id }),
    gitWebUrl: (path: string, from?: number, to?: number) => core.invoke<string>("git_web_url", { path, from, to }),
    githubIssues: (search: string) => core.invoke<GitHubIssue[]>("github_issues", { search }),
    githubIssue: (number: number) => core.invoke<GitHubIssueDetail>("github_issue", { number }),
    githubWorkspaceRepo: () => core.invoke<string | null>("github_workspace_repo"),
    gitLog: (skip: number, limit: number, all: boolean, path: string | null, text: string | null) =>
      core.invoke<LogPage>("git_log", { skip, limit, all, path, text }),
    gitCommitDetail: (id: string) => core.invoke<CommitDetail>("git_commit_detail", { id }),
    gitCompare: (from: string, to: string) => core.invoke<ChangeList>("git_compare", { from, to }),
    gitWorktreeChanges: () => core.invoke<ChangeList>("git_worktree_changes"),
    /** `to` 是 null 時是工作目錄裡的檔案；`from` 是 null 時是 `to` 的上一個提交。 */
    gitFilePair: (from: string | null, to: string | null, path: string, oldPath: string | null) =>
      core.invoke<FilePair>("git_file_pair", { from, to, path, oldPath }),
    gitAbsPath: (path: string) => core.invoke<string>("git_abs_path", { path }),
    gitStats: () => core.invoke<StatCommit[]>("git_stats"),
    gitBranchAt: (id: string, name: string, checkout: boolean) => core.invoke<GitOpResult>("git_branch_at", { id, name, checkout }),
    gitDeleteBranch: (name: string) => core.invoke<string>("git_delete_branch", { name }),
    gitTag: (id: string, name: string, message: string) => core.invoke<string>("git_tag", { id, name, message }),
    gitDeleteTag: (name: string) => core.invoke<string>("git_delete_tag", { name }),
    gitMergeBranch: (name: string) => core.invoke<MergeOutcome>("git_merge_branch", { name }),
    gitRevert: (id: string) => core.invoke<GitOpResult>("git_revert", { id }),
    gitCherryPick: (id: string) => core.invoke<GitOpResult>("git_cherry_pick", { id }),
    gitReset: (id: string) => core.invoke<GitOpResult>("git_reset", { id }),
    gitAmendMessage: (message: string) => core.invoke<GitOpResult>("git_amend_message", { message }),
    gitUndo: (to: string, expect: string, keepFiles: boolean) => core.invoke<string>("git_undo", { to, expect, keepFiles }),
    gitBranches: () => core.invoke<GitBranches>("git_branches"),
    gitCheckout: (name: string) => core.invoke<string>("git_checkout", { name }),
    gitCreateBranch: (name: string) => core.invoke<string>("git_create_branch", { name }),
    gitMergeStart: () => core.invoke<GitConflict[]>("git_merge_start"),
    gitMergeConflicts: () => core.invoke<string[]>("git_merge_conflicts"),
    gitMergeFinish: () => core.invoke<string>("git_merge_finish"),
    gitMergeAbort: () => core.invoke<string>("git_merge_abort"),
    gitCreatePr: (title: string, body: string, newBranch: string | null) =>
      core.invoke<string>("git_create_pr", { title, body, newBranch }),
    githubPages: () => core.invoke<string>("github_pages"),
    githubGist: (fileName: string, content: string, description: string, isPublic: boolean) =>
      core.invoke<string>("github_gist", { fileName, content, description, public: isPublic }),
    adoAccount: () => core.invoke<AdoAccount | null>("ado_account"),
    adoConnect: (url: string, pat: string) => core.invoke<AdoAccount>("ado_connect", { url, pat }),
    adoDisconnect: () => core.invoke<void>("ado_disconnect"),
    adoRepos: () => core.invoke<AdoRepo[]>("ado_repos"),
    adoClone: (cloneUrl: string, name: string) => core.invoke<Cloned | null>("ado_clone", { cloneUrl, name }),
    adoWorkItems: (search: string, filter?: AdoWorkItemFilter) => core.invoke<AdoWorkItem[]>("ado_work_items", { search, filter }),
    adoWorkItemFilters: () => core.invoke<{ projects: string[]; kinds: string[] }>("ado_work_item_filters"),
    adoWorkItemScope: (project: string | null) =>
      core.invoke<{ areas: string[]; people: string[] }>("ado_work_item_scope", { project }),
    /** 工作項目內文裡的圖片（要用權杖讀），回傳 data: 網址。 */
    adoImage: (url: string) => core.invoke<string>("ado_image", { url }),
    adoWorkItem: (id: number) => core.invoke<AdoWorkItemDetail>("ado_work_item", { id }),
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

    /** 本機圖片在預覽中可以使用的網址（原生端的 mdimg 協定，只提供工作區與已開啟檔案資料夾內的圖片）。 */
    fileUrl: (path: string) => core.convertFileSrc(path, "mdimg"),
    onFileChanged: (fn: (p: { path: string; text: string }) => void) =>
      event.listen<{ path: string; text: string }>("file-changed", (e) => fn(e.payload)),
    /** 又開了一次 exe（例如在檔案總管雙擊另一個檔案）：在原本的視窗開啟。 */
    onOpenTarget: (fn: (t: StartupTarget) => void) => event.listen<StartupTarget>("open-target", (e) => fn(e.payload)),
    onOpenTargetFailed: (fn: (message: string) => void) =>
      event.listen<string>("open-target-failed", (e) => fn(e.payload)),
    onFileRemoved: (fn: (p: { path: string }) => void) =>
      event.listen<{ path: string }>("file-removed", (e) => fn(e.payload)),
    onTreeChanged: (fn: (p: { dirs: string[] }) => void) =>
      event.listen<{ dirs: string[] }>("tree-changed", (e) => fn(e.payload)),
    onTermOutput: (fn: (p: { id: number; data: string }) => void) =>
      event.listen<{ id: number; data: string }>("term-output", (e) => fn(e.payload)),
    onTermExit: (fn: (p: { id: number; code: number | null }) => void) =>
      event.listen<{ id: number; code: number | null }>("term-exit", (e) => fn(e.payload)),
    onAiProposal: (fn: (p: AiProposal) => void) => event.listen<AiProposal>("ai-proposal", (e) => fn(e.payload)),
    onAiCommand: (fn: (c: AiCommand) => void) => event.listen<AiCommand>("ai-command", (e) => fn(e.payload)),
    onAiCommandExpired: (fn: (id: number) => void) => event.listen<number>("ai-command-expired", (e) => fn(e.payload)),
    /** AI 執行的指令開了一個新的終端機（由 Rust 端建立，前端只要顯示）。 */
    onTermAttached: (fn: (t: { id: number; label: string }) => void) =>
      event.listen<{ id: number; label: string }>("term-attached", (e) => fn(e.payload)),
    onAiRun: (fn: (p: AiRunEvent) => void) => event.listen<AiRunEvent>("ai-run", (e) => fn(e.payload)),
  };
}

export type Desktop = ReturnType<typeof bridge>;

export const desktop: Desktop | null =
  typeof window !== "undefined" && window.__TAURI__ ? bridge(window.__TAURI__.core, window.__TAURI__.event) : null;
