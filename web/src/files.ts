/**
 * 檔案開啟與儲存。
 * 支援 File System Access API 的瀏覽器（Chrome、Edge）可以直接寫回原檔；
 * 其他瀏覽器則退回「選擇檔案」與「下載」。
 */
import { type DocKind, KINDS, OPEN_ACCEPT } from "./kinds.ts";

export interface FileHandle {
  name: string;
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
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

/** 開啟檔案。使用者取消時回傳 `null`。 */
export async function openFile(fallbackInput: HTMLInputElement): Promise<OpenedFile | null> {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: [OPEN_ACCEPT] });
      const file = await handle.getFile();
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
 * 回傳之後應沿用的控制代碼與檔名；使用者取消時回傳 `null`。
 */
export async function saveFile(
  text: string,
  name: string,
  kind: DocKind,
  handle: FileHandle | null,
  saveAs = false,
): Promise<{ name: string; handle: FileHandle | null } | null> {
  const info = KINDS[kind];
  try {
    if ((saveAs || !handle) && window.showSaveFilePicker) {
      handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: info.label, accept: info.accept }],
      });
    }
    if (handle && !(saveAs && !window.showSaveFilePicker)) {
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return { name: handle.name, handle };
    }
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
  download(name, text, info.mime);
  return { name, handle: null };
}

export function download(filename: string, content: string, type: string): void {
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
