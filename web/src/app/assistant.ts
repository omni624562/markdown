/**
 * Claude API 助理側欄（桌面版，預設關閉，只在私人電腦使用）。
 *
 * 三層保護：設定的總開關（預設關閉，原生端開啟時再確認一次）、每個專案各自允許（新專案預設不允許）、
 * Azure DevOps／GitHub 的工作項目、Wiki 一律不送（原生端也會擋 Azure DevOps 的儲存庫）。
 * 每個專案第一次送出前先確認要送什麼、大約多少錢；修改文件一律變成建議卡片，由使用者按「套用」。
 * API 金鑰只存在原生端，這裡只知道有沒有設定。
 */
import type { EditorView } from "@codemirror/view";
import { render as renderMarkdown } from "../../pkg/md_wasm.js";
import { blockRemoteImagesInHtml } from "../remote-images.ts";
import {
  type ActionMode,
  ASSISTANT_ACTIONS,
  type AssistantAction,
  MODEL_LABELS,
  briefingTasks,
  conversation,
  customActions,
  type NoteText,
  pickNotes,
  type ProjectIndex,
  projectIndex,
  noteName,
  type TranscriptItem,
  transcriptMarkdown,
  estimateUsd,
  formatUsd,
  listed,
  insertPadding,
  mermaidBlock,
  replacementText,
  systemPrompt,
  toggled,
  userContent,
} from "../assistant-text.ts";
import { type AssistantImage, type AssistantMessage, type AssistantRunEvent, type AssistantUsage, desktop } from "../desktop.ts";
import { currentLang, t } from "../i18n.ts";
import { ASSISTANT_FONT_RANGE, CLAUDE_MODELS, type ClaudeModel, DEFAULTS as DEFAULT_SETTINGS } from "../settings.ts";
import { choose } from "../ui/choice.ts";
import { icon } from "../ui/icons.ts";
import { setupMenu } from "../ui/menu.ts";
import { toast } from "../ui/toast.ts";
import { openUrl } from "./activity-bar.ts";
import { wikiTarget } from "../plugins/doc-links.ts";
import { openWiki } from "./wiki-links.ts";
import { drawerQuery, indexedDocs, indexedTexts, openPath, setRightOutline } from "./workspace-ui.ts";
import { availableRightTabs, selectRightTab } from "./right-tabs.ts";
import { app } from "./context.ts";
import { cometLocked, unlockComet } from "./comet-files.ts";
import { docName as tabName } from "./doc-names.ts";
import { issueView } from "./wiki-edit.ts";
import { settingsDialog } from "./settings-ui.ts";


interface Pending {
  id: number;
  answer: HTMLElement;
  text: string;
  /** 動作的回答怎麼用（見 assistant-text.ts 的 ActionMode）。 */
  mode: ActionMode;
  /** 流程圖：插入時包成 ```mermaid 區塊。 */
  mermaid: boolean;
  /** 取代或插入的範圍：送出當下選取的範圍與文字（套用前確認沒被改過；插入的位置是範圍的結尾）。 */
  range: { from: number; to: number; original: string };
  question: string;
  /** 上網查資料時引用的網頁（網址 → 標題）。 */
  sources: Map<string, string>;
  /** 畫面上顯示的問題（動作名稱或使用者打的字），存成筆記時用。 */
  shown: string;
}

let panel: HTMLElement | null = null;
let log!: HTMLElement;
let chips!: HTMLElement;
let input!: HTMLTextAreaElement;
let sendBtn!: HTMLButtonElement;
let usageEl!: HTMLElement;
let modelBtn!: HTMLButtonElement;
let notice!: HTMLElement;
let history: AssistantMessage[] = [];
/** 這次要附上的圖片（貼上或按迴紋針選的）；送出後清空。 */
interface Attached extends AssistantImage {
  name: string;
  url: string;
}
let attached: Attached[] = [];
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 估計費用時一張圖片算多少字（大約 1,600 token）。 */
const IMAGE_CHARS = 1600;
/** 這次對話的一問一答（存成筆記用）。 */
let transcript: TranscriptItem[] = [];
let saveBtn!: HTMLButtonElement;
let pending: Pending | null = null;
let nextId = 1;
let includeDoc = true;
/** 問整個專案：送出前從專案裡挑出相關的筆記一起送，回答標出處。 */
let askProject = false;
/** 這一題上網查資料（設定裡允許時才出現這個選項）。 */
let webSearch = false;
let usage: AssistantUsage | null = null;
let hasKey = false;

/** 設定裡開了 Claude API 助理（桌面版才有）。 */
export function assistantEnabled(): boolean {
  return !!desktop && app.settings.value.claudeApiEnabled;
}

/** 助理現在看得到：是右側欄選的那一頁，而且右側欄開著（app/right-tabs.ts 管顯示）。 */
export function assistantOpen(): boolean {
  return !!panel && !panel.hidden && !app.$("aside#outline-right").hidden;
}

/** 目前不能送出的原因；可以送出時是 null。 */
function blocked(): { message: string; action?: { label: string; run: () => void } } | null {
  if (!assistantEnabled()) {
    return { message: t("Claude API 助理還沒開啟。"), action: { label: t("打開設定"), run: () => settingsDialog.open(t("Claude API 助理")) } };
  }
  if (!hasKey) {
    return { message: t("還沒有輸入 Claude API 金鑰。"), action: { label: t("打開設定"), run: () => settingsDialog.open(t("Claude API 助理")) } };
  }
  if (issueView.shownKey || app.active.wiki) {
    return { message: t("這裡是 Azure DevOps／GitHub 的內容，不會送給 AI。") };
  }
  const root = app.workspaceRoot?.path;
  if (!root) return { message: t("請先開啟專案資料夾；助理只在允許 AI 的專案裡使用。") };
  if (!listed(app.settings.value.assistantProjects, root)) {
    return {
      message: t("「{name}」還沒允許使用 AI。", { name: app.workspaceRoot!.name }),
      action: {
        label: t("允許這個專案使用 AI"),
        run: () => app.settings.update({ assistantProjects: toggled(app.settings.value.assistantProjects, root, true) }),
      },
    };
  }
  return null;
}

function selection(): { from: number; to: number; text: string } {
  const r = app.editor.view.state.selection.main;
  return { from: r.from, to: r.to, text: app.editor.view.state.sliceDoc(r.from, r.to) };
}

function docName(): string {
  return tabName(app.active);
}

/** 這次會送出的內容（標籤，可以拿掉目前的文件）。 */
/** 今天的日期（YYYY-MM-DD 星期幾），給今日簡報用。 */
function todayLabel(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const week = d.toLocaleDateString(currentLang() === "en" ? "en" : "zh-TW", { weekday: "long" });
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${week}`;
}

/** 標籤列目前顯示的內容（判斷要不要重畫）。 */
let shownChips = "";
function chipsKey(): string {
  return JSON.stringify([
    includeDoc,
    includeDoc && docName(),
    selection().text.length,
    askProject,
    webSearch,
    app.settings.value.claudeWebSearch,
    !!app.workspaceRoot,
    attached.length,
  ]);
}

function renderChips(): void {
  shownChips = chipsKey();
  const items: HTMLElement[] = [];
  const chip = (text: string, iconName: string, remove?: () => void) => {
    const el = document.createElement("span");
    el.className = "assistant-chip";
    el.append(icon(iconName), text);
    if (remove) {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "assistant-chip-x";
      x.title = t("不要送出");
      x.setAttribute("aria-label", t("不要送出「{name}」", { name: text }));
      x.append(icon("x"));
      x.addEventListener("click", remove);
      el.append(x);
    }
    items.push(el);
  };
  if (includeDoc) chip(docName(), "file-text", () => ((includeDoc = false), renderChips()));
  else {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "assistant-chip assistant-chip-add";
    add.append(icon("plus"), t("加入目前的文件"));
    add.addEventListener("click", () => ((includeDoc = true), renderChips()));
    items.push(add);
  }
  if (app.settings.value.claudeWebSearch) {
    if (webSearch) chip(t("上網查"), "globe", () => ((webSearch = false), renderChips()));
    else {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "assistant-chip assistant-chip-add";
      add.title = t("讓 Claude 上網搜尋（每次搜尋約 US$0.01）");
      add.append(icon("plus"), t("上網查"));
      add.addEventListener("click", () => ((webSearch = true), renderChips(), input.focus()));
      items.push(add);
    }
  }
  if (app.workspaceRoot) {
    if (askProject) chip(t("整個專案"), "folder-open", () => ((askProject = false), renderChips()));
    else {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "assistant-chip assistant-chip-add";
      add.title = t("從專案裡找相關的筆記一起送出，回答會標出處");
      add.append(icon("plus"), t("問整個專案"));
      add.addEventListener("click", () => ((askProject = true), renderChips(), input.focus()));
      items.push(add);
    }
  }
  const sel = selection().text;
  if (sel.trim()) chip(t("選取 {n} 字", { n: sel.length }), "text-cursor");
  attached.forEach((img, i) => {
    const el = document.createElement("span");
    el.className = "assistant-chip assistant-chip-image";
    const thumb = document.createElement("img");
    thumb.src = img.url;
    thumb.alt = "";
    const x = document.createElement("button");
    x.type = "button";
    x.className = "assistant-chip-x";
    x.title = t("不要送出");
    x.setAttribute("aria-label", t("不要送出「{name}」", { name: img.name }));
    x.append(icon("x"));
    x.addEventListener("click", () => {
      URL.revokeObjectURL(img.url);
      attached.splice(i, 1);
      renderChips();
    });
    el.append(thumb, img.name, x);
    items.push(el);
  });
  chips.replaceChildren(...items);
}

function renderUsage(): void {
  if (!usage) {
    usageEl.hidden = true;
    return;
  }
  usageEl.hidden = false;
  usageEl.textContent = t("本月 {used} / {limit}", { used: formatUsd(usage.usd), limit: `US$${Math.round(usage.limit)}` });
  usageEl.classList.toggle("near", usage.usd >= usage.limit * 0.8);
  usageEl.title = t("這個月估計的費用與上限（在設定調整）");
}

async function refreshStatus(): Promise<void> {
  if (!desktop) return;
  [hasKey, usage] = await Promise.all([desktop.assistantKeyStatus().catch(() => false), desktop.assistantUsage().catch(() => null)]);
  renderUsage();
  renderNotice();
}

function renderNotice(): void {
  const b = blocked();
  notice.hidden = !b;
  sendBtn.disabled = !!b || !!pending;
  input.disabled = !!b;
  for (const q of panel!.querySelectorAll<HTMLButtonElement>(".assistant-quick button")) q.disabled = !!b || !!pending;
  if (!b) return notice.replaceChildren();
  const p = document.createElement("p");
  p.textContent = b.message;
  notice.replaceChildren(p);
  if (b.action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-small btn-primary";
    btn.textContent = b.action.label;
    btn.addEventListener("click", () => b.action!.run());
    notice.append(btn);
  }
}

function bubble(role: "user" | "assistant", text = ""): HTMLElement {
  const el = document.createElement("div");
  el.className = `assistant-msg assistant-${role}`;
  if (role === "user") el.textContent = text;
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function showAnswer(el: HTMLElement, text: string): void {
  const body = document.createElement("div");
  body.className = "markdown-body assistant-answer";
  // sourcepos：回答裡的程式碼區塊、表格對回原文（見 blockActions）。
  // 回答裡的遠端圖片一律不載入（不看「封鎖遠端圖片」的設定）：送給助理的文件、筆記、搜尋結果裡可能藏著指示，
  // 要它輸出 `![](https://…?d=其他筆記的內容)`，圖片一載入資料就送出去了。放進畫面「之前」就拿掉網址。
  body.innerHTML = blockRemoteImagesInHtml(renderMarkdown(text, { kind: "markdown", sourcepos: true }).html);
  // 這裡沒有「按一下載入」，提示只留原本的網址。
  for (const img of body.querySelectorAll<HTMLImageElement>("img.remote-blocked")) img.title = img.dataset.blockedSrc ?? "";
  el.replaceChildren(body);
}

function cardButton(label: string, run: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `btn btn-small${primary ? " btn-primary" : ""}`;
  b.textContent = label;
  b.addEventListener("click", run);
  return b;
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(t("已複製"), { tone: "success" });
  } catch {
    toast(t("無法複製到剪貼簿"), { tone: "error" });
  }
}

function toolButton(label: string, iconName: string, run: () => void, text?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = text ? "assistant-tool with-text" : "assistant-tool";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.append(icon(iconName));
  if (text) {
    const span = document.createElement("span");
    span.textContent = text;
    b.append(span);
  }
  b.addEventListener("click", run);
  return b;
}

/**
 * 可以把回答寫進目前的文件嗎：唯讀時（例如預設唯讀的 COMET 檔案）不寫，說明原因；COMET 檔案附「仍要編輯」。
 * 不先看的話，唯讀的文件會把修改擋掉，畫面卻說「已插入」。
 */
function writable(view: EditorView): boolean {
  if (!view.state.readOnly) return true;
  if (cometLocked(view))
    toast(t("這是 COMET 的檔案，在 oMarker 裡預設唯讀；按「仍要編輯」解除後再插入一次。"), {
      tone: "error",
      action: { label: t("仍要編輯"), run: () => unlockComet(view) },
    });
  else toast(t("這份文件現在是唯讀的，沒辦法插入。"), { tone: "error" });
  return false;
}

/**
 * 把回答（或其中一塊）寫進目前的文件：`at` 是插入的位置（游標或文件最後）。
 * 插在一行的中間或緊接著文字時前後空一行，插入的內容自成段落；插完游標移到內容後面並捲到看得到。
 */
function insertIntoDoc(text: string, where: "cursor" | "end"): void {
  const view = app.editor.view;
  if (!writable(view)) return;
  const doc = view.state.doc;
  const at = where === "end" ? doc.length : view.state.selection.main.head;
  const { prefix, suffix } = insertPadding(at > 0 ? doc.sliceString(at - 1, at) : "", doc.sliceString(at, at + 1));
  const insert = prefix + text.trim() + suffix;
  view.dispatch({
    changes: { from: at, insert },
    selection: { anchor: at + prefix.length + text.trim().length },
    scrollIntoView: true,
    userEvent: "input.ai",
  });
  toast(where === "end" ? t("已加到文件最後（可以按 Ctrl+Z 復原）") : t("已插入（可以按 Ctrl+Z 復原）"), { tone: "success" });
}

/** 回答下面的按鈕（圖示加文字）：複製、插入到游標處、加到文件最後。 */
function answerActions(el: HTMLElement, text: string): void {
  const bar = document.createElement("div");
  bar.className = "assistant-tools";
  bar.append(
    toolButton(t("複製"), "copy", () => void copy(text), t("複製")),
    toolButton(t("插入到游標處"), "clipboard-paste", () => insertIntoDoc(text, "cursor"), t("插入")),
    toolButton(t("加到文件最後"), "arrow-down-to-line", () => insertIntoDoc(text, "end"), t("加到最後")),
  );
  el.append(bar);
  blockActions(el, text);
}

/**
 * 回答裡的程式碼區塊、表格、流程圖：右上角各有「複製」「插入」，只拿那一塊。
 * 用預覽的 `data-sourcepos` 對回原文：複製程式碼只複製內容，插入時連同 ``` 一起插入（保留 Markdown）。
 */
function blockActions(el: HTMLElement, text: string): void {
  const lines = text.split("\n");
  const body = el.querySelector(".assistant-answer");
  if (!body) return;
  for (const block of body.querySelectorAll<HTMLElement>(":scope > pre[data-sourcepos], :scope > table[data-sourcepos]")) {
    const m = /^(\d+):\d+-(\d+):\d+$/.exec(block.dataset.sourcepos ?? "");
    if (!m) continue;
    const source = lines.slice(Number(m[1]) - 1, Number(m[2])).join("\n");
    if (!source.trim()) continue;
    const isCode = block.tagName === "PRE";
    const content = isCode ? (block.querySelector("code")?.textContent ?? block.textContent ?? "").replace(/\n$/, "") : source;
    const wrap = document.createElement("div");
    wrap.className = "assistant-block";
    block.replaceWith(wrap);
    const tools = document.createElement("div");
    tools.className = "assistant-block-tools";
    tools.append(
      toolButton(isCode ? t("複製程式碼") : t("複製表格"), "copy", () => void copy(content), t("複製")),
      toolButton(t("把這一塊插入到游標處"), "clipboard-paste", () => insertIntoDoc(source, "cursor"), t("插入")),
    );
    wrap.append(tools, block);
  }
}

/** 取代或插入的建議卡片：看過差異再套用。 */
function suggestionCard(el: HTMLElement, p: Pending, text: string): void {
  const r = p.range;
  const insert = p.mode === "insert";
  const next = p.mermaid ? mermaidBlock(text) : replacementText(text);
  const card = document.createElement("div");
  card.className = "assistant-card";
  const h = document.createElement("h4");
  h.textContent = insert
    ? r.from === r.to
      ? t("插入到游標處（建議）")
      : t("插入到選取的文字後面（建議）")
    : t("取代選取的文字（建議）");
  const diff = document.createElement("div");
  diff.className = "assistant-diff";
  const line = (cls: string, s: string) => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = s;
    return d;
  };
  diff.append(
    ...(insert ? [] : r.original.split("\n").map((s) => line("del", `- ${s}`))),
    ...next.split("\n").map((s) => line("add", `+ ${s}`)),
  );
  const bar = document.createElement("div");
  bar.className = "assistant-actions";
  const done = (message: string) => {
    bar.replaceChildren();
    const s = document.createElement("small");
    s.textContent = message;
    bar.append(s);
  };
  bar.append(
    cardButton(t("略過"), () => done(t("已略過"))),
    cardButton(t("複製"), () => void copy(next)),
    cardButton(
      t("套用"),
      () => {
        const view = app.editor.view;
        if (!writable(view)) return;
        if (r.to > view.state.doc.length || view.state.sliceDoc(r.from, r.to) !== r.original) {
          toast(t("選取的那段文字已經改過了，請重新選取再試一次"), { tone: "error" });
          return;
        }
        if (insert) {
          // 插在選取的文字（或游標）後面，前後空一行，插入的內容自成段落。
          const doc = view.state.doc;
          const { prefix, suffix } = insertPadding(r.to > 0 ? doc.sliceString(r.to - 1, r.to) : "", doc.sliceString(r.to, r.to + 1));
          view.dispatch({ changes: { from: r.to, insert: prefix + next + suffix }, userEvent: "input.ai" });
        } else view.dispatch({ changes: { from: r.from, to: r.to, insert: next }, userEvent: "input.ai" });
        done(t("已套用（可以按 Ctrl+Z 復原）"));
      },
      true,
    ),
  );
  card.append(h, diff, bar);
  el.append(card);
}

/** 第一次在這個專案送出：說明要送什麼、大約多少錢。 */
async function confirmFirst(chars: number, model: ClaudeModel): Promise<boolean> {
  const root = app.workspaceRoot!.path;
  if (listed(app.settings.value.assistantConfirmed, root)) return true;
  const what = [includeDoc ? docName() : null, selection().text.trim() ? t("選取的文字") : null, t("你的問題")].filter(Boolean).join(t("、"));
  const choice = await choose(
    t("要把內容送到 Anthropic 嗎？"),
    t("這次會送出：{what}（約 {n} 字），估計費用約 {usd}。這個專案之後送出不會再問。", {
      what,
      n: chars.toLocaleString(),
      usd: formatUsd(estimateUsd(chars, model)),
    }),
    [
      { id: "cancel", label: t("取消") },
      { id: "send", label: t("送出"), primary: true },
    ],
  );
  if (choice !== "send") return false;
  app.settings.update({ assistantConfirmed: toggled(app.settings.value.assistantConfirmed, root, true) });
  return true;
}

async function send(question: string, action: AssistantAction | null = null): Promise<void> {
  if (!desktop || pending || blocked()) return;
  question = question.trim();
  if (!question) return;
  const sel = selection();
  if (action?.needsSelection && !sel.text.trim()) {
    toast(t("請先選取要「{name}」的文字", { name: action.label() }));
    return;
  }
  let index: ProjectIndex | undefined;
  if (action?.needsIndex) {
    const docs = await indexedDocs().catch(() => []);
    index = projectIndex(
      docs.map((d) => ({ rel: d.rel, tags: d.info.tags })),
      docs.find((d) => d.path && d.path === app.cur.fileHandle?.path)?.rel ?? null,
    );
  }
  const mode = action?.mode ?? "answer";
  // 問整個專案（一般問答才用）：挑出和問題相關的筆記。
  let notes: NoteText[] | undefined;
  const project = askProject && mode === "answer";
  if (project) {
    const docs = (await indexedDocs().catch(() => [])).filter((d) => d.path !== app.cur.fileHandle?.path);
    const texts = await indexedTexts(docs).catch(() => []);
    notes = pickNotes(
      docs.map((d, i) => ({ rel: d.rel, text: texts[i] ?? "" })).filter((n) => n.text.trim()),
      question,
    );
    if (!notes.length) {
      toast(t("專案裡沒有可以讀的筆記"));
      return;
    }
  }
  // 今日簡報：整個專案還沒完成的待辦（不送目前的文件）。
  let tasks: { today: string; list: string } | undefined;
  if (action?.needsTasks) {
    const docs = await indexedDocs().catch(() => []);
    tasks = { today: todayLabel(new Date()), list: briefingTasks(docs.map((d) => ({ rel: d.rel, tasks: d.info.tasks }))) };
  }
  const ctx = {
    doc: includeDoc && !action?.needsTasks ? { name: docName(), text: app.editor.text } : null,
    selection: action?.needsTasks ? "" : sel.text,
    index,
    notes,
    tasks,
  };
  const content = userContent(question, ctx);
  const system = systemPrompt(mode, project);
  const model = app.settings.value.claudeModel;
  const images = attached.map(({ mediaType, data }) => ({ mediaType, data }));
  if (!(await confirmFirst(content.length + system.length + images.length * IMAGE_CHARS, model))) return;
  const shown = action ? action.label() : question;
  const userBubble = bubble("user", shown);
  for (const img of attached) {
    const thumb = document.createElement("img");
    thumb.className = "assistant-thumb";
    thumb.src = img.url;
    thumb.alt = img.name;
    userBubble.append(thumb);
  }
  attached = [];
  renderChips();
  if (notes) {
    const s = document.createElement("small");
    s.className = "assistant-scope";
    s.textContent = t("根據專案裡 {n} 篇筆記", { n: notes.length });
    s.title = notes.map((n) => n.name).join("\n");
    userBubble.append(s);
  }
  const answer = bubble("assistant");
  answer.classList.add("loading");
  answer.textContent = t("思考中…");
  const id = nextId++;
  pending = { id, answer, text: "", question, shown, sources: new Map(), mode, mermaid: !!action?.mermaid, range: { from: sel.from, to: sel.to, original: sel.text } };
  input.value = "";
  setRunning(true);
  try {
    // 會改文件的動作不接續之前的對話（只看這一次的內容）。
    const messages = conversation(mode === "answer" ? history : [], content);
    if (images.length) messages[messages.length - 1] = { ...messages[messages.length - 1], images };
    // 上網查只用在一般問答，而且設定裡要允許。
    const web = webSearch && mode === "answer" && app.settings.value.claudeWebSearch;
    await desktop.assistantSend(id, { model, system, messages, webSearch: web });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

function setRunning(on: boolean): void {
  sendBtn.replaceChildren(icon(on ? "circle-stop" : "corner-down-left"));
  sendBtn.title = on ? t("停止") : t("送出（Enter）");
  sendBtn.setAttribute("aria-label", sendBtn.title);
  renderNotice();
  sendBtn.disabled = on ? false : sendBtn.disabled;
}

function fail(message: string): void {
  if (!pending) return;
  pending.answer.classList.remove("loading");
  pending.answer.classList.add("error");
  pending.answer.textContent = message;
  pending = null;
  setRunning(false);
}

function onRun(e: AssistantRunEvent): void {
  const p = pending;
  if (!p || e.id !== p.id) return;
  if (e.kind === "delta") {
    p.text += e.text;
    p.answer.classList.remove("loading");
    showAnswer(p.answer, p.text);
    log.scrollTop = log.scrollHeight;
    return;
  }
  if (e.kind === "error") return fail(e.message);
  if (e.kind === "source") {
    p.sources.set(e.url, e.title);
    return;
  }
  pending = null;
  // 引用的網頁列在回答最後（也會跟著存成筆記、插入文件）。
  if (p.sources.size && p.text.trim()) {
    const list = [...p.sources].map(([url, title]) => `- [${title.replace(/[[\]]/g, "")}](${url})`);
    const heading = "**" + t("來源") + "**";
    p.text = [p.text.trimEnd(), heading, list.join("\n")].join("\n\n");
  }
  p.answer.classList.remove("loading");
  if (e.stop === "refusal" && !p.text.trim()) {
    p.answer.classList.add("error");
    p.answer.textContent = t("Claude 沒有回答這個要求。");
  } else {
    showAnswer(p.answer, p.text || t("（沒有回答）"));
    if (e.stop === "max_tokens" || e.stop === "pause_turn") {
      const s = document.createElement("small");
      s.className = "assistant-cut";
      s.textContent = e.stop === "max_tokens" ? t("回答太長，後面被截斷了。") : t("搜尋還沒做完，回答可能不完整；可以再問一次。");
      p.answer.append(s);
    }
    if (p.text.trim()) transcript.push({ question: p.shown, answer: p.text });
    saveBtn.disabled = !transcript.length;
    if (p.mode !== "answer" && p.text.trim()) suggestionCard(p.answer, p, p.text);
    else if (p.mode === "answer" && p.text.trim()) {
      answerActions(p.answer, p.text);
      history = [...history, { role: "user" as const, content: p.question }, { role: "assistant" as const, content: p.text }].slice(-12);
    }
  }
  if (usage) usage = { ...usage, usd: e.monthUsd };
  renderUsage();
  setRunning(false);
}

/** 讀進要附上的圖片：格式、大小、張數不對時提示，不送出。 */
async function attachFiles(files: File[]): Promise<void> {
  for (const f of files) {
    if (attached.length >= MAX_IMAGES) {
      toast(t("一次最多附 {n} 張圖片", { n: MAX_IMAGES }));
      break;
    }
    if (!(IMAGE_TYPES as readonly string[]).includes(f.type)) {
      toast(t("「{name}」不是 PNG、JPEG、GIF 或 WebP 圖片", { name: f.name || t("圖片") }), { tone: "error" });
      continue;
    }
    if (f.size > MAX_IMAGE_BYTES) {
      toast(t("「{name}」超過 5 MB", { name: f.name || t("圖片") }), { tone: "error" });
      continue;
    }
    const bytes = new Uint8Array(await f.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    attached.push({
      mediaType: f.type as AssistantImage["mediaType"],
      data: btoa(bin),
      name: f.name || t("貼上的圖片"),
      url: URL.createObjectURL(f),
    });
  }
  renderChips();
  input.focus();
}

/** 把這次對話存成專案裡的一份筆記，並打開它。 */
async function saveNote(): Promise<void> {
  const root = app.workspaceRoot;
  if (!desktop || !root || !transcript.length) return;
  const now = new Date();
  const text = transcriptMarkdown(transcript, now, includeDoc ? docName() : null);
  try {
    const path = await desktop.createEntry(root.path, noteName(now), false);
    app.fileListCache = null;
    app.indexStale = true;
    await app.fileTree?.refresh([root.path]);
    await openPath(path);
    if (app.cur.fileHandle?.path !== path || app.editor.text) return;
    app.editor.replaceAll(text, { isolate: true });
    await app.save(false);
    toast(t("已存成筆記「{name}」", { name: noteName(now) }), { tone: "success" });
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), { tone: "error" });
  }
}

function stop(): void {
  if (!pending) return;
  void desktop?.assistantCancel(pending.id);
  const p = pending;
  pending = null;
  p.answer.classList.remove("loading");
  if (p.text) showAnswer(p.answer, p.text);
  else p.answer.textContent = t("已停止");
  setRunning(false);
  void refreshStatus();
}

function newChat(): void {
  if (pending) stop();
  history = [];
  transcript = [];
  saveBtn.disabled = true;
  log.replaceChildren();
  input.focus();
}

/** 模型的短名稱（標題列放不下完整的說明）。 */
function shortModel(m: ClaudeModel): string {
  return m.replace(/^claude-(\w+)-(\d+)-(\d+)$/, (_, n: string, a, b) => `${n[0].toUpperCase()}${n.slice(1)} ${a}.${b}`);
}

function renderModel(): void {
  const m = app.settings.value.claudeModel;
  const name = document.createElement("span");
  name.textContent = shortModel(m);
  modelBtn.replaceChildren(name, icon("chevron-down"));
  modelBtn.title = t("模型：{name}（按一下換）", { name: MODEL_LABELS[m]() });
  modelBtn.setAttribute("aria-label", modelBtn.title);
}

function headButton(label: string, iconName: string, run: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn icon-only";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.append(icon(iconName));
  b.addEventListener("click", run);
  return b;
}


/** 助理的字級（和編輯區分開）：套用到側欄的 `--assistant-font`。 */
function applyFont(): void {
  panel?.style.setProperty("--assistant-font", `${app.settings.value.assistantFontSize}px`);
}

/** 放大（1）、縮小（-1）助理的字，0 是恢復預設；到上下限時說明。 */
export function changeAssistantFont(delta: number): void {
  const now = app.settings.value.assistantFontSize;
  const size = delta === 0 ? DEFAULT_SETTINGS.assistantFontSize : Math.min(ASSISTANT_FONT_RANGE.max, Math.max(ASSISTANT_FONT_RANGE.min, now + delta));
  if (size === now) {
    if (delta) toast(delta > 0 ? t("已經是最大的字級（{size}px）", { size }) : t("已經是最小的字級（{size}px）", { size }));
    return;
  }
  app.settings.update({ assistantFontSize: size });
}

function build(): HTMLElement {
  const aside = document.createElement("aside");
  aside.className = "assistant-panel";
  aside.id = "assistant-panel";
  aside.setAttribute("aria-label", t("助理"));
  aside.hidden = true;

  // 標題列：助理、模型（oMarker 的選單）、新對話、關閉。
  const head = document.createElement("div");
  head.className = "assistant-head";
  const title = document.createElement("h2");
  const titleText = document.createElement("span");
  titleText.className = "assistant-title-text";
  titleText.textContent = t("助理");
  title.append(icon("sparkles"), titleText);
  modelBtn = document.createElement("button");
  modelBtn.type = "button";
  modelBtn.id = "assistant-model";
  modelBtn.className = "assistant-model";
  setupMenu(
    modelBtn,
    null,
    CLAUDE_MODELS.map((m) => ({
      label: MODEL_LABELS[m](),
      checked: () => app.settings.value.claudeModel === m,
      run: () => app.settings.update({ claudeModel: m }),
    })),
  );
  renderModel();
  const spacer = document.createElement("span");
  spacer.className = "assistant-spacer";
  saveBtn = headButton(t("存成筆記"), "file-down", () => void saveNote());
  saveBtn.disabled = true;
  // 沒有自己的關閉鈕：助理是右側欄的一頁，切到別頁或收起右側欄就好。
  head.append(
    title,
    modelBtn,
    spacer,
    headButton(t("縮小助理的字（Ctrl+-）"), "a-arrow-down", () => changeAssistantFont(-1)),
    headButton(t("放大助理的字（Ctrl+=）"), "a-arrow-up", () => changeAssistantFont(1)),
    saveBtn,
    headButton(t("新對話"), "message-square-plus", newChat),
  );

  notice = document.createElement("div");
  notice.className = "assistant-notice";
  log = document.createElement("div");
  log.className = "assistant-log";
  log.setAttribute("aria-live", "polite");
  // 回答裡的連結用系統的瀏覽器開啟，不在編輯器裡換頁。
  log.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    // 出處 [[筆記名稱]]：在編輯器打開那份筆記。
    if (a.hasAttribute("data-wikilink")) return void openWiki(wikiTarget(a)).catch(() => toast(t("找不到這份筆記"), { tone: "error" }));
    if (/^https?:\/\//.test(a.href)) openUrl(a.href);
  });

  // 輸入框：上面是這次會送出的內容（小標籤），下緣是常用動作與送出。
  const box = document.createElement("div");
  box.className = "assistant-input";
  chips = document.createElement("div");
  chips.className = "assistant-chips";
  chips.setAttribute("aria-label", t("這次會送給 Claude 的內容"));
  input = document.createElement("textarea");
  input.rows = 2;
  input.placeholder = t("問助理…（Enter 送出、Shift+Enter 換行）");
  input.setAttribute("aria-label", t("問助理"));
  input.addEventListener("keydown", (e) => {
    // 注音、倉頡選字時的 Enter 不是送出。
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      void send(input.value);
    }
  });
  const bar = document.createElement("div");
  bar.className = "assistant-quick";
  for (const a of ASSISTANT_ACTIONS.filter((x) => x.group === "main")) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = a.label();
    b.title = a.needsSelection ? t("先選取文字") : a.prompt();
    b.addEventListener("click", () => void send(a.prompt(), a));
    bar.append(b);
  }
  // 其他動作放在「更多」選單（轉成簡報、流程圖、表格、待辦、續寫、換語氣），下面是設定裡的自訂動作。
  const more = document.createElement("button");
  more.type = "button";
  more.id = "assistant-write";
  more.className = "assistant-more";
  more.append(t("更多"), icon("chevron-down"));
  more.title = t("更多寫作動作");
  const item = (a: AssistantAction) => ({
    label: a.needsSelection ? t("{name}（選取的文字）", { name: a.label() }) : a.label(),
    run: () => void send(a.prompt(), a),
  });
  setupMenu(more, null, () => {
    const custom = customActions(app.settings.value.assistantActions);
    return [
      ...ASSISTANT_ACTIONS.filter((x) => x.group === "write").map(item),
      "-",
      ...(custom.length ? [{ heading: t("自訂動作") }, ...custom.map(item)] : []),
      { label: custom.length ? t("管理自訂動作…") : t("新增自訂動作…"), icon: "settings", run: () => settingsDialog.open(t("Claude API 助理")) },
    ];
  });
  sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "btn icon-only btn-primary assistant-send";
  sendBtn.addEventListener("click", () => (pending ? stop() : void send(input.value)));
  // 附圖片：按迴紋針選檔案，或直接在輸入框貼上。
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = IMAGE_TYPES.join(",");
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.addEventListener("change", () => {
    void attachFiles([...(fileInput.files ?? [])]);
    fileInput.value = "";
  });
  const attach = document.createElement("button");
  attach.type = "button";
  attach.className = "assistant-attach";
  attach.title = t("附上圖片（也可以直接貼上）");
  attach.setAttribute("aria-label", attach.title);
  attach.append(icon("paperclip"));
  attach.addEventListener("click", () => fileInput.click());
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    void attachFiles(files);
  });
  bar.append(more, attach, fileInput, sendBtn);
  box.append(chips, input, bar);
  box.addEventListener("click", (e) => {
    if (e.target === box) input.focus();
  });

  // 最下面一行小字：說明與本月費用。
  const foot = document.createElement("div");
  foot.className = "assistant-foot";
  const note = document.createElement("span");
  note.textContent = t("送到 Anthropic・修改要按「套用」");
  note.title = t("內容會送到 Anthropic（Claude API）。修改都要你按「套用」。");
  usageEl = document.createElement("span");
  usageEl.className = "assistant-usage";
  foot.append(note, usageEl);

  aside.append(head, notice, log, box, foot);
  // 滑鼠移進來時更新選取的字數；內容沒變不重畫（重畫會讓剛好按下去的標籤按鈕失效）。
  aside.addEventListener("pointerenter", () => {
    if (chipsKey() !== shownChips) renderChips();
  });
  // 焦點在助理裡時，Ctrl+= / Ctrl+- / Ctrl+0 調整助理的字，不動編輯區的字級。
  aside.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const delta = e.key === "=" || e.key === "+" ? 1 : e.key === "-" ? -1 : e.key === "0" ? 0 : null;
    if (delta === null) return;
    e.preventDefault();
    e.stopPropagation();
    changeAssistantFont(delta);
  });
  // 視窗不夠寬時右側欄是蓋在文件上的抽屜：Esc 收起。
  aside.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented && drawerQuery.matches) {
      e.preventDefault();
      toggleAssistant(false);
    }
  });
  return aside;
}

/**
 * 助理的面板（右側欄的一頁，app/right-tabs.ts 放進右側欄並控制顯示）。`create` 為 false 時只回傳已經建好的，
 * 還沒建就是 null：第一次要顯示時才建立。
 */
export function assistantPanel(create: true): HTMLElement;
export function assistantPanel(create: boolean): HTMLElement | null;
export function assistantPanel(create: boolean): HTMLElement | null {
  if (!panel && create && desktop) {
    panel = build();
    applyFont();
    setRunning(false);
  }
  return panel;
}

/** 助理這一頁顯示出來了（切到這頁、打開右側欄）：更新內容，游標放進輸入框。 */
export function assistantShown(): void {
  if (!panel) return;
  renderModel();
  renderChips();
  renderNotice();
  void refreshStatus();
  input.focus();
}

/** 打開（右側欄切到「助理」，收著就打開）或關閉（切到右側欄的別頁；沒有別頁就收起右側欄）。 */
export function toggleAssistant(open = !assistantOpen()): void {
  if (!desktop || !assistantEnabled()) return;
  if (open) {
    if (!app.rightOutlineShown) setRightOutline(true);
    selectRightTab("assistant");
    return;
  }
  const other = availableRightTabs().find((tab) => tab !== "assistant");
  if (other && !drawerQuery.matches) selectRightTab(other);
  else setRightOutline(false);
  app.editor.view.focus();
}

/** 常用動作（指令面板用）：打開側欄並執行。 */
export function runAssistantAction(id: AssistantAction["id"]): void {
  const action = [...ASSISTANT_ACTIONS, ...customActions(app.settings.value.assistantActions)].find((a) => a.id === id);
  if (!action) return;
  toggleAssistant(true);
  // 第一次打開時要先知道有沒有金鑰，否則會被當成還沒設定而不送出。
  void refreshStatus().then(() => send(action.prompt(), action));
}

export function initAssistant(): void {
  if (!desktop) return;
  void desktop.onAssistantRun(onRun);
  // 切換分頁、選取文字時更新「這次會送出的內容」。
  let timer = 0;
  document.addEventListener("selectionchange", () => {
    if (!assistantOpen()) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => (renderChips(), renderNotice()), 200);
  });
  app.settings.subscribe((_s, changed) => {
    if (!panel) return;
    if (changed.includes("claudeModel")) renderModel();
    if (changed.includes("assistantFontSize")) applyFont();
    if (changed.some((k) => k === "claudeApiEnabled" || k === "assistantProjects" || k === "claudeMonthlyLimit")) void refreshStatus();
    // 開關改了：右側欄的分頁跟著出現或消失（關掉時正在看助理的話，右側欄會換到別頁或收起）。
    if (changed.includes("claudeApiEnabled")) app.applyLayout();
  });
}

/** 指令面板的「助理：自訂動作…」：打開助理和「更多」選單。 */
export function openAssistantMore(): void {
  toggleAssistant(true);
  panel?.querySelector<HTMLButtonElement>("#assistant-write")?.click();
}

/** 設定改了金鑰之後（設定頁呼叫）。 */
export function assistantKeyChanged(): void {
  if (panel) void refreshStatus();
}
