/**
 * 檔案開啟與儲存。
 * 支援 File System Access API 的瀏覽器（Chrome、Edge）可以直接寫回原檔；
 * 其他瀏覽器則退回「選擇檔案」與「下載」。
 */
import { type DesktopFile, desktop } from "./desktop.ts";
import { type DocKind, KINDS, OPEN_ACCEPT } from "./kinds.ts";

export interface FileHandle {
  name: string;
  /** 桌面版：檔案在磁碟上的路徑。 */
  path?: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

interface PickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}

declare global {
  interface Window {
    showOpenFilePicker?: (opts?: PickerOptions) => Promise<FileHandle[]>;
    showSaveFilePicker?: (opts?: PickerOptions) => Promise<FileHandle>;
  }
}

export interface OpenedFile {
  name: string;
  text: string;
  handle: FileHandle | null;
  /** 桌面版：檔案不是 UTF-8、改用 Big5 解讀時為 "big5"。 */
  encoding?: string;
}

/**
 * 網頁版（File System Access API）：記下每個檔案最後一次讀寫時的修改時間，
 * 存檔前比對，就能知道檔案是否被別的程式改過。桌面版由 Rust 端以內容雜湊判斷。
 */
const lastModified = new WeakMap<FileHandle, number>();

async function remember(handle: FileHandle): Promise<File> {
  const file = await handle.getFile();
  lastModified.set(handle, file.lastModified);
  return file;
}

/** 存檔結果；使用者取消時為 `null`。 */
export type SaveOutcome =
  | { status: "saved"; name: string; handle: FileHandle | null }
  | { status: "conflict"; name: string; diskText: string };

/** 桌面版的檔案控制代碼：讀寫都交給原生程式處理。 */
export function desktopHandle(path: string, name: string): FileHandle {
  return {
    name,
    path,
    getFile: () => Promise.reject(new Error("桌面版不支援 getFile")),
    createWritable: () => Promise.reject(new Error("桌面版不支援 createWritable")),
  };
}

/** 把桌面版讀到的檔案轉成一般的 OpenedFile。 */
export function fromDesktop(f: DesktopFile): OpenedFile {
  return { name: f.name, text: f.text, handle: desktopHandle(f.path, f.name), encoding: f.encoding };
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

/** 開啟檔案。使用者取消時回傳 `null`。 */
export async function openFile(fallbackInput: HTMLInputElement): Promise<OpenedFile | null> {
  if (desktop) {
    const f = await desktop.openFile();
    return f ? fromDesktop(f) : null;
  }
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: [OPEN_ACCEPT] });
      const file = await remember(handle);
      return { name: file.name, text: await file.text(), handle };
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
  }

  return new Promise((resolve) => {
    fallbackInput.value = "";
    fallbackInput.onchange = async () => {
      const file = fallbackInput.files?.[0];
      resolve(file ? { name: file.name, text: await file.text(), handle: null } : null);
    };
    fallbackInput.click();
  });
}

/**
 * 儲存文件。有檔案控制代碼時直接覆寫；否則跳出另存新檔或改用下載。
 * `saveAs` 為 true 時一律重新選擇位置。
 *
 * 覆寫前會檢查檔案是否在開啟後被別的程式改過，有的話回傳 `conflict` 與磁碟上的內容；
 * `force` 為 true 代表使用者已確認要覆蓋。
 */
export async function saveFile(
  text: string,
  name: string,
  kind: DocKind,
  handle: FileHandle | null,
  { saveAs = false, force = false } = {},
): Promise<SaveOutcome | null> {
  const info = KINDS[kind];
  if (desktop) {
    const out = await desktop.saveFile({
      path: saveAs ? null : (handle?.path ?? null),
      suggestedName: name,
      text,
      filterName: info.label,
      extensions: Object.values(info.accept).flat(),
      force,
    });
    if (out.status === "cancelled") return null;
    if (out.status === "conflict") return { status: "conflict", name: out.name, diskText: out.diskText };
    return { status: "saved", name: out.name, handle: desktopHandle(out.path, out.name) };
  }
  try {
    if ((saveAs || !handle) && window.showSaveFilePicker) {
      handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: info.label, accept: info.accept }],
      });
    } else if (handle && !force && lastModified.has(handle)) {
      const disk = await handle.getFile();
      if (disk.lastModified !== lastModified.get(handle)) {
        return { status: "conflict", name: handle.name, diskText: await disk.text() };
      }
    }
    if (handle && !(saveAs && !window.showSaveFilePicker)) {
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      await remember(handle);
      return { status: "saved", name: handle.name, handle };
    }
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
  await download(name, text, info.mime);
  return { status: "saved", name, handle: null };
}

/**
 * 讓使用者把內容存成檔案：瀏覽器中直接下載，桌面版則跳出另存新檔對話框。
 * 回傳是否真的存了（桌面版使用者可能按取消）。
 */
export async function download(filename: string, content: string, type: string): Promise<boolean> {
  if (desktop) {
    const ext = filename.slice(filename.lastIndexOf("."));
    const saved = await desktop.saveFile({
      path: null,
      suggestedName: filename,
      text: content,
      filterName: ext.slice(1).toUpperCase(),
      extensions: [ext],
    });
    return saved.status === "saved";
  }
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  // 太早撤銷網址會讓部分瀏覽器下載失敗或遺失檔名。
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/** 位元組轉 Base64（分段處理，避免大檔案超過函式參數上限）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** 下載或另存二進位檔（例如 Word .docx）。桌面版回傳存檔路徑，取消時回傳 null；網頁版回傳檔名。 */
export async function downloadBytes(filename: string, bytes: Uint8Array, type: string, filterName: string): Promise<string | null> {
  if (desktop) {
    const ext = filename.slice(filename.lastIndexOf("."));
    return desktop.exportBinary(filename, bytesToBase64(bytes), filterName, [ext]);
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return filename;
}

/** 把副檔名換掉，例如 `筆記.md` → `筆記.html`。 */
export function replaceExtension(name: string, ext: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name) + ext;
}

/** 去掉副檔名。 */
export function stem(name: string): string {
  return replaceExtension(name, "");
}
