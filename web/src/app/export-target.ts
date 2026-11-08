/**
 * 匯出（HTML、Word、PDF）與另存新檔的預設位置、檔名：
 *
 * - 資料夾：文件已經存成檔案時是它所在的資料夾（匯出檔和原稿放在一起）；還沒存檔時是目前開著的專案資料夾；
 *   都沒有（或是遠端資料夾）時交給系統。只是對話框一開始的位置，使用者還是可以換。
 * - 檔名：已存檔的文件用檔名；還沒存檔的用第一個標題（和存檔時一樣，見 doc-names.ts 的 saveFileName）。
 */
import { isRemote } from "../desktop.ts";
import { replaceExtension, setSaveDirectory } from "../files.ts";
import { dirname } from "../paths.ts";
import { app } from "./context.ts";
import { saveFileName } from "./doc-names.ts";

/** 對話框一開始顯示的資料夾；沒有合適的時回傳 null。 */
export function defaultSaveDir(): string | null {
  if (!app) return null;
  const path = app.docPath(app.active);
  if (path && !isRemote(path)) {
    const dir = dirname(path);
    if (dir) return dir;
  }
  const root = app.workspaceRoot?.path;
  return root && !isRemote(root) ? root : null;
}

/** 匯出的檔名：存檔時會用的名稱換成匯出的副檔名（`.html`、`.docx`、`.pdf`）。 */
export function exportName(ext: string): string {
  return replaceExtension(saveFileName(), ext);
}

setSaveDirectory(defaultSaveDir);
