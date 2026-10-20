/**
 * 桌面版（Tauri）專用的橋接：在桌面版中改用原生對話框讀寫檔案。
 * 在一般瀏覽器裡 `desktop` 為 null，其餘程式碼照常走網頁 API。
 */

interface TauriCore {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

declare global {
  interface Window {
    __TAURI__?: { core: TauriCore };
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
}

function bridge(core: TauriCore) {
  return {
    openFile: () => core.invoke<DesktopFile | null>("open_file"),
    initialFile: () => core.invoke<DesktopFile | null>("initial_file"),
    saveFile: (req: SaveRequest) => core.invoke<{ path: string; name: string } | null>("save_file", { ...req }),
    setTitle: (title: string) => core.invoke<void>("set_title", { title }),
  };
}

export const desktop = window.__TAURI__ ? bridge(window.__TAURI__.core) : null;
