/**
 * Android 版的檔案開啟與存檔。
 *
 * Android 的 WebView 沒有 File System Access API（`showOpenFilePicker`、`showSaveFilePicker`），下載連結也沒有作用。
 * 這裡用原生端的檔案選擇器（android/src/lib.rs、FilesPlugin.kt）補上同樣介面的兩個函式，回傳的檔案控制代碼
 * 和瀏覽器的一樣有 `getFile()`、`createWritable()`：網頁版原本的開檔、存回原檔、另存新檔、偵測外部修改
 * 都照原來的程式走，不必另外寫一套。
 */
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
}

const invoke: Invoke = (cmd, args) => (window as unknown as { __TAURI__: { core: { invoke: Invoke } } }).__TAURI__.core.invoke(cmd, args);

/** 使用者取消時丟出和瀏覽器一樣的錯誤（呼叫的地方已經會處理）。 */
const aborted = () => new DOMException("The user aborted a request.", "AbortError");

/** 選到的位置包成檔案控制代碼。 */
function handleOf(uri: string, name: string) {
  let current = name;
  return {
    get name() {
      return current;
    },
    async getFile(): Promise<File> {
      const f = await invoke<{ data: string; name: string; modified: number }>("mobile_read_file", { uri });
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
          await invoke("mobile_write_file", { uri, data: bytesToBase64(all) });
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
    const picked = await invoke<Picked>("mobile_pick_file");
    if (!picked.uri) throw aborted();
    return [handleOf(picked.uri, picked.name)];
  };
  w.showSaveFilePicker = (opts) => createFile(opts?.suggestedName ?? "");
}
