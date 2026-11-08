/**
 * 工作項目清單選了好幾個一起改：狀態（選的類型都有的狀態）、指派、優先順序、Sprint（同一個專案才能改）、
 * 一起加一則留言。一個一個送出，最後說改好幾個、哪幾個沒改成。
 */
import { render as renderMarkdown } from "../../pkg/md_wasm.js";
import { adoOnline } from "../ado-online.ts";
import { type AdoWorkItem, type AdoWorkItemChange, desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { toast } from "../ui/toast.ts";
import { iterationGroups } from "../work-item-fields.ts";
import { changeFor, commonStates } from "../work-item-bulk-model.ts";
import { forgetListCopies } from "./offline-copies.ts";
import { issueView } from "./wiki-edit.ts";
import { workItemsPanel } from "./work-items-panel.ts";

/** 「不變」的選項值。 */
const KEEP = "";

function select(options: [string, string][]): HTMLSelectElement {
  const sel = document.createElement("select");
  for (const [value, label] of options) sel.append(new Option(label, value));
  return sel;
}

/** 選了好幾個工作項目之後的「一起改」對話框；改完呼叫 `done`（清掉選取）。 */
export function bulkEditWorkItems(items: AdoWorkItem[], done: () => void): void {
  if (!desktop || !items.length) return;
  if (adoOnline.offline) {
    toast(t("目前離線，連上 Azure DevOps 之後才能修改"), { tone: "error" });
    return;
  }
  const dialog = document.createElement("dialog");
  dialog.className = "choice wi-create wi-bulk";
  const form = document.createElement("form");
  form.method = "dialog";
  const h = document.createElement("h2");
  h.textContent = t("一起修改 {n} 個工作項目", { n: items.length });
  const intro = document.createElement("p");
  intro.textContent = t("只改有選的欄位，其他的保持原樣。");
  const field = (label: string, control: HTMLElement, note?: HTMLElement) => {
    const l = document.createElement("label");
    l.className = "pdf-field";
    l.append(Object.assign(document.createElement("span"), { textContent: label }), control);
    if (note) l.append(note);
    return l;
  };
  const note = () => Object.assign(document.createElement("small"), { className: "wi-bulk-note" });

  const state = select([[KEEP, t("（不變）")]]);
  const stateNote = note();
  state.disabled = true;
  const assign = select([
    [KEEP, t("（不變）")],
    ["me", t("指派給我")],
    ["none", t("取消指派")],
  ]);
  const priority = select([[KEEP, t("（不變）")], ...[1, 2, 3, 4].map((n): [string, string] => [String(n), String(n)])]);
  const sprint = select([[KEEP, t("（不變）")]]);
  const sprintNote = note();
  sprint.disabled = true;
  const comment = document.createElement("textarea");
  comment.rows = 3;
  comment.placeholder = t("每個工作項目都加這則留言（可以不填，可以用 Markdown）");
  const row = document.createElement("div");
  row.className = "wi-create-row";
  row.append(field(t("狀態"), state, stateNote), field(t("指派給"), assign), field(t("優先順序"), priority), field(t("Sprint"), sprint, sprintNote));
  const error = document.createElement("p");
  error.className = "wi-create-error";
  error.hidden = true;
  const actions = document.createElement("div");
  actions.className = "choice-actions";
  const cancel = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: t("取消") });
  cancel.addEventListener("click", () => dialog.close());
  const ok = Object.assign(document.createElement("button"), { type: "submit", className: "btn btn-primary", textContent: t("套用") });
  actions.append(cancel, ok);
  form.append(h, intro, row, field(t("留言"), comment), error, actions);
  dialog.append(form);
  let running = false;
  dialog.addEventListener("cancel", (e) => {
    // 送出中不能關（關了也停不下來）。
    if (running) e.preventDefault();
  });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  state.focus();

  // 狀態：每一組（專案、類型）各讀一次，列出都有的。
  const pairs = [...new Map(items.map((w) => [`${w.project}|${w.kind}`, w])).values()];
  void Promise.all(pairs.map((w) => desktop!.adoWorkItemStates(w.project, w.kind)))
    .then((lists) => {
      const states = commonStates(lists);
      for (const s of states) state.append(new Option(s, s));
      state.disabled = !states.length;
      stateNote.textContent = states.length ? "" : t("選的類型沒有共同的狀態");
    })
    .catch((e) => {
      stateNote.textContent = e instanceof Error ? e.message : String(e);
    });
  // Sprint：都在同一個專案才能改。
  const projects = new Set(items.map((w) => w.project));
  if (projects.size > 1) sprintNote.textContent = t("選的工作項目在不同專案，不能一起改 Sprint");
  else
    void desktop
      .adoIterations(items[0].project)
      .then((list) => {
        for (const g of iterationGroups(list, Date.now())) {
          for (const o of g.items) {
            const name = o.label || o.path;
            sprint.append(new Option(o.current ? t("{name}（目前）", { name }) : name, o.path));
          }
        }
        sprint.disabled = sprint.options.length <= 1;
      })
      .catch((e) => {
        sprintNote.textContent = e instanceof Error ? e.message : String(e);
      });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (running) return;
    const change: AdoWorkItemChange = {};
    if (state.value) change.state = state.value;
    if (assign.value === "me") change.assignToMe = true;
    else if (assign.value === "none") change.assignedTo = "";
    if (priority.value) change.priority = Number(priority.value);
    if (sprint.value) change.iteration = sprint.value;
    const text = comment.value.trim();
    if (text) change.comment = renderMarkdown(text, { kind: "markdown" }).html;
    if (!Object.keys(change).length) {
      error.hidden = false;
      error.textContent = t("沒有選要改什麼。");
      return;
    }
    error.hidden = true;
    running = true;
    ok.disabled = cancel.disabled = true;
    void (async () => {
      const failed: string[] = [];
      let changed = 0;
      for (const [i, w] of items.entries()) {
        ok.textContent = t("修改中… {done}／{total}", { done: i + 1, total: items.length });
        const one = changeFor(w, change);
        if (!one) continue;
        try {
          await desktop!.adoWorkItemUpdate(w.id, one);
          changed++;
        } catch (err) {
          failed.push(t("{id}：{reason}", { id: w.id, reason: err instanceof Error ? err.message : String(err) }));
        }
      }
      running = false;
      dialog.close();
      done();
      forgetListCopies("wi-");
      void workItemsPanel?.refresh();
      void issueView.refresh();
      if (!failed.length) toast(t("已修改 {n} 個工作項目", { n: changed }), { tone: "success" });
      else
        toast(t("改好 {ok} 個，{fail} 個沒改成：{details}", { ok: changed, fail: failed.length, details: failed.join(t("；")) }), {
          tone: "error",
          duration: 15000,
        });
    })();
  });
}
