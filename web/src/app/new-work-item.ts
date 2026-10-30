/**
 * 建立工作項目、格式工具列、剪貼簿操作。
 */
import { render as renderMarkdown } from "../../pkg/md_wasm.js";
import { type AdoWorkItem, desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import type { DocKind } from "../kinds.ts";
import * as storage from "../storage.ts";
import { toast } from "../ui/toast.ts";
import { draftFromSelection } from "../workitem-create.ts";
import { imageFiles, insertImages } from "./image-paste.ts";
import { app } from "./context.ts";


/**
 * 建立工作項目的對話框：專案、類型、標題、內容（Markdown，送出時轉成 HTML）、上層項目、指派給我。
 * 建立成功後呼叫 `created`（例如在文件裡補上連結）。
 */
export function createWorkItemDialog(draft: { title?: string; description?: string } = {}, created?: (w: AdoWorkItem) => void): void {
  if (!desktop || !app.ado?.account) return;
  const dialog = document.createElement("dialog");
  dialog.className = "choice wi-create";
  const form = document.createElement("form");
  form.method = "dialog";
  const h = document.createElement("h2");
  h.textContent = t("建立工作項目");
  const field = (label: string, control: HTMLElement) => {
    const l = document.createElement("label");
    l.className = "pdf-field";
    l.append(Object.assign(document.createElement("span"), { textContent: label }), control);
    return l;
  };
  const project = document.createElement("select");
  const kindSel = document.createElement("select");
  const row = document.createElement("div");
  row.className = "wi-create-row";
  row.append(field(t("專案"), project), field(t("類型"), kindSel));
  const title = document.createElement("input");
  title.type = "text";
  title.value = draft.title ?? "";
  title.maxLength = 255;
  const body = document.createElement("textarea");
  body.rows = 6;
  body.value = draft.description ?? "";
  body.placeholder = t("可以用 Markdown，送出時會轉成格式化的內容");
  const parent = document.createElement("input");
  parent.type = "text";
  parent.inputMode = "numeric";
  parent.placeholder = t("例如 1933599（可以不填）");
  const assign = document.createElement("label");
  assign.className = "pdf-check";
  const assignBox = document.createElement("input");
  assignBox.type = "checkbox";
  assignBox.checked = storage.load("wi-create-assign") !== "0";
  assign.append(assignBox, t("建立後指派給我"));
  const error = document.createElement("p");
  error.className = "wi-create-error";
  error.hidden = true;
  const actions = document.createElement("div");
  actions.className = "choice-actions";
  const cancel = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: t("取消") });
  cancel.addEventListener("click", () => dialog.close());
  const ok = Object.assign(document.createElement("button"), { type: "submit", className: "btn btn-primary", textContent: t("建立") });
  actions.append(cancel, ok);
  form.append(h, row, field(t("標題（必填）"), title), field(t("內容"), body), field(t("上層工作項目編號"), parent), assign, error, actions);
  dialog.append(form);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  title.focus();

  // 專案與類型：記住上次選的；第一次用篩選列選的專案。
  const fill = (sel: HTMLSelectElement, values: string[], preferred: (string | null | undefined)[]) => {
    sel.replaceChildren(...values.map((v) => new Option(v, v)));
    const pick = preferred.find((p) => p && values.includes(p));
    if (pick) sel.value = pick;
  };
  ok.disabled = true;
  void desktop
    .adoWorkItemFilters()
    .then(({ projects, kinds }) => {
      fill(project, projects, [storage.load("wi-create-project"), app.workItemFilter.project]);
      fill(kindSel, kinds, [storage.load("wi-create-kind"), "Task", "User Story"]);
      ok.disabled = false;
    })
    .catch((e) => {
      error.hidden = false;
      error.textContent = e instanceof Error ? e.message : String(e);
    });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = title.value.trim();
    const parentId = parent.value.trim().replace(/^#/, "");
    if (!name) {
      error.hidden = false;
      error.textContent = t("請輸入標題。");
      title.focus();
      return;
    }
    if (parentId && !/^\d+$/.test(parentId)) {
      error.hidden = false;
      error.textContent = t("上層工作項目要填編號（數字）。");
      parent.focus();
      return;
    }
    error.hidden = true;
    ok.disabled = true;
    ok.textContent = t("建立中…");
    const markdown = body.value.trim();
    void desktop!
      .adoWorkItemCreate({
        project: project.value,
        kind: kindSel.value,
        title: name,
        description: markdown ? renderMarkdown(markdown, { kind: "markdown" }).html : null,
        assignToMe: assignBox.checked,
        parent: parentId ? Number(parentId) : null,
      })
      .then((w) => {
        storage.save("wi-create-project", project.value);
        storage.save("wi-create-kind", kindSel.value);
        storage.save("wi-create-assign", assignBox.checked ? "1" : "0");
        dialog.close();
        void app.workItemsPanel?.refresh();
        created?.(w);
        toast(t("已建立 {kind} {id}「{title}」", { kind: w.kind, id: w.id, title: w.title }), {
          tone: "success",
          duration: 8000,
          action: { label: t("開啟"), run: () => app.showWorkItem(w) },
        });
      })
      .catch((err) => {
        ok.disabled = false;
        ok.textContent = t("建立");
        error.hidden = false;
        error.textContent = err instanceof Error ? err.message : String(err);
      });
  });
}

/** 用選取的文字建立工作項目，建立後在那一行後面補上 `[#編號](網址)`。 */
export function createWorkItemFromSelection(): void {
  const view = app.editor.view;
  const sel = view.state.selection.main;
  if (sel.empty) {
    createWorkItemDialog();
    return;
  }
  const doc = app.active;
  const text = view.state.sliceDoc(sel.from, sel.to);
  const draft = draftFromSelection(text);
  // 標題那一行（選取範圍裡第一個有字的行）。
  const offset = text.search(/\S/);
  const lineText = view.state.doc.lineAt(sel.from + Math.max(offset, 0)).text;
  createWorkItemDialog(draft, (w) => {
    if (app.active !== doc) return;
    const state = app.editor.view.state;
    // 文件在這段時間改過：找回那一行；找不到就放在游標處。
    let line = null as ReturnType<typeof state.doc.line> | null;
    for (let i = 1; i <= state.doc.lines; i++) {
      if (state.doc.line(i).text === lineText) {
        line = state.doc.line(i);
        break;
      }
    }
    const link = ` [#${w.id}](${w.webUrl})`;
    const at = line ? line.to : state.selection.main.head;
    app.editor.view.dispatch({ changes: { from: at, insert: link }, userEvent: "input" });
  });
}

/** 選取範圍的文字（多重選取用換行連接）。 */
export function selectedText(): string {
  const state = app.editor.view.state;
  return state.selection.ranges
    .filter((r) => !r.empty)
    .map((r) => state.sliceDoc(r.from, r.to))
    .join("\n");
}

export async function copySelection(cut: boolean): Promise<void> {
  const text = selectedText();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast(t("無法寫入剪貼簿，請按 Ctrl+{key}。", { key: cut ? "X" : "C" }));
    return;
  }
  if (cut) app.editor.view.dispatch(app.editor.view.state.replaceSelection(""), { userEvent: "delete.cut" });
  app.editor.view.focus();
}

/**
 * 從選單貼上：讀取剪貼簿後當成一般的貼上事件交給編輯器，所以智慧貼上（HTML 轉 Markdown）照樣有效。
 * 瀏覽器不允許讀取剪貼簿時，請使用者改按 Ctrl+V。
 */
export async function pasteFromClipboard(plain: boolean): Promise<void> {
  const data = new DataTransfer();
  try {
    if (!plain && navigator.clipboard.read) {
      for (const item of await navigator.clipboard.read()) {
        for (const type of item.types) {
          if (type === "text/plain" || type === "text/html") data.setData(type, await (await item.getType(type)).text());
        }
      }
    }
    if (!data.getData("text/plain")) data.setData("text/plain", await navigator.clipboard.readText());
  } catch {
    toast(t("無法從選單讀取剪貼簿，請按 {keys} 貼上。", { keys: plain ? "Ctrl+Shift+V" : "Ctrl+V" }));
    return;
  }
  if (plain) app.plainPasteUntil = Date.now() + 1000;
  app.editor.view.focus();
  app.editor.view.contentDOM.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}

export const imageInput = Object.assign(document.createElement("input"), { type: "file", accept: "image/*", multiple: true, hidden: true });

/**
 * 格式工具列依文件類型切換：Markdown 顯示常用格式（標題與插入收在下拉選單裡），
 * JSON 顯示格式化，純文字不顯示。可以在設定或指令面板中整個隱藏。
 */
export function buildFormatBar(): void {
  const groups: (string | HTMLElement)[][] =
    app.kind === "markdown"
      ? [[app.headingMenu], ["bold", "italic", "strike", "code", "link"], ["bullet", "ordered", "task", "quote"], [app.insertMenu]]
      : app.kind === "json"
        ? [["format-json"]]
        : [];
  // Markdown 的固定工具列預設不顯示（選取時才浮出）；JSON 的「格式化」只有一個按鈕，一直顯示。
  app.formatBar.hidden = groups.length === 0 || (app.kind === "markdown" && !app.settings.value.fixedToolbar);
  app.formatBar.replaceChildren(
    ...groups.flatMap((items, gi) => {
      const buttons = items.map((item) => (typeof item === "string" ? app.commandButton(item, app.kind === "json") : item));
      return gi === 0 ? buttons : [app.separator("format-sep"), ...buttons];
    }),
  );
}

export function initNewWorkItem(): void {
  document.body.append(imageInput);
  imageInput.addEventListener("change", () => {
    const files = imageFiles(imageInput.files);
    imageInput.value = "";
    if (files.length) void insertImages(files).catch(app.reportError);
  });
  // 工具列的方向鍵導覽（WAI-ARIA toolbar 模式）。
  app.formatBar.addEventListener("keydown", (e) => {
    const items = [...app.formatBar.querySelectorAll<HTMLElement>("button")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowRight") items[(i + 1) % items.length]?.focus();
    else if (e.key === "ArrowLeft") items[(i - 1 + items.length) % items.length]?.focus();
    else return;
    e.preventDefault();
  });
  app.kindSelect.addEventListener("change", () => app.setKind(app.kindSelect.value as DocKind));
}
