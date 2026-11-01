/**
 * 工作項目內容上方的欄位直接改：在哪裡看到就在哪裡改。
 * 狀態、指派、優先順序、Sprint 的小標籤點一下出現選單；標題旁的鉛筆改標題；標籤可以新增、移除；
 * 留言框在留言段落的最上面。
 */
import { render as renderMarkdown } from "../../pkg/md_wasm.js";
import type { AdoWorkItemChange, AdoWorkItemDetail } from "../desktop.ts";
import { t } from "../i18n.ts";
import { type MenuEntry, setupMenu } from "../ui/menu.ts";
import { icon } from "../ui/icons.ts";
import { shortcutHue, shortcutInitial } from "../wiki-shortcuts.ts";
import { htmlToMarkdown } from "../html-paste.ts";
import { type Iteration, type LongField, iterationGroups, longFields, lossyHtml, parseTags } from "../work-item-fields.ts";

export interface WorkItemEditHooks {
  /** 讀到的最新內容（還沒讀到是 null，這時不能改）。 */
  detail(): AdoWorkItemDetail | null;
  /** 送出變更；成功時回傳 true（之後會重新讀取、重畫）。 */
  apply(change: AdoWorkItemChange, done: string): Promise<boolean>;
  /** 這個類型可以設定的狀態。 */
  states(): Promise<string[]>;
  /** 專案的 Sprint。 */
  iterations(): Promise<Iteration[]>;
  /** 登入的帳號名稱（指派給我、留言框的頭像用）。 */
  me(): string;
  /** 工作項目的編號與類型（還沒讀到內容也知道）。 */
  id: number;
  kind: string;
}

/** 已經讀到的清單（選單打開時直接用；還沒讀到時先顯示「讀取中…」）。 */
interface Loaded<T> {
  value: T | null;
  load(): Promise<T>;
}

function lazy<T>(get: () => Promise<T>): Loaded<T> {
  let pending: Promise<T> | null = null;
  const box: Loaded<T> = {
    value: null,
    load() {
      pending ??= get().then(
        (v) => (box.value = v),
        (e: unknown) => {
          pending = null;
          throw e;
        },
      );
      return pending;
    },
  };
  return box;
}

/** 過去的 Sprint 最多直接列幾個（其他的收在「更早的 Sprint」子選單）。 */
const RECENT_PAST = 8;

/** 小標籤換成按鈕（內容不變），點一下打開選單；選單的項目在打開時才依目前的值產生。 */
function chipMenu(chip: HTMLElement, id: string, label: string, entries: () => MenuEntry[], prefetch?: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.id = id;
  button.className = `${chip.className} ado-fact-edit`;
  button.dataset.field = chip.dataset.field ?? "";
  button.title = t("{label}：按一下修改", { label: chip.title.split("\n")[0] });
  button.setAttribute("aria-label", t("修改{label}", { label }));
  button.append(...chip.childNodes, icon("chevron-down"));
  chip.replaceWith(button);
  // 重畫時舊的選單還在：先拿掉。
  document.getElementById(`${id}-popover`)?.remove();
  const list: MenuEntry[] = [];
  const menu = setupMenu(button, null, list);
  // 點的時候（打開選單之前）產生項目。
  button.addEventListener("click", () => list.splice(0, list.length, ...entries()));
  if (prefetch) {
    button.addEventListener("pointerenter", prefetch, { once: true });
    button.addEventListener("focus", prefetch, { once: true });
  }
  // 讀取中的清單讀到之後，選單開著就重新打開一次（換成完整的項目）。
  button.addEventListener("ado-refresh-menu", () => {
    if (!menu.matches(":popover-open")) return;
    list.splice(0, list.length, ...entries());
    menu.hidePopover();
    menu.showPopover();
  });
  return button;
}

/** 讀到之後通知選單重新產生項目。 */
function refreshWhenLoaded<T>(data: Loaded<T>, button: () => HTMLElement | null): () => void {
  return () => {
    if (data.value) return;
    void data
      .load()
      .then(() => button()?.dispatchEvent(new Event("ado-refresh-menu")))
      .catch(() => {});
  };
}

const loading = (): MenuEntry => ({ label: t("讀取中…"), icon: "loader", run: () => {} });

/** 在工作項目的內容（已經整理成標題、小標籤、卡片）上加上修改的方式。重畫之後要再呼叫一次。 */
export function enhanceWorkItem(body: HTMLElement, h: WorkItemEditHooks, cache: { states: Loaded<string[]>; iterations: Loaded<Iteration[]> }): void {
  const hero = body.querySelector<HTMLElement>(":scope > .ado-hero");
  if (!hero || hero.dataset.editable) return;
  hero.dataset.editable = "1";
  const d = () => h.detail();
  const facts = hero.querySelector<HTMLElement>(".ado-facts");

  // 狀態
  const stateChip = hero.querySelector<HTMLElement>('.ado-fact[data-field="state"]');
  if (stateChip) {
    const states = cache.states;
    chipMenu(
      stateChip,
      "wi-edit-state",
      t("狀態"),
      () => {
        const current = d()?.state ?? "";
        const list = states.value ?? [current];
        return [
          ...list.map((s) => ({
            label: s,
            checked: () => s === current,
            run: () => {
              if (s !== current) void h.apply({ state: s }, t("已把狀態改成「{state}」", { state: s }));
            },
          })),
          ...(states.value ? [] : [loading()]),
        ];
      },
      refreshWhenLoaded(states, () => document.getElementById("wi-edit-state")),
    );
  }

  // 指派：還沒指派給自己時可以「改成指派給我」。
  let assigneeChip = hero.querySelector<HTMLElement>('.ado-fact[data-field="assignee"]');
  if (!assigneeChip && facts) {
    // 還沒指派：放一個「未指派」的標籤，一樣可以點。
    assigneeChip = document.createElement("span");
    assigneeChip.className = "ado-fact ado-fact-muted";
    assigneeChip.dataset.field = "assignee";
    assigneeChip.title = t("指派給");
    assigneeChip.append(icon("user"), t("未指派"));
    const state = hero.querySelector('.ado-fact[data-field="state"]');
    if (state) state.after(assigneeChip);
    else facts.prepend(assigneeChip);
  }
  const mine = () => (d()?.assignedTo ?? "") === h.me();
  if (assigneeChip && h.me() && !mine()) {
    chipMenu(assigneeChip, "wi-edit-assignee", t("指派給"), () => [
      { label: t("改成指派給我"), icon: "user-check", run: () => void h.apply({ assignToMe: true }, t("已指派給你")) },
    ]);
  }

  // 優先順序（流程範本沒有這個欄位時不顯示）
  const priorityChip = hero.querySelector<HTMLElement>('.ado-fact[data-field="priority"]');
  if (priorityChip) {
    chipMenu(priorityChip, "wi-edit-priority", t("優先順序"), () =>
      [1, 2, 3, 4].map((n) => ({
        label: `P${n}`,
        checked: () => d()?.priority === n,
        run: () => {
          if (d()?.priority !== n) void h.apply({ priority: n }, t("已把優先順序改成 P{n}", { n }));
        },
      })),
    );
  }

  // Sprint：沒有設定時放一個「沒有 Sprint」的標籤。
  let sprintChip = hero.querySelector<HTMLElement>('.ado-fact[data-field="iteration"]');
  if (!sprintChip && facts) {
    sprintChip = document.createElement("span");
    sprintChip.className = "ado-fact ado-fact-muted";
    sprintChip.dataset.field = "iteration";
    sprintChip.title = t("反覆項目");
    sprintChip.append(icon("calendar"), t("沒有 Sprint"));
    const changed = facts.querySelector(".ado-fact.ado-fact-muted:last-child");
    if (changed) changed.before(sprintChip);
    else facts.append(sprintChip);
  }
  if (sprintChip) {
    const its = cache.iterations;
    chipMenu(
      sprintChip,
      "wi-edit-iteration",
      "Sprint",
      () => {
        const list = its.value;
        if (!list) return [loading()];
        const current = d()?.iteration ?? "";
        const entry = (o: { path: string; label: string; current: boolean }): MenuEntry => {
          const name = o.label || t("（不放在任何 Sprint）");
          return {
            label: o.current ? t("{name}（目前）", { name }) : name,
            checked: () => o.path === current,
            run: () => {
              if (o.path !== current) void h.apply({ iteration: o.path }, t("已移到「{name}」", { name }));
            },
          };
        };
        const out: MenuEntry[] = [];
        for (const g of iterationGroups(list, Date.now())) {
          if (out.length) out.push("-");
          if (g.kind === "past" && g.items.length > RECENT_PAST) {
            out.push(...g.items.slice(0, RECENT_PAST).map(entry));
            out.push({ label: t("更早的 Sprint"), icon: "history", items: g.items.slice(RECENT_PAST).map(entry) });
          } else out.push(...g.items.map(entry));
        }
        return out;
      },
      refreshWhenLoaded(its, () => document.getElementById("wi-edit-iteration")),
    );
  }

  editableTitle(hero, h);
  editableTags(hero, h);
  editableLongFields(body, h);
  composeComment(body, h);
}

/** 長文字段落沒有存的修改（切換分頁、重新讀取時內容會重畫，回來時接著改）：`編號:欄位` → Markdown。 */
const drafts = new Map<string, string>();

/** 說明、驗收條件、重現步驟：段落標題列有「編輯」，在卡片裡用 Markdown 改，存回時轉成 HTML。 */
function editableLongFields(body: HTMLElement, h: WorkItemEditHooks): void {
  const has = (kind: string) => !!body.querySelector(`.ado-sec[data-kind="${kind}"] > .ado-sec-body > *`);
  for (const f of longFields(h.kind, { desc: has("desc"), details: has("details") }).editable) {
    const sec = body.querySelector<HTMLDetailsElement>(`.ado-sec[data-kind="${f.section}"]`);
    if (sec) editableSection(sec, f, h);
  }
}

function editableSection(sec: HTMLDetailsElement, f: LongField, h: WorkItemEditHooks): void {
  const head = sec.querySelector<HTMLElement>(":scope > .ado-sec-head");
  const box = sec.querySelector<HTMLElement>(":scope > .ado-sec-body");
  if (!head || !box) return;
  const name = head.querySelector("h2")?.textContent?.trim() ?? "";
  const key = `${h.id}:${f.field}`;
  if (!box.childElementCount) {
    const empty = document.createElement("p");
    empty.className = "ado-sec-empty";
    empty.textContent = t("還沒有內容，按「編輯」新增。");
    box.append(empty);
  }
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "ado-sec-edit";
  edit.title = t("編輯「{name}」", { name });
  edit.append(icon("pencil"), t("編輯"));
  head.append(edit);
  /** 欄位目前的內容（HTML）。 */
  const original = () => {
    const d = h.detail();
    return (f.section === "desc" ? d?.description : d?.details) ?? "";
  };
  const start = (draft?: string, tries = 0) => {
    if (box.querySelector(".ado-edit")) return;
    // 還沒讀到內容（剛打開時先顯示上次的內容）：等一下再試。
    if (!h.detail()) {
      if (draft !== undefined && tries < 20) setTimeout(() => start(draft, tries + 1), 300);
      return;
    }
    sec.open = true;
    const html = original();
    const markdown = html ? htmlToMarkdown(html, { keepImages: true }) : "";
    const old = [...box.childNodes];
    const editor = document.createElement("div");
    editor.className = "ado-edit";
    if (lossyHtml(html)) {
      const note = document.createElement("p");
      note.className = "ado-edit-note";
      note.append(icon("circle-alert"), t("這段有文字顏色、字型或合併儲存格，存回後會變成一般格式。"));
      editor.append(note);
    }
    if (draft !== undefined) {
      const note = document.createElement("p");
      note.className = "ado-edit-note";
      note.append(icon("history"), t("接著改上次還沒儲存的內容。"));
      editor.append(note);
    }
    const textarea = document.createElement("textarea");
    textarea.className = "ado-edit-text";
    textarea.value = draft ?? markdown;
    textarea.setAttribute("aria-label", name);
    textarea.rows = Math.min(24, Math.max(6, textarea.value.split("\n").length + 2));
    const actions = document.createElement("div");
    actions.className = "ado-compose-actions";
    const hint = document.createElement("span");
    hint.className = "ado-compose-hint";
    hint.textContent = t("可以用 Markdown；Ctrl+Enter 儲存，Esc 取消");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-small";
    cancel.textContent = t("取消");
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn btn-small btn-primary";
    save.textContent = t("儲存");
    actions.append(hint, cancel, save);
    editor.append(textarea, actions);
    box.replaceChildren(editor);
    edit.hidden = true;
    textarea.focus();
    textarea.addEventListener("input", () => drafts.set(key, textarea.value));
    const close = () => {
      drafts.delete(key);
      box.replaceChildren(...old);
      edit.hidden = false;
    };
    const submit = async () => {
      const text = textarea.value.trim();
      // 沒有改：直接收起來（不要把原本的 HTML 換成轉換過的版本）。
      if (text === markdown.trim()) return close();
      save.disabled = true;
      const value = text ? renderMarkdown(text, { kind: "markdown" }).html : "";
      // 存成功後內容會重畫：先拿掉暫存，免得重畫時又打開編輯；沒存成功（編輯框還在）再放回去。
      drafts.delete(key);
      if (!(await h.apply({ [f.field]: value }, t("已更新「{name}」", { name })))) {
        drafts.set(key, textarea.value);
        save.disabled = false;
      }
    };
    cancel.addEventListener("click", close);
    save.addEventListener("click", () => void submit());
    textarea.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void submit();
      } else if (e.key === "Escape") {
        // 只取消修改，不要關掉整個檢視。
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    });
  };
  edit.addEventListener("click", (e) => {
    // 按鈕在 <summary> 裡：不要順便收合段落。
    e.preventDefault();
    e.stopPropagation();
    start();
  });
  // 重畫之前正在改：接著改。
  const draft = drafts.get(key);
  if (draft !== undefined) queueMicrotask(() => start(draft));
}

/** 標題：滑鼠移上去出現鉛筆，點鉛筆（或雙擊標題）改成輸入框；Enter 或離開輸入框就存，Esc 取消。 */
function editableTitle(hero: HTMLElement, h: WorkItemEditHooks): void {
  const h1 = hero.querySelector<HTMLElement>('[data-field="title"]');
  if (!h1) return;
  const pencil = document.createElement("button");
  pencil.type = "button";
  pencil.className = "ado-title-edit";
  pencil.title = t("修改標題");
  pencil.setAttribute("aria-label", t("修改標題"));
  pencil.append(icon("pencil"));
  h1.append(pencil);
  const start = () => {
    const d = h.detail();
    if (!d || h1.querySelector("input")) return;
    const input = document.createElement("input");
    input.className = "ado-title-input";
    input.value = d.title;
    input.maxLength = 255;
    input.setAttribute("aria-label", t("標題"));
    const old = [...h1.childNodes];
    h1.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      if (save && title && title !== d.title && (await h.apply({ title }, t("已更新標題")))) return;
      h1.replaceChildren(...old);
    };
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        void finish(true);
      } else if (e.key === "Escape") {
        // 只取消修改，不要關掉整個檢視。
        e.preventDefault();
        e.stopPropagation();
        void finish(false);
      }
    });
    input.addEventListener("blur", () => void finish(true));
  };
  pencil.addEventListener("click", start);
  h1.addEventListener("dblclick", (e) => {
    if (e.target !== pencil) start();
  });
}

/** 標籤：每個標籤滑鼠移上去有 ×；最後面的「＋ 標籤」輸入新的（逗號隔開可以一次加好幾個）。 */
function editableTags(hero: HTMLElement, h: WorkItemEditHooks): void {
  let meta = hero.querySelector<HTMLElement>(".ado-hero-meta");
  if (!meta) {
    meta = document.createElement("div");
    meta.className = "ado-hero-meta";
    hero.append(meta);
  }
  const save = (tags: string[], done: string) => void h.apply({ tags }, done);
  for (const chip of meta.querySelectorAll<HTMLElement>(".ado-field-tag[data-tag]")) {
    const tag = chip.dataset.tag!;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ado-tag-remove";
    remove.title = t("移除標籤「{tag}」", { tag });
    remove.setAttribute("aria-label", remove.title);
    remove.append(icon("x"));
    remove.addEventListener("click", () => {
      const d = h.detail();
      if (d) save(d.tags.filter((x) => x.toLowerCase() !== tag.toLowerCase()), t("已移除標籤「{tag}」", { tag }));
    });
    chip.append(remove);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "ado-tag-add";
  add.append(icon("plus"), t("標籤"));
  add.title = t("新增標籤（逗號隔開可以一次加好幾個）");
  add.addEventListener("click", () => {
    const input = document.createElement("input");
    input.className = "ado-tag-input";
    input.placeholder = t("新標籤");
    input.setAttribute("aria-label", t("新增標籤"));
    add.replaceWith(input);
    input.focus();
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const d = h.detail();
      const extra = parseTags(input.value);
      const known = new Set(d?.tags.map((x) => x.toLowerCase()));
      const fresh = extra.filter((x) => !known.has(x.toLowerCase()));
      if (commit && d && fresh.length) save([...d.tags, ...fresh], t("已新增標籤"));
      else input.replaceWith(add);
    };
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  });
  meta.append(add);
}

/** 留言框：放在留言段落的最上面。平常是一行，點一下展開；可以用 Markdown，Ctrl+Enter 送出。 */
function composeComment(body: HTMLElement, h: WorkItemEditHooks): void {
  const box = body.querySelector<HTMLElement>('.ado-sec[data-kind="comments"] > .ado-sec-body');
  if (!box) return;
  const wrap = document.createElement("div");
  wrap.className = "ado-compose";
  const avatar = document.createElement("span");
  avatar.className = "ado-avatar";
  const me = h.me();
  avatar.textContent = me ? shortcutInitial(me) : "?";
  avatar.style.setProperty("--hue", String(shortcutHue(me)));
  avatar.setAttribute("aria-hidden", "true");
  const main = document.createElement("div");
  main.className = "ado-compose-main";
  const textarea = document.createElement("textarea");
  textarea.rows = 1;
  textarea.placeholder = t("寫留言…（可以用 Markdown）");
  textarea.setAttribute("aria-label", t("留言"));
  const actions = document.createElement("div");
  actions.className = "ado-compose-actions";
  const hint = document.createElement("span");
  hint.className = "ado-compose-hint";
  hint.textContent = t("Ctrl+Enter 送出");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn-small";
  cancel.textContent = t("取消");
  const send = document.createElement("button");
  send.type = "button";
  send.className = "btn btn-small btn-primary";
  send.textContent = t("送出留言");
  actions.append(hint, cancel, send);
  main.append(textarea, actions);
  wrap.append(avatar, main);
  box.prepend(wrap);
  const open = (on: boolean) => wrap.classList.toggle("open", on);
  textarea.addEventListener("focus", () => open(true));
  cancel.addEventListener("click", () => {
    textarea.value = "";
    open(false);
  });
  textarea.addEventListener("blur", () => {
    // 沒有寫東西就收回一行（按「送出」時焦點會先離開，等一下再判斷）。
    setTimeout(() => {
      if (!textarea.value.trim() && !wrap.contains(document.activeElement)) open(false);
    }, 150);
  });
  const submit = async () => {
    const text = textarea.value.trim();
    if (!text) return textarea.focus();
    send.disabled = true;
    const html = renderMarkdown(text, { kind: "markdown" }).html;
    if (await h.apply({ comment: html }, t("已新增留言"))) {
      textarea.value = "";
      open(false);
    }
    send.disabled = false;
  };
  send.addEventListener("click", () => void submit());
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      textarea.blur();
      if (!textarea.value.trim()) open(false);
    }
  });
}

export { lazy, type Loaded };
