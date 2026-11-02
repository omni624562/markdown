/**
 * 工作板上的編輯：改卡片的指派與工時、在某個上層項目底下新增 Task（放進目前的 Sprint）。
 * 改好後由呼叫的人重新讀取工作板。
 */
import { type AdoTeam, type AdoTeamMember, desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import type { BoardItem } from "../taskboard-model.ts";
import { toast } from "../ui/toast.ts";
import { app } from "./context.ts";
import { withOfflineCopy } from "./offline-copies.ts";

export interface BoardScope {
  project: string;
  team: AdoTeam;
  /** Sprint 的路徑（新增的 Task 放這裡）。 */
  iterationPath: string;
}

/** 團隊成員（有副本就先用副本）。 */
function members(s: BoardScope): Promise<AdoTeamMember[]> {
  return withOfflineCopy(`members:${s.project}/${s.team.id}`, () => desktop!.adoTeamMembers(s.project, s.team.name), () => {}, true).catch(
    () => [],
  );
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  const l = document.createElement("label");
  l.className = "pdf-field";
  l.append(Object.assign(document.createElement("span"), { textContent: label }), control);
  return l;
}

function hoursInput(value: number | null | undefined): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.step = "0.5";
  input.inputMode = "decimal";
  input.value = typeof value === "number" ? String(value) : "";
  return input;
}

/** 輸入框的工時：空白是 `null`（不改），不是數字或小於 0 是 `NaN`。 */
function hoursOf(input: HTMLInputElement): number | null {
  const v = input.value.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

/** 指派的下拉選單：沒有指派、團隊成員；目前指派的人不在團隊裡也列出來。 */
function assigneeSelect(current: string | null, list: AdoTeamMember[], unique: string | null): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.append(new Option(t("沒有指派"), ""));
  for (const m of list) sel.append(new Option(m.name, m.unique));
  if (current && !list.some((m) => m.name === current)) sel.append(new Option(current, unique ?? current));
  sel.value = current ? (list.find((m) => m.name === current)?.unique ?? unique ?? current) : "";
  return sel;
}

/** 對話框的骨架：標題、欄位、錯誤訊息、取消／確定；`submit` 回傳 false 表示留著對話框。 */
function dialog(title: string, okLabel: string, fields: HTMLElement[], submit: (error: HTMLElement) => Promise<boolean>): HTMLDialogElement {
  const d = document.createElement("dialog");
  d.className = "choice tb-edit-dialog";
  const form = document.createElement("form");
  form.method = "dialog";
  const error = document.createElement("p");
  error.className = "wi-create-error";
  error.hidden = true;
  const actions = document.createElement("div");
  actions.className = "choice-actions";
  const cancel = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: t("取消") });
  cancel.addEventListener("click", () => d.close());
  const ok = Object.assign(document.createElement("button"), { type: "submit", className: "btn btn-primary", textContent: okLabel });
  actions.append(cancel, ok);
  form.append(Object.assign(document.createElement("h2"), { textContent: title }), ...fields, error, actions);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    ok.disabled = true;
    error.hidden = true;
    void submit(error)
      .then((done) => {
        if (done) d.close();
      })
      .catch((err) => {
        error.hidden = false;
        error.textContent = err instanceof Error ? err.message : String(err);
      })
      .finally(() => (ok.disabled = false));
  });
  d.append(form);
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

/** 改卡片的指派與工時。 */
export async function editCard(w: BoardItem, s: BoardScope, done: (id: number) => void): Promise<void> {
  if (!desktop) return;
  const list = await members(s);
  const who = assigneeSelect(w.assignedTo, list, null);
  const remaining = hoursInput(w.remaining);
  const completed = hoursInput(w.completed);
  const row = document.createElement("div");
  row.className = "wi-create-row";
  row.append(field(t("剩餘工時"), remaining), field(t("已完成工時"), completed));
  dialog(t("{kind} {id}：{title}", { kind: w.kind, id: w.id, title: w.title }), t("儲存"), [field(t("指派給"), who), row], async (error) => {
    const left = hoursOf(remaining);
    const spent = hoursOf(completed);
    if (Number.isNaN(left) || Number.isNaN(spent)) {
      error.hidden = false;
      error.textContent = t("工時要是 0 或正數。");
      return false;
    }
    const before = w.assignedTo ? (list.find((m) => m.name === w.assignedTo)?.unique ?? w.assignedTo) : "";
    await desktop!.adoWorkItemUpdate(w.id, {
      ...(who.value !== before ? { assignedTo: who.value } : {}),
      ...(left !== null && left !== w.remaining ? { remaining: left } : {}),
      ...(spent !== null && spent !== w.completed ? { completed: spent } : {}),
      rev: w.rev ?? null,
    });
    toast(t("已更新 {id}", { id: w.id }), { tone: "success" });
    done(w.id);
    return true;
  });
  who.focus();
}

/** 在上層項目底下新增 Task（放進目前的 Sprint）；`parent` 是 null 時沒有上層。 */
export async function addTask(parent: BoardItem | null, s: BoardScope, done: (id: number) => void): Promise<void> {
  if (!desktop) return;
  const list = await members(s);
  const me = app.ado?.account?.name ?? null;
  const title = document.createElement("input");
  title.type = "text";
  title.maxLength = 255;
  const who = assigneeSelect(me, list, null);
  const remaining = hoursInput(null);
  const heading = parent ? t("在 {kind} {id} 底下新增 Task", { kind: parent.kind, id: parent.id }) : t("新增 Task");
  dialog(heading, t("建立"), [field(t("標題（必填）"), title), field(t("指派給"), who), field(t("剩餘工時"), remaining)], async (error) => {
    const name = title.value.trim();
    const left = hoursOf(remaining);
    if (!name || Number.isNaN(left)) {
      error.hidden = false;
      error.textContent = !name ? t("請輸入標題。") : t("工時要是 0 或正數。");
      return false;
    }
    const meUnique = list.find((m) => m.name === me)?.unique ?? null;
    const w = await desktop!.adoWorkItemCreate({
      project: s.project,
      kind: "Task",
      title: name,
      description: null,
      assignToMe: !!me && (who.value === meUnique || who.value === me),
      parent: parent?.id ?? null,
      iteration: s.iterationPath,
      remaining: left,
    });
    // 指派給別人：建立後再改（建立的 API 只有「指派給我」）。
    if (who.value && who.value !== meUnique && who.value !== me) await desktop!.adoWorkItemUpdate(w.id, { assignedTo: who.value });
    toast(t("已建立 Task {id}「{title}」", { id: w.id, title: w.title }), { tone: "success" });
    done(w.id);
    return true;
  });
  title.focus();
}
