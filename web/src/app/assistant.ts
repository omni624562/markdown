/**
 * Claude API 助理側欄（桌面版，預設關閉，只在私人電腦使用）。
 *
 * 三層保護：設定的總開關（預設關閉，原生端開啟時再確認一次）、每個專案各自允許（新專案預設不允許）、
 * Azure DevOps／GitHub 的工作項目、Wiki 一律不送（原生端也會擋 Azure DevOps 的儲存庫）。
 * 每個專案第一次送出前先確認要送什麼、大約多少錢；修改文件一律變成建議卡片，由使用者按「套用」。
 * API 金鑰只存在原生端，這裡只知道有沒有設定。
 */
import { render as renderMarkdown } from "../../pkg/md_wasm.js";
import {
  type ActionMode,
  ASSISTANT_ACTIONS,
  type AssistantAction,
  MODEL_LABELS,
  conversation,
  customActions,
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
import { type AssistantMessage, type AssistantRunEvent, type AssistantUsage, desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { CLAUDE_MODELS, type ClaudeModel } from "../settings.ts";
import * as storage from "../storage.ts";
import { choose } from "../ui/choice.ts";
import { icon } from "../ui/icons.ts";
import { setupMenu } from "../ui/menu.ts";
import { toast } from "../ui/toast.ts";
import { openUrl } from "./activity-bar.ts";
import { app } from "./context.ts";
import { docName as tabName } from "./doc-names.ts";

const OPEN_KEY = "assistant-open";
const WIDTH_KEY = "assistant-width";
/** 寬度的範圍（拖曳左緣調整）。 */
const MIN_WIDTH = 280;
const MAX_WIDTH = 640;

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
let pending: Pending | null = null;
let nextId = 1;
let includeDoc = true;
let usage: AssistantUsage | null = null;
let hasKey = false;

/** 設定裡開了 Claude API 助理（桌面版才有）。 */
export function assistantEnabled(): boolean {
  return !!desktop && app.settings.value.claudeApiEnabled;
}

export function assistantOpen(): boolean {
  return !!panel && !panel.hidden;
}

/** 目前不能送出的原因；可以送出時是 null。 */
function blocked(): { message: string; action?: { label: string; run: () => void } } | null {
  if (!assistantEnabled()) {
    return { message: t("Claude API 助理還沒開啟。"), action: { label: t("打開設定"), run: () => app.settingsDialog.open(t("Claude API 助理")) } };
  }
  if (!hasKey) {
    return { message: t("還沒有輸入 Claude API 金鑰。"), action: { label: t("打開設定"), run: () => app.settingsDialog.open(t("Claude API 助理")) } };
  }
  if (app.issueView.shownKey || app.active.wiki) {
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
function renderChips(): void {
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
  const sel = selection().text;
  if (sel.trim()) chip(t("選取 {n} 字", { n: sel.length }), "text-cursor");
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
  body.innerHTML = renderMarkdown(text, { kind: "markdown" }).html;
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

function toolButton(label: string, iconName: string, run: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "assistant-tool";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.append(icon(iconName));
  b.addEventListener("click", run);
  return b;
}

/** 一般回答下面的小圖示：複製、插入到游標的位置（滑鼠移上去看說明）。 */
function answerActions(el: HTMLElement, text: string): void {
  const bar = document.createElement("div");
  bar.className = "assistant-tools";
  bar.append(
    toolButton(t("複製"), "copy", () => void copy(text)),
    toolButton(t("插入到游標處"), "text-cursor-input", () => {
      const at = app.editor.view.state.selection.main.head;
      app.editor.view.dispatch({ changes: { from: at, insert: text }, userEvent: "input.ai" });
      toast(t("已插入（可以按 Ctrl+Z 復原）"), { tone: "success" });
    }),
  );
  el.append(bar);
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
  const ctx = { doc: includeDoc ? { name: docName(), text: app.editor.text } : null, selection: sel.text };
  const content = userContent(question, ctx);
  const mode = action?.mode ?? "answer";
  const system = systemPrompt(mode);
  const model = app.settings.value.claudeModel;
  if (!(await confirmFirst(content.length + system.length, model))) return;
  const shown = action ? action.label() : question;
  bubble("user", shown);
  const answer = bubble("assistant");
  answer.classList.add("loading");
  answer.textContent = t("思考中…");
  const id = nextId++;
  pending = { id, answer, text: "", question, mode, mermaid: !!action?.mermaid, range: { from: sel.from, to: sel.to, original: sel.text } };
  input.value = "";
  setRunning(true);
  try {
    // 會改文件的動作不接續之前的對話（只看這一次的內容）。
    await desktop.assistantSend(id, { model, system, messages: conversation(mode === "answer" ? history : [], content) });
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
  pending = null;
  p.answer.classList.remove("loading");
  if (e.stop === "refusal" && !p.text.trim()) {
    p.answer.classList.add("error");
    p.answer.textContent = t("Claude 沒有回答這個要求。");
  } else {
    showAnswer(p.answer, p.text || t("（沒有回答）"));
    if (e.stop === "max_tokens") {
      const s = document.createElement("small");
      s.className = "assistant-cut";
      s.textContent = t("回答太長，後面被截斷了。");
      p.answer.append(s);
    }
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
  log.replaceChildren();
  input.focus();
}

/** 模型的短名稱（標題列放不下完整的說明）。 */
function shortModel(m: ClaudeModel): string {
  return m.replace(/^claude-(\w+)-(\d+)-(\d+)$/, (_, n: string, a, b) => `${n[0].toUpperCase()}${n.slice(1)} ${a}.${b}`);
}

function renderModel(): void {
  const m = app.settings.value.claudeModel;
  modelBtn.replaceChildren(shortModel(m), icon("chevron-down"));
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

function applyWidth(px: number): number {
  const w = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, px)));
  document.documentElement.style.setProperty("--assistant-width", `${w}px`);
  return w;
}

/** 左緣的把手：拖曳調整寬度，記住；鍵盤用左右鍵。 */
function resizer(): HTMLElement {
  const grip = document.createElement("div");
  grip.className = "assistant-resizer";
  grip.role = "separator";
  grip.tabIndex = 0;
  grip.setAttribute("aria-orientation", "vertical");
  grip.setAttribute("aria-label", t("調整助理寬度"));
  grip.title = t("拖曳調整寬度");
  const width = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--assistant-width")) || 360;
  const save = () => storage.save(WIDTH_KEY, String(Math.round(width())));
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const start = e.clientX;
    const startWidth = width();
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => applyWidth(startWidth + start - ev.clientX);
    const up = () => {
      grip.removeEventListener("pointermove", move);
      document.body.classList.remove("resizing");
      save();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up, { once: true });
    grip.addEventListener("pointercancel", up, { once: true });
  });
  grip.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    applyWidth(width() + (e.key === "ArrowLeft" ? 20 : -20));
    save();
  });
  return grip;
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
  title.append(icon("sparkles"), t("助理"));
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
  head.append(title, modelBtn, spacer, headButton(t("新對話"), "message-square-plus", newChat), headButton(t("關閉助理"), "x", () => toggleAssistant(false)));

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
      { label: custom.length ? t("管理自訂動作…") : t("新增自訂動作…"), icon: "settings", run: () => app.settingsDialog.open(t("Claude API 助理")) },
    ];
  });
  sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "btn icon-only btn-primary assistant-send";
  sendBtn.addEventListener("click", () => (pending ? stop() : void send(input.value)));
  bar.append(more, sendBtn);
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

  aside.append(resizer(), head, notice, log, box, foot);
  aside.addEventListener("pointerenter", renderChips);
  // 窄視窗時助理蓋在文件上：Esc 收起。
  aside.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented && window.matchMedia("(max-width: 900px)").matches) {
      e.preventDefault();
      toggleAssistant(false);
    }
  });
  return aside;
}

export function toggleAssistant(open = !assistantOpen()): void {
  if (!desktop) return;
  if (!panel) {
    const saved = Number(storage.load(WIDTH_KEY));
    if (saved) applyWidth(saved);
    panel = build();
    // 自己一欄：從最上面（和分頁列同高）到狀態列上面，分頁列只到編輯區為止。
    document.body.append(panel);
    setRunning(false);
  }
  panel.hidden = !open;
  document.body.classList.toggle("assistant-open", open);
  storage.save(OPEN_KEY, open ? "1" : "");
  if (!open) return app.editor.view.focus();
  renderModel();
  renderChips();
  renderNotice();
  void refreshStatus();
  input.focus();
}

/** 常用動作（指令面板用）：打開側欄並執行。 */
export function runAssistantAction(id: AssistantAction["id"]): void {
  const action = [...ASSISTANT_ACTIONS, ...customActions(app.settings.value.assistantActions)].find((a) => a.id === id);
  if (!action) return;
  toggleAssistant(true);
  void send(action.prompt(), action);
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
  app.settings.subscribe((s, changed) => {
    if (!panel) return;
    if (changed.includes("claudeModel")) renderModel();
    if (changed.some((k) => k === "claudeApiEnabled" || k === "assistantProjects" || k === "claudeMonthlyLimit")) void refreshStatus();
    // 關掉總開關時收起側欄。
    if (changed.includes("claudeApiEnabled") && !s.claudeApiEnabled) toggleAssistant(false);
  });
  if (storage.load(OPEN_KEY) === "1" && assistantEnabled()) toggleAssistant(true);
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
