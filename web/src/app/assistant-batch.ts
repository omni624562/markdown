/**
 * 助理的批次處理（畫面）：把一個動作（摘要、審稿、自訂動作）套用到資料夾裡的每一份 Markdown 文件。
 *
 * - 入口：檔案樹資料夾的右鍵選單、指令面板的「助理：批次處理資料夾…」。先開對話框選動作，
 *   看得到會處理幾份文件、估計的費用、結果存在哪裡，按「送出批次」才送。
 * - 批次在 Anthropic 那邊處理（通常幾分鐘到一小時），費用是平常的一半。助理面板最下面的「批次」
 *   按鈕列出送出過的批次與狀態；還在處理的每分鐘問一次，處理完就把結果存成原檔旁邊的新檔
 *   （`行程.摘要.md`），不動原檔。程式關掉也沒關係，下次打開再領。
 *
 * 規則（哪些動作、哪些檔案、檔名）在 assistant-batch.ts；送出與領結果在 desktop/src/assistant_batch.rs。
 */
import { BATCH_MAX_FILES, batchActions, batchEstimateUsd, batchFiles, batchSuffix, inFolder } from "../assistant-batch.ts";
import { ASSISTANT_ACTIONS, type AssistantAction, customActions, formatUsd, listed, systemPrompt, userContent } from "../assistant-text.ts";
import { type AssistantBatch, desktop, type Entry, isRemote } from "../desktop.ts";
import { t } from "../i18n.ts";
import { icon } from "../ui/icons.ts";
import { placeMenu } from "../ui/menu-place.ts";
import { wasOpenOnPress } from "../ui/popover-toggle.ts";
import { toast } from "../ui/toast.ts";
import { app } from "./context.ts";
import { assistantEnabled, assistantKeyChanged, toggleAssistant } from "./assistant.ts";
import { indexedDocs, indexedTexts, openPath } from "./workspace-ui.ts";

/** 還在處理的批次多久問一次狀態。 */
const POLL_MS = 60_000;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const baseName = (path: string) => path.replace(/[\\/]+$/, "").replace(/^.*[\\/]/, "");

// ---- 能不能用 ----

/** 這個資料夾可以整批送給助理嗎？（助理開著、專案允許 AI、不是遠端資料夾） */
function allowed(): boolean {
  const root = app.workspaceRoot?.path;
  return !!desktop && assistantEnabled() && !!root && !isRemote(root) && listed(app.settings.value.assistantProjects, root);
}

/** 檔案樹資料夾右鍵選單的項目。 */
export function batchMenuItems(entry: Entry): { label: string; when?: () => boolean; run(): void }[] {
  return [{ label: t("助理：批次處理這個資料夾…"), when: allowed, run: () => void openBatchDialog(entry.path) }];
}

/** 指令面板：處理目前文件所在的資料夾（沒有就是整個專案）。 */
export function batchCommandReady(): boolean {
  return allowed();
}
export function runBatchCommand(): void {
  const root = app.workspaceRoot?.path;
  if (!root) return;
  const file = app.cur.fileHandle?.path;
  const dir = file ? file.replace(/[\\/][^\\/]*$/, "") : "";
  void openBatchDialog(dir && (dir === root || dir.startsWith(root)) ? dir : root);
}

// ---- 送出的對話框 ----

const actions = (): AssistantAction[] => batchActions([...ASSISTANT_ACTIONS, ...customActions(app.settings.value.assistantActions)]);

/** 選動作、看範圍與費用，按「送出批次」才送。 */
export async function openBatchDialog(folder: string): Promise<void> {
  if (!desktop || !allowed()) return;
  const list = actions();
  const dialog = el("dialog", "choice batch-dialog");
  dialog.setAttribute("aria-labelledby", "batch-title");
  const title = el("h2", "", t("批次處理「{name}」", { name: baseName(folder) }));
  title.id = "batch-title";
  const form = el("form", "pdf-form");
  form.method = "dialog";
  const field = el("label", "pdf-field");
  const select = el("select");
  select.name = "action";
  for (const a of list) select.append(new Option(a.label(), a.id));
  field.append(el("span", "", t("要做什麼")), select);
  const scope = el("p", "batch-scope", t("讀取中…"));
  const cost = el("p", "batch-cost");
  const where = el("p", "pdf-hint");
  const note = el(
    "p",
    "pdf-hint",
    t("文件內容會送到 Anthropic（Claude API）。批次在背景處理，通常幾分鐘到一小時，費用是平常的一半；可以關掉程式，下次打開會自動領結果。"),
  );
  const buttons = el("div", "choice-actions");
  const cancel = el("button", "btn", t("取消"));
  cancel.type = "button";
  const send = el("button", "btn btn-primary", t("送出批次"));
  send.disabled = true;
  buttons.append(cancel, send);
  form.append(field, scope, cost, where, note, buttons);
  dialog.append(title, form);

  const model = app.settings.value.claudeModel;
  let docs: Awaited<ReturnType<typeof indexedDocs>> = [];
  let texts: string[] = [];
  let loaded = false;
  const chosen = () => list.find((a) => a.id === select.value) ?? list[0];
  const suffix = () => batchSuffix(chosen().label(), t("結果"));
  /** 這個動作要處理的文件與內容（空白的文件不送）。 */
  const picked = () => {
    const files = batchFiles(docs, folder, suffix());
    return files.map((d) => ({ path: d.path, text: texts[docs.indexOf(d)] ?? "" })).filter((f) => f.text.trim());
  };
  const render = () => {
    where.textContent = t("結果存成原檔旁邊的新檔（例如「{name}」），不會改到原檔。", { name: [t("筆記"), suffix(), "md"].join(".") });
    if (!loaded) return;
    const files = picked();
    const chars = files.map((f) => f.text.length);
    const total = chars.reduce((a, b) => a + b, 0);
    if (!files.length) {
      scope.textContent = t("這個資料夾（含子資料夾）裡沒有可以處理的 Markdown 文件。");
      cost.textContent = "";
    } else if (files.length > BATCH_MAX_FILES) {
      scope.textContent = t("這個資料夾有 {n} 份文件，一次最多處理 {max} 份；請選小一點的資料夾。", { n: files.length, max: BATCH_MAX_FILES });
      cost.textContent = "";
    } else {
      scope.textContent = t("會處理這個資料夾（含子資料夾）裡的 {n} 份 Markdown 文件，共約 {chars} 字。", { n: files.length, chars: total.toLocaleString() });
      cost.textContent = t("估計費用約 {usd}（{model}）", { usd: formatUsd(batchEstimateUsd(chars, model)), model });
    }
    send.disabled = !files.length || files.length > BATCH_MAX_FILES;
  };
  select.addEventListener("change", render);
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (send.disabled) return;
    const action = chosen();
    const items = picked().map((f) => ({
      path: f.path,
      content: userContent(action.prompt(), { doc: { name: baseName(f.path), text: f.text }, selection: "" }),
    }));
    send.disabled = true;
    send.textContent = t("送出中…");
    void desktop!
      .assistantBatchCreate({ model, system: systemPrompt("answer"), folder, action: action.label(), suffix: suffix(), items })
      .then((batch) => {
        dialog.close();
        upsert(batch);
        toast(t("已送出批次：{n} 份文件。處理完會存成原檔旁邊的新檔；進度在助理面板下方的「批次」。", { n: batch.total }), { tone: "success", duration: 8000 });
        schedule();
      })
      .catch((e) => {
        send.disabled = false;
        send.textContent = t("送出批次");
        scope.textContent = message(e);
        scope.classList.add("error");
      });
  });
  if (!list.length) {
    scope.textContent = t("沒有可以整批做的動作。");
    select.disabled = true;
  }
  document.body.append(dialog);
  dialog.showModal();
  render();
  select.focus();
  if (!list.length) return;
  // 先顯示對話框和「讀取中…」，文件讀到了再填上份數與費用。
  try {
    const all = await indexedDocs();
    // 只讀這個資料夾裡的文件（不必把整個專案讀進來）。
    docs = all.filter((d) => !!d.path && inFolder(d.path, folder));
    texts = await indexedTexts(docs);
    loaded = true;
    render();
  } catch (e) {
    scope.textContent = message(e);
    scope.classList.add("error");
  }
}

// ---- 批次清單 ----

let batches: AssistantBatch[] = [];
let button: HTMLButtonElement | null = null;
let pop: HTMLElement | null = null;
let timer = 0;
let checking = false;

function upsert(batch: AssistantBatch): void {
  const i = batches.findIndex((b) => b.id === batch.id);
  if (i < 0) batches = [batch, ...batches];
  else batches = batches.map((b) => (b.id === batch.id ? batch : b));
  renderButton();
  renderList();
}

/** 一個批次現在的狀態（一行字）。 */
function statusText(b: AssistantBatch): string {
  if (b.state === "processing") {
    if (b.needsFolder) return t("處理完了；打開「{name}」資料夾後會領取結果", { name: baseName(b.needsFolder) });
    if (b.canceling) return t("取消中…");
    return t("處理中（已完成 {done}／{total}）", { done: b.finished, total: b.total });
  }
  const parts = [t("寫了 {n} 個檔案", { n: b.written })];
  if (b.failed) parts.push(t("{n} 份沒有結果", { n: b.failed }));
  parts.push(formatUsd(b.usd));
  return (b.state === "canceled" ? t("已取消：") : t("已完成：")) + parts.join(t("、"));
}

function renderButton(): void {
  if (!button) return;
  const running = batches.filter((b) => b.state === "processing").length;
  button.hidden = !batches.length;
  button.textContent = running ? t("批次（{n} 個處理中）", { n: running }) : t("批次");
  button.title = t("批次處理的進度與結果");
}

function renderList(): void {
  if (!pop?.matches(":popover-open")) return;
  const head = el("h3", "", t("批次處理"));
  const rows = batches.map((b) => {
    const row = el("div", "batch-row");
    row.dataset.state = b.state;
    const main = el("div", "batch-main");
    main.append(
      el("strong", "", t("{action}・{folder}", { action: b.action, folder: baseName(b.folder) })),
      el("small", "", t("{n} 份文件・{when}", { n: b.total, when: b.created })),
      el("span", "batch-status", statusText(b)),
    );
    if (b.outputs?.length) main.append(outputsList(b));
    const act = el("button", "btn btn-small", b.state === "processing" ? t("取消") : t("移除"));
    act.type = "button";
    act.disabled = b.state === "processing" && b.canceling;
    act.addEventListener("click", () => void (b.state === "processing" ? cancel(b) : remove(b)));
    main.title = `${b.action}\n${b.folder}`;
    // 已經處理完、只是等著打開資料夾領結果的：沒有東西可以取消。
    row.append(main, ...(b.needsFolder ? [] : [act]));
    return row;
  });
  const empty = el("p", "usage-loading", t("還沒有送出過批次。在檔案面板的資料夾上按右鍵 →「助理：批次處理這個資料夾…」。"));
  const refresh = el("button", "btn btn-small", t("重新整理"));
  refresh.type = "button";
  refresh.addEventListener("click", () => void checkAll());
  pop.replaceChildren(head, ...(rows.length ? rows : [empty]), ...(batches.some((b) => b.state === "processing") ? [refresh] : []));
  place();
}

/** 展開著結果檔清單的批次（重畫清單時保持展開）。 */
const expanded = new Set<string>();

/** 做完的批次寫出來的結果檔：可以打開來看，不要的移到資源回收筒。 */
function outputsList(b: AssistantBatch): HTMLElement {
  const box = el("details", "batch-outputs");
  box.open = expanded.has(b.id);
  box.addEventListener("toggle", () => {
    if (box.open) expanded.add(b.id);
    else expanded.delete(b.id);
    place();
  });
  box.append(el("summary", "", t("結果檔（{n}）", { n: b.outputs.length })));
  for (const path of b.outputs) {
    const row = el("div", "batch-output");
    const open = el("button", "batch-output-name", baseName(path));
    open.type = "button";
    open.title = t("開啟 {path}", { path });
    open.addEventListener("click", () => {
      pop?.hidePopover();
      void openPath(path).catch((e) => toast(message(e), { tone: "error" }));
    });
    const trash = el("button", "assistant-tool");
    trash.type = "button";
    trash.title = t("移到資源回收筒");
    trash.setAttribute("aria-label", t("把 {name} 移到資源回收筒", { name: baseName(path) }));
    trash.append(icon("trash"));
    trash.addEventListener("click", () => void discard(b, path));
    row.append(open, trash);
    box.append(row);
  }
  return box;
}

/** 不要的結果檔移到資源回收筒（救得回來），並從清單拿掉。 */
async function discard(b: AssistantBatch, path: string): Promise<void> {
  try {
    await desktop!.trashEntry(path);
  } catch (e) {
    toast(message(e), { tone: "error" });
    return;
  }
  upsert({ ...b, outputs: b.outputs.filter((p) => p !== path) });
  const root = app.workspaceRoot?.path;
  app.fileListCache = null;
  app.indexStale = true;
  if (root) void app.fileTree?.refresh([root]);
}

function place(): void {
  if (!pop?.matches(":popover-open") || !button) return;
  pop.style.maxHeight = "";
  const anchor = button.getBoundingClientRect();
  const { width, height } = pop.getBoundingClientRect();
  const p = placeMenu(anchor, { width, height }, { width: innerWidth, height: innerHeight });
  Object.assign(pop.style, { left: `${p.left}px`, top: `${p.top}px`, maxHeight: `${p.maxHeight}px` });
}

async function cancel(b: AssistantBatch): Promise<void> {
  try {
    upsert(await desktop!.assistantBatchCancel(b.id));
    toast(t("已要求取消；已經做完的部分照樣會存成檔案。"));
  } catch (e) {
    toast(message(e), { tone: "error" });
  }
}

async function remove(b: AssistantBatch): Promise<void> {
  await desktop!.assistantBatchRemove(b.id).catch(() => {});
  batches = batches.filter((x) => x.id !== b.id);
  renderButton();
  renderList();
}

/** 剛領完結果：通知、重新整理檔案清單與用量。 */
function finished(b: AssistantBatch): void {
  const root = app.workspaceRoot?.path;
  app.fileListCache = null;
  app.indexStale = true;
  if (root) void app.fileTree?.refresh([root]);
  assistantKeyChanged();
  toast(t("批次「{action}・{folder}」{status}", { action: b.action, folder: baseName(b.folder), status: statusText(b) }), {
    tone: b.written ? "success" : "error",
    duration: 10000,
  });
}

/** 問每一個還在處理的批次；處理完的會在這裡領結果。 */
async function checkAll(): Promise<void> {
  if (!desktop || checking) return;
  checking = true;
  try {
    for (const b of batches.filter((x) => x.state === "processing")) {
      try {
        const next = await desktop.assistantBatchCheck(b.id);
        upsert(next);
        if (next.justDone) finished(next);
      } catch {
        // 連不上、金鑰拿掉了：下次再問。
      }
    }
  } finally {
    checking = false;
    schedule();
  }
}

function schedule(): void {
  window.clearTimeout(timer);
  if (batches.some((b) => b.state === "processing")) timer = window.setTimeout(() => void checkAll(), POLL_MS);
}

/** 打開批次清單（指令面板用）：先打開助理面板。 */
export function openBatchList(): void {
  toggleAssistant(true);
  if (!button) return;
  button.hidden = false;
  button.click();
}

/** 助理面板最下面的「批次」按鈕（有送出過批次才顯示）。 */
export function initBatchButton(node: HTMLButtonElement): void {
  button = node;
  node.setAttribute("aria-haspopup", "dialog");
  node.setAttribute("aria-expanded", "false");
  const wasOpen = wasOpenOnPress(node, () => pop);
  node.addEventListener("click", () => {
    if (wasOpen()) {
      if (pop?.matches(":popover-open")) pop.hidePopover();
      return;
    }
    if (!pop) {
      pop = el("div", "stats-pop usage-pop batch-pop");
      pop.popover = "auto";
      pop.tabIndex = -1;
      pop.setAttribute("role", "dialog");
      pop.setAttribute("aria-label", t("批次處理"));
      pop.addEventListener("toggle", (e) => node.setAttribute("aria-expanded", String((e as ToggleEvent).newState === "open")));
      document.body.append(pop);
    }
    pop.showPopover();
    renderList();
    pop.focus({ preventScroll: true });
    void checkAll();
  });
  renderButton();
}

/** 啟動時讀出送出過的批次；還在處理的馬上問一次（上次關掉程式之後可能已經做完了）。 */
export async function initAssistantBatch(): Promise<void> {
  if (!desktop) return;
  try {
    batches = (await desktop.assistantBatchList()) ?? [];
  } catch {
    return;
  }
  renderButton();
  if (batches.some((b) => b.state === "processing")) void checkAll();
}

/** 換了資料夾：等著領結果的批次（要先打開送出時的資料夾）再問一次。 */
export function batchFolderChanged(): void {
  if (batches.some((b) => b.state === "processing")) void checkAll();
}
