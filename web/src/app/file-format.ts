/**
 * 狀態列的編碼與換行（桌面版的本機檔案）：顯示檔案的編碼（UTF-8、Big5、UTF-16…）與換行（CRLF、LF）。
 * 按編碼可以用其他編碼重新讀取（畫面上是亂碼時），或換存檔時用的編碼；按換行可以換成 CRLF 或 LF。
 * 換了以後馬上存一次。Big5 等舊編碼的檔案存檔後還是原本的編碼；寫不進的字（例如表情符號）由
 * {@link askUtf8} 問要不要改存成 UTF-8。
 */
import { desktop, type FileFormatInfo, isRemote } from "../desktop.ts";
import { t } from "../i18n.ts";
import { saveDraft } from "../session.ts";
import { choose } from "../ui/choice.ts";
import { icon } from "../ui/icons.ts";
import { type MenuEntry, setupMenu } from "../ui/menu.ts";
import { toast } from "../ui/toast.ts";
import { app } from "./context.ts";

/** 可以選的編碼（和 desktop/src/text_encoding.rs 的 CHOICES 一致）。`common`：存檔的選單一直列出。 */
const ENCODINGS: { id: string; label: string; note?: () => string; common?: boolean }[] = [
  { id: "utf-8", label: "UTF-8", common: true },
  { id: "utf-16le", label: "UTF-16 LE", common: true },
  { id: "utf-16be", label: "UTF-16 BE" },
  { id: "big5", label: "Big5", note: () => t("繁體中文"), common: true },
  { id: "shift_jis", label: "Shift_JIS", note: () => t("日文") },
  { id: "gb18030", label: "GB18030", note: () => t("簡體中文") },
  { id: "euc-kr", label: "EUC-KR", note: () => t("韓文") },
  { id: "windows-1252", label: "Windows-1252", note: () => t("西歐語言") },
];

/** 狀態列上顯示的編碼名稱。 */
export function encodingLabel(id: string): string {
  return ENCODINGS.find((e) => e.id === id)?.label ?? id;
}

const longLabel = (e: (typeof ENCODINGS)[number]) => (e.note ? t("{name}（{note}）", { name: e.label, note: e.note() }) : e.label);

let encodingBtn: HTMLButtonElement;
let eolBtn: HTMLButtonElement;
/** 狀態列目前顯示的是哪個檔案的格式（`null`：不是本機檔案，不顯示）。 */
let shownPath: string | null = null;
let format: FileFormatInfo | null = null;
let seq = 0;

/** 目前文件對應的本機檔案（遠端、Wiki 頁面、還沒存檔的文件沒有）。 */
function localPath(): string | null {
  const path = app.cur.fileHandle?.path;
  return desktop && path && !isRemote(path) && !app.active.wiki ? path : null;
}

function setText(button: HTMLButtonElement, text: string): void {
  const label = button.querySelector("span")!;
  if (label.textContent !== text) label.textContent = text;
}

function renderLabels(): void {
  const on = !!format && shownPath !== null;
  encodingBtn.hidden = !on;
  eolBtn.hidden = !on;
  if (!format) return;
  const lossy = !!app.active.lossy;
  setText(encodingBtn, lossy ? t("編碼無法辨識") : format.encoding === "utf-8" && format.bom ? "UTF-8 BOM" : encodingLabel(format.encoding));
  encodingBtn.classList.toggle("warn", lossy);
  setText(eolBtn, format.crlf ? "CRLF" : "LF");
}

/** 換了文件或存成新的檔案時，重新讀取格式（renderSaveState 每次都會呼叫，同一個檔案只比對路徑）。 */
export function renderFileFormat(): void {
  if (!encodingBtn) return;
  const path = localPath();
  if (path === shownPath) {
    renderLabels();
    return;
  }
  shownPath = path;
  format = null;
  renderLabels();
  if (!path) return;
  const n = ++seq;
  void desktop!
    .fileFormat(path)
    .then((f) => {
      if (n !== seq) return;
      format = f;
      renderLabels();
    })
    .catch(() => {});
}

/** 用其他編碼重新讀取（有沒存的修改時先問）。 */
async function reopen(id: string): Promise<void> {
  const path = localPath();
  if (!path) return;
  const label = encodingLabel(id);
  if (app.active.dirty) {
    const choice = await choose(
      t("要用 {encoding} 重新讀取嗎？", { encoding: label }),
      t("「{name}」有還沒存檔的修改，重新讀取會丟掉這些修改。", { name: app.active.name }),
      [
        { id: "reload", label: t("重新讀取"), danger: true },
        { id: "cancel", label: t("取消") },
      ],
    );
    if (choice !== "reload") return;
  }
  const file = await desktop!.reopenWithEncoding(path, id);
  app.active.lossy = file.encoding === "unknown";
  app.editor.load(file.text, app.cur.kind);
  saveDraft(app.active.id, file.text);
  app.setBaseline(file.text, true);
  app.renderNow();
  format = await desktop!.fileFormat(path);
  app.renderSaveState();
  if (app.active.lossy) {
    toast(t("用 {encoding} 讀取時有解讀不了的字（畫面上的 �），這個檔案可能不是這個編碼。", { encoding: label }), { tone: "error", duration: 10000 });
  }
}

/** 換存檔時用的編碼或換行，馬上存一次。新的編碼寫不進目前的內容時不換，告訴使用者是哪些字。 */
async function saveWith(change: { encoding?: string; bom?: boolean; crlf?: boolean }): Promise<void> {
  const path = localPath();
  if (!path) return;
  try {
    format = await desktop!.setFileFormat(path, { ...change, text: app.editor.text });
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), { tone: "error", duration: 10000 });
    return;
  }
  renderLabels();
  await app.save(false);
}

/**
 * 存檔時檔案的編碼（例如 Big5）寫不進某些字：問要不要改存成 UTF-8。
 * 回傳 true 表示已經改成 UTF-8，呼叫端再存一次。
 */
export async function askUtf8(out: { path: string; name: string; encoding: string; chars: string }): Promise<boolean> {
  const encoding = encodingLabel(out.encoding);
  const choice = await choose(
    t("要改存成 UTF-8 嗎？"),
    t("「{name}」是 {encoding} 編碼，存不了這幾個字：{chars}。改存成 UTF-8 就能保留這些字，但只認得 {encoding} 的舊程式開啟時可能會看到亂碼。", {
      name: out.name,
      encoding,
      chars: out.chars,
    }),
    [
      { id: "utf8", label: t("改存成 UTF-8"), primary: true },
      { id: "cancel", label: t("取消") },
    ],
  );
  if (choice !== "utf8") return false;
  format = await desktop!.setFileFormat(out.path, { encoding: "utf-8", bom: false });
  renderLabels();
  return true;
}

const run = (p: Promise<void>) => void p.catch((e) => toast(e instanceof Error ? e.message : String(e), { tone: "error" }));

export function initFileFormat(): void {
  encodingBtn = app.$<HTMLButtonElement>("#doc-encoding");
  eolBtn = app.$<HTMLButtonElement>("#doc-eol");
  for (const b of [encodingBtn, eolBtn]) b.replaceChildren(document.createElement("span"), icon("chevron-down"));
  if (!desktop) return;
  const current = () => (app.active.lossy ? null : format?.encoding);
  const entries: MenuEntry[] = [
    { heading: t("用其他編碼重新讀取") },
    ...ENCODINGS.map(
      (e): MenuEntry => ({
        label: longLabel(e),
        checked: () => current() === e.id,
        run: () => run(reopen(e.id)),
      }),
    ),
    "-",
    { heading: t("存檔時用的編碼") },
    {
      label: "UTF-8",
      checked: () => current() === "utf-8" && !format?.bom,
      run: () => run(saveWith({ encoding: "utf-8", bom: false })),
    },
    {
      label: t("UTF-8（含 BOM）"),
      checked: () => current() === "utf-8" && !!format?.bom,
      run: () => run(saveWith({ encoding: "utf-8", bom: true })),
    },
    // 其他編碼：常用的一直列出，其餘的只有檔案本來就是那個編碼時才列出。
    ...ENCODINGS.filter((e) => e.id !== "utf-8").map(
      (e): MenuEntry => ({
        label: longLabel(e),
        when: () => !!e.common || current() === e.id,
        checked: () => current() === e.id,
        run: () => run(saveWith({ encoding: e.id })),
      }),
    ),
  ];
  setupMenu(encodingBtn, null, entries);
  setupMenu(eolBtn, null, [
    { label: t("CRLF（Windows）"), checked: () => !!format?.crlf, run: () => run(saveWith({ crlf: true })) },
    { label: t("LF（macOS、Linux）"), checked: () => !!format && !format.crlf, run: () => run(saveWith({ crlf: false })) },
  ]);
  renderFileFormat();
}
