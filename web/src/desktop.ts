/**
 * 桌面版（Tauri）專用的橋接：原生對話框、資料夾工作區、檔案監看、全文搜尋、圖片存檔。
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

function bridge(core: TauriCore, event: TauriEvent) {
  return {
    startupTarget: () => core.invoke<StartupTarget | null>("startup_target"),
    openFile: () => core.invoke<DesktopFile | null>("open_file"),
    reopenFile: (path: string) => core.invoke<DesktopFile>("reopen_file", { path }),
    saveFile: (req: SaveRequest) => core.invoke<DesktopSaveOutcome>("save_file", { ...req }),
    setTitle: (title: string) => core.invoke<void>("set_title", { title }),
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

    /** 本機檔案在預覽中可以使用的網址。 */
    fileUrl: (path: string) => core.convertFileSrc(path),
    onFileChanged: (fn: (p: { path: string; text: string }) => void) =>
      event.listen<{ path: string; text: string }>("file-changed", (e) => fn(e.payload)),
    onFileRemoved: (fn: (p: { path: string }) => void) =>
      event.listen<{ path: string }>("file-removed", (e) => fn(e.payload)),
    onTreeChanged: (fn: (p: { dirs: string[] }) => void) =>
      event.listen<{ dirs: string[] }>("tree-changed", (e) => fn(e.payload)),
  };
}

export type Desktop = ReturnType<typeof bridge>;

export const desktop: Desktop | null =
  typeof window !== "undefined" && window.__TAURI__ ? bridge(window.__TAURI__.core, window.__TAURI__.event) : null;
