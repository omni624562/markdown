/**
 * 分頁、標題列、快速開啟等顯示的文件名稱。
 *
 * 還沒存成檔案、也沒有自己取名的文件（名稱還是預設的「未命名」）用內容的第一個標題命名
 * （沒有標題時用第一行），好幾份新文件開著時才分得出來；空白的叫「未命名」，好幾份時編號
 * 「未命名 2」「未命名 3」……。自己取過名的、存成檔案的、Wiki 頁面照原本的名稱。
 * 分頁物件裡存的仍是原本的名稱（`doc.name`），這裡只決定顯示的名稱與存檔的預設檔名。
 */
import type { Text } from "@codemirror/state";
import type { Doc } from "../main.ts";
import { isUntitledName, shortTitle, titleFileName, titleOf, TITLE_SCAN_LINES } from "../doc-title.ts";
import { t } from "../i18n.ts";
import { type DocKind, KINDS, isTextFileName } from "../kinds.ts";
import { draftVersion, loadDraft } from "../session.ts";
import { app } from "./context.ts";

/** 分頁的欄位：目前的分頁以全域變數（`cur`、編輯器）為準，其他分頁用分頁物件裡存的。 */
function fields(doc: Doc): { name: string; kind: DocKind; unsaved: boolean; text: Text | null } {
  if (doc === app.active) {
    const { cur } = app;
    return { name: cur.fileName, kind: cur.kind, unsaved: !cur.fileBacked && !cur.fileHandle && !doc.wiki, text: app.editor.view.state.doc };
  }
  return { name: doc.name, kind: doc.kind, unsaved: !doc.fileBacked && !doc.handle && !doc.path && !doc.wiki, text: doc.state?.doc ?? null };
}

/** 還沒存成檔案（也不是 Wiki 頁面）。 */
export function unsavedDoc(doc: Doc): boolean {
  return fields(doc).unsaved;
}

/** 用內容命名的文件：還沒存成檔案，名稱也還是預設的「未命名」（使用者自己取的名稱優先）。 */
function contentNamed(doc: Doc): boolean {
  const f = fields(doc);
  return f.unsaved && isUntitledName(f.name);
}

/** 內容推出的標題。同一份內容只算一次（編輯器的文件物件內容不變時是同一個）。 */
const textTitles = new WeakMap<Text, { kind: DocKind; title: string }>();
/** 還沒顯示過的分頁只有草稿：草稿沒有再寫過就不必重新讀。 */
const draftTitles = new Map<string, { version: number; kind: DocKind; title: string }>();

function* draftLines(text: string): Generator<string> {
  for (let at = 0, n = 0; at <= text.length && n < TITLE_SCAN_LINES; n++) {
    const end = text.indexOf("\n", at);
    yield text.slice(at, end < 0 ? text.length : end);
    if (end < 0) return;
    at = end + 1;
  }
}

function contentTitle(doc: Doc): string {
  const { kind, text } = fields(doc);
  if (text) {
    const hit = textTitles.get(text);
    if (hit?.kind === kind) return hit.title;
    const title = titleOf(text.iterLines(1, Math.min(text.lines, TITLE_SCAN_LINES) + 1), kind);
    textTitles.set(text, { kind, title });
    return title;
  }
  const version = draftVersion(doc.id);
  const hit = draftTitles.get(doc.id);
  if (hit?.version === version && hit.kind === kind) return hit.title;
  const title = titleOf(draftLines(loadDraft(doc.id) ?? ""), kind);
  draftTitles.set(doc.id, { version, kind, title });
  return title;
}

/**
 * 空白文件的編號（1 顯示成「未命名」）。一份文件拿到編號後就不變，其他分頁打字、關掉時不會重排；
 * 有了標題就把編號還回去，之後又清空時再拿最小的空號。
 */
const numbers = new Map<string, number>();

function untitled(doc: Doc): string {
  const taken = (n: number) => app.docs.some((d) => d !== doc && numbers.get(d.id) === n && contentNamed(d) && !contentTitle(d));
  let n = numbers.get(doc.id);
  if (n === undefined || taken(n)) {
    for (n = 1; taken(n); n++);
    numbers.set(doc.id, n);
  }
  return n === 1 ? t("未命名") : t("未命名 {n}", { n });
}

/** 這份文件的編號重新給：收掉沒顯示的空白文件、換成新文件時，新文件不必是「未命名 2」。 */
export function renumber(doc: Doc): void {
  numbers.delete(doc.id);
}

/** 完整的名稱（不截斷）。 */
function fullName(doc: Doc): string {
  if (!contentNamed(doc)) return fields(doc).name;
  const title = contentTitle(doc);
  if (!title) return untitled(doc);
  numbers.delete(doc.id);
  return title;
}

/** 分頁、標題列、快速開啟等顯示的名稱。 */
export function docName(doc: Doc): string {
  return contentNamed(doc) ? shortTitle(fullName(doc)) : fields(doc).name;
}

/** 分頁的提示：還沒存成檔案的文件是完整的名稱加「（尚未存檔）」；其他的是檔名（有路徑時呼叫端顯示路徑）。 */
export function docTooltip(doc: Doc): string {
  return unsavedDoc(doc) ? t("{name}（尚未存檔）", { name: fullName(doc) }) : fields(doc).name;
}

/** 存檔對話框預設的檔名：用內容命名的文件用標題（去掉檔名不能用的字元），沒有標題時是「未命名」。 */
export function saveFileName(): string {
  const { name, kind } = fields(app.active);
  const ext = KINDS[kind].ext;
  if (contentNamed(app.active)) return (titleFileName(contentTitle(app.active)) || t("未命名")) + ext;
  // 自己取的名稱沒有副檔名時補上，存成正確的類型。
  return unsavedDoc(app.active) && !isTextFileName(name) ? `${name}${ext}` : name;
}

/**
 * 目前分頁的名稱跟著內容變了（例如改了第一個標題）：重畫分頁。編輯後更新畫面時呼叫（打字時不會每個字都算）。
 * 正在分頁上改名時不重畫，免得輸入框不見。
 */
export function refreshDocName(): void {
  const shown = app.$("#tab-bar").querySelector(`.tab[data-id="${CSS.escape(app.active.id)}"] .tab-name`);
  if (shown && shown.textContent !== docName(app.active)) app.renderTabs();
}
