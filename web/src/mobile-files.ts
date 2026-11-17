/**
 * Android 版的檔案開啟與存檔。
 *
 * Android 的 WebView 沒有 File System Access API（`showOpenFilePicker`、`showSaveFilePicker`），下載連結也沒有作用。
 * 這裡用原生端的檔案選擇器（android/src/lib.rs、FilesPlugin.kt）補上同樣介面的兩個函式，回傳的檔案控制代碼
 * 和瀏覽器的一樣有 `getFile()`、`createWritable()`：網頁版原本的開檔、存回原檔、另存新檔、偵測外部修改
 * 都照原來的程式走，不必另外寫一套。
 */
import { t } from "./i18n.ts";
import { isMobileApp } from "./platform.ts";

/** 位元組轉 Base64（分段處理，避免大檔案超過函式參數上限）。 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface Invoke {
  <T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

interface Picked {
  uri: string | null;
  name: string;
  /** 開檔時原生端當下讀出來的內容（Base64）；讀不到時是 `error`。 */
  data?: string;
  modified?: number;
  error?: string;
}

/** 來源不讓 oMarker 讀寫（Android 的 SecurityException，例如 OneDrive 只在選檔當下給權限）。 */
function denied(message: string): boolean {
  return /denying access|Permission Denial|SecurityException|permission/i.test(message);
}

/** 原生端的錯誤換成看得懂的說明：被來源拒絕時說明原因與怎麼辦。 */
function explain(e: unknown, action: "read" | "write", name: string): Error {
  const message = e instanceof Error ? e.message : String(e);
  if (!denied(message)) return e instanceof Error ? e : new Error(message);
  return new Error(
    action === "read"
      ? t("「{name}」所在的位置（例如 OneDrive）不讓 oMarker 讀取。請在那個 App 裡把檔案設成離線可用，或先下載到手機再開啟。", { name })
      : t("「{name}」所在的位置（例如 OneDrive）不讓 oMarker 寫回去。內容還在 oMarker 裡，請用「另存新檔」存到手機或其他位置。", { name }),
  );
}

const invoke: Invoke = (cmd, args) => (window as unknown as { __TAURI__: { core: { invoke: Invoke } } }).__TAURI__.core.invoke(cmd, args);

/** 使用者取消時丟出和瀏覽器一樣的錯誤（呼叫的地方已經會處理）。 */
const aborted = () => new DOMException("The user aborted a request.", "AbortError");

/** 選到的位置包成檔案控制代碼。 */
function handleOf(uri: string, name: string, first?: { data: string; modified?: number }) {
  let current = name;
  // 開檔時已經讀到的內容：第一次 getFile() 直接用（有些來源之後就不讓讀了）。
  let initial = first;
  return {
    get name() {
      return current;
    },
    async getFile(): Promise<File> {
      if (initial) {
        const { data, modified } = initial;
        initial = undefined;
        return new File([base64ToBytes(data) as BlobPart], current, { lastModified: modified || 0 });
      }
      const f = await invoke<{ data: string; name: string; modified: number }>("mobile_read_file", { uri }).catch((e: unknown) => {
        throw explain(e, "read", current);
      });
      if (f.name) current = f.name;
      return new File([base64ToBytes(f.data) as BlobPart], current, { lastModified: f.modified || 0 });
    },
    async createWritable() {
      const parts: Uint8Array[] = [];
      return {
        async write(data: string | Uint8Array): Promise<void> {
          parts.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
        },
        async close(): Promise<void> {
          const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
          let at = 0;
          for (const p of parts) {
            all.set(p, at);
            at += p.length;
          }
          await invoke("mobile_write_file", { uri, data: bytesToBase64(all) }).catch((e: unknown) => {
            throw explain(e, "write", current);
          });
        },
      };
    },
  };
}

/** 副檔名對應的 MIME 類型（另存新檔時告訴系統；不認得的當成一般檔案）。 */
function mimeOf(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return (
    { md: "text/markdown", markdown: "text/markdown", txt: "text/plain", html: "text/html", htm: "text/html", csv: "text/csv", json: "application/json", pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }[ext] ??
    "application/octet-stream"
  );
}

async function createFile(name: string) {
  const picked = await invoke<Picked>("mobile_create_file", { name, mime: mimeOf(name) });
  if (!picked.uri) throw aborted();
  return handleOf(picked.uri, picked.name || name);
}

/** 讓使用者選位置，把內容存成檔案（匯出 HTML、Word 等）。回傳檔名；取消時回傳 null。 */
export async function mobileSaveBytes(name: string, bytes: Uint8Array): Promise<string | null> {
  try {
    const handle = await createFile(name);
    const w = await handle.createWritable();
    await w.write(bytes);
    await w.close();
    return handle.name;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null;
    throw e;
  }
}

/** Android 版啟動時補上瀏覽器沒有的檔案選擇器。 */
export function installMobileFiles(): void {
  if (!isMobileApp) return;
  const w = window as unknown as {
    showOpenFilePicker?: () => Promise<unknown[]>;
    showSaveFilePicker?: (opts?: { suggestedName?: string }) => Promise<unknown>;
  };
  w.showOpenFilePicker = async () => {
    const picked = await invoke<Picked>("mobile_pick_file", { read: true });
    if (!picked.uri) throw aborted();
    if (picked.error) throw explain(new Error(picked.error), "read", picked.name);
    return [handleOf(picked.uri, picked.name, picked.data !== undefined ? { data: picked.data, modified: picked.modified } : undefined)];
  };
  w.showSaveFilePicker = (opts) => createFile(opts?.suggestedName ?? "");
}
