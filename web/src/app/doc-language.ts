/**
 * 純文字文件用哪個語言上色：狀態列的語言選單（ui/kind-picker.ts）選了語言時，這個分頁改用那個語言上色，
 * 還沒存成檔案的文件順便換成那個語言的副檔名。每個分頁各自記住（重新開啟程式後改回依副檔名）。
 */
import { languages } from "@codemirror/language-data";
import { replaceExtension } from "../files.ts";
import { app } from "./context.ts";
import { renderSaveState } from "./outline.ts";

/** 分頁 → 使用者選的語言（`""` 是純文字、不上色）。沒有記錄的分頁依副檔名。 */
const chosen = new Map<string, string>();

/** 換了文件、檔名或語言時：編輯器用對的語言，狀態列顯示語言名稱（renderSaveState 每次都會呼叫）。 */
export function renderDocLanguage(): void {
  const override = chosen.get(app.active.id) ?? null;
  app.editor.setLanguage(override);
  app.kindSelect.setLanguage(app.editor.languageName, override !== null);
}

export function initDocLanguage(): void {
  app.kindSelect.addEventListener("language", (e) => {
    const name = (e as CustomEvent<string | null>).detail;
    const doc = app.active;
    if (name === null) chosen.delete(doc.id);
    else chosen.set(doc.id, name);
    // 選了語言：改成純文字類型（Markdown、JSON 有自己的編輯方式）。
    if (name !== null && app.cur.kind !== "text") app.setKind("text");
    // 還沒存成檔案的文件：換成這個語言的副檔名，存檔時才是對的類型。
    const ext = name ? languages.find((l) => l.name === name)?.extensions[0] : undefined;
    if (ext && !app.cur.fileHandle) app.setFileName(replaceExtension(app.cur.fileName, `.${ext}`));
    renderDocLanguage();
    renderSaveState();
  });
}
